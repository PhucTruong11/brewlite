import { Injectable, NotFoundException, BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { PromotionsService } from '../promotions/promotions.service.js';
import { RewardsService } from '../rewards/rewards.service.js';
import { InventoryService, RESERVATION_DURATION_MS } from '../inventory/inventory.service.js';

@Injectable()
export class OrdersService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly promotionsService: PromotionsService,
        private readonly rewardsService: RewardsService,
        private readonly inventory: InventoryService,
    ) { }

    async create(dto: CreateOrderDto, userId: string) {
        if (!userId) {
            throw new UnauthorizedException('Vui lòng đăng nhập để đặt hàng');
        }
        if (!dto.items || dto.items.length === 0) {
            throw new BadRequestException('Giỏ hàng không được rỗng');
        }

        const order = await this.prisma.$transaction(async (tx) => {
            // Một khách chỉ có một đơn thường đang giữ nguyên liệu; bấm lại sẽ dùng đúng đơn đó.
            await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${'checkout:' + userId}))) AS checkout_lock`;
            const pending = await tx.order.findFirst({
                where: {
                    userId, compensationSourceId: null, inventoryState: 'RESERVED',
                    status: { in: ['PENDING', 'PAYMENT_FAILED'] },
                    reservationExpiresAt: { gt: new Date() },
                },
                orderBy: { createdAt: 'desc' }, include: { items: true },
            });
            if (pending) {
                const signature = (items: { productId: string | null; size: string; qty: number; toppings?: string[] }[], promo?: string | null) =>
                    JSON.stringify([items.map(item => JSON.stringify([item.productId, item.size, item.qty, [...(item.toppings ?? [])].sort()])).sort(), promo || null]);
                if (signature(pending.items, pending.promoCode) !== signature(dto.items, dto.promoCode)) {
                    throw new ConflictException('Bạn có đơn đang chờ thanh toán. Vui lòng tiếp tục hoặc hủy đơn chờ trước khi đổi giỏ hàng.');
                }
                return pending;
            }
            const preview = await this.inventory.prepareCart(dto.items, tx);
            if (preview.shortages.length) {
                throw new BadRequestException(`Không đủ nguyên liệu: ${preview.shortages.map((entry) => entry.ingredientName).join(', ')}`);
            }
            const calculatedTotal = preview.subtotal;

            let finalTotal = calculatedTotal;
            let finalDiscount = 0;

            if (dto.promoCode) {
                const code = dto.promoCode.trim().toUpperCase();
                await tx.$queryRaw`
                    SELECT "id" FROM "promotions" WHERE "code" = ${code} FOR UPDATE
                `;
                await this.rewardsService.assertVoucherUsable(userId, code, tx);
                const promoResult = await this.promotionsService.applyPromotion({
                    code,
                    subtotal: calculatedTotal
                }, tx);

                finalDiscount = promoResult.discountAmount;
                finalTotal -= finalDiscount;
            }
            const cart = await this.inventory.prepareCart(dto.items, tx);
            if (cart.subtotal !== calculatedTotal) {
                throw new BadRequestException('Giá món vừa thay đổi, vui lòng kiểm tra lại giỏ hàng');
            }
            await this.inventory.reserve(tx, cart);
            const newOrder = await tx.order.create({
                data: {
                    userId,
                    total: finalTotal,
                    discount: finalDiscount,
                    status: 'PENDING',
                    inventoryState: 'RESERVED',
                    reservationExpiresAt: new Date(Date.now() + RESERVATION_DURATION_MS),
                    promoCode: dto.promoCode ?? null,
                    notifications: { create: { status: 'PENDING' } },
                    items: {
                        create: cart.orderItems,
                    },
                },
                include: {
                    items: {
                        include: { product: { select: { name: true, imageUrl: true } } },
                    },
                },
            });
            return newOrder;
        });

        return order;
    }

    async findPendingCheckout(userId: string) {
        if (!userId) throw new UnauthorizedException('Vui lòng đăng nhập');
        return this.prisma.order.findFirst({
            where: {
                userId, compensationSourceId: null, inventoryState: 'RESERVED',
                status: { in: ['PENDING', 'PAYMENT_FAILED'] },
                reservationExpiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: 'desc' }, include: { items: true },
        });
    }

    async findAllByUser(userId: string) {
        if (!userId) {
            throw new UnauthorizedException('Vui lòng đăng nhập để xem đơn hàng');
        }

        const orders = await this.prisma.order.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            include: {
                items: {
                    include: { product: { select: { name: true, imageUrl: true } } },
                },
            },
        });
        return orders.map((order) => ({
            ...order,
            items: order.items.map((item) => ({
                ...item,
                product: item.product ?? { name: item.productName, imageUrl: item.productImageUrl },
            })),
        }));
    }

    async findOne(id: string, userId: string) {
        if (!userId) {
            throw new UnauthorizedException('Vui lòng đăng nhập để xem đơn hàng');
        }
        const order = await this.prisma.order.findUnique({
            where: { id, userId },
            include: {
                items: {
                    include: { product: { select: { name: true, imageUrl: true } } },
                },
                payments: true,
                compensationIssued: {
                    select: {
                        amount: true,
                        replacements: {
                            select: { id: true, status: true },
                            where: { status: { in: ['PAID', 'PREPARING', 'READY', 'COMPLETED'] } },
                        },
                    },
                },
                compensationSource: { select: { amount: true } },
            },
        });

        if (!order) {
            throw new NotFoundException(`Không tìm thấy đơn hàng #${id}`);
        }

        return {
            ...order,
            items: order.items.map((item) => ({
                ...item,
                product: item.product ?? { name: item.productName, imageUrl: item.productImageUrl },
            })),
        };
    }

    async getNotifications(userId: string) {
        const where = { order: { userId } };
        const [items, unreadCount] = await this.prisma.$transaction([
            this.prisma.orderNotification.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: 30,
                include: {
                    order: {
                        select: {
                            compensationSourceId: true,
                            compensationIssued: {
                                select: {
                                    amount: true,
                                    replacements: {
                                        select: { id: true, status: true },
                                        where: { status: { in: ['PAID', 'PREPARING', 'READY', 'COMPLETED'] } },
                                    },
                                },
                            },
                        },
                    },
                },
            }),
            this.prisma.orderNotification.count({ where: { ...where, readAt: null } }),
        ]);
        return { items, unreadCount };
    }

    async readNotification(id: string | undefined, userId: string) {
        await this.prisma.orderNotification.updateMany({
            where: { id, order: { userId }, readAt: null },
            data: { readAt: new Date() },
        });
    }
}
