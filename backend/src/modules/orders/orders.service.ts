import { Injectable, NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
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

        const preview = await this.inventory.prepareCart(dto.items);
        if (preview.shortages.length) {
            throw new BadRequestException(`Không đủ nguyên liệu: ${preview.shortages.map((entry) => entry.ingredientName).join(', ')}`);
        }
        const calculatedTotal = preview.subtotal;

        let finalTotal = calculatedTotal;
        let finalDiscount = 0;

        if (dto.promoCode) {
            await this.rewardsService.assertVoucherUsable(userId, dto.promoCode);
            const promoResult = await this.promotionsService.applyPromotion({
                code: dto.promoCode,
                subtotal: calculatedTotal
            });

            finalDiscount = promoResult.discountAmount;
            finalTotal -= finalDiscount;
        }

        const order = await this.prisma.$transaction(async (tx) => {
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
}
