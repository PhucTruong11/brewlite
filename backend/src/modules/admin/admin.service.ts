import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { IngredientUnit, OrderStatus, PointTransactionType, Prisma, ProductSize, } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertTransition } from '../orders/orders-state.js';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto.js';
import { UpdateStockDto } from './dto/update-stock.dto.js';
import { CreatePromotionDto } from './dto/create-promotion.dto.js'
import { InventoryService } from '../inventory/inventory.service.js';
import { CreateIngredientDto, UpdateIngredientDto, RestockIngredientDto, } from './dto/ingredient.dto.js';
import { SaveRecipeDto } from './dto/save-recipe.dto.js';

// Các trạng thái đã thanh toán thành công (tính vào doanh thu)
const REVENUE_STATUSES: OrderStatus[] = ['PAID', 'PREPARING', 'READY', 'COMPLETED'];
// Admin chỉ thấy đơn đã thanh toán; đơn hủy chỉ hiện nếu trước đó thanh toán thành công.
const ADMIN_VISIBLE_ORDERS: Prisma.OrderWhereInput = {
    OR: [
        { status: { in: REVENUE_STATUSES } },
        { status: OrderStatus.CANCELLED, payments: { some: { status: 'SUCCESS' } } },
    ],
};
const ADMIN_FORBIDDEN_TARGETS: OrderStatus[] = [
    OrderStatus.PAID, OrderStatus.PAYMENT_FAILED, OrderStatus.PENDING,
];

// 00:00 hôm nay theo giờ của server
function startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

// Bao bì nhận diện theo mã: ly các size và ống hút.
function isPackagingCode(code: string): boolean {
    return code.startsWith('CUP_') || code === 'STRAW';
}


@Injectable()
export class AdminService {
    constructor(private readonly prisma: PrismaService, private readonly inventory: InventoryService) { }

    // Danh sách đơn: lọc trạng thái / ngày / tìm kiếm + phân trang
    async listOrders(q: ListOrdersQueryDto) {
        const page = q.page ?? 1;
        const limit = q.limit ?? 20;

        const where: Prisma.OrderWhereInput = { AND: [ADMIN_VISIBLE_ORDERS] };

        if (q.status?.length) where.status = { in: q.status };

        // Lọc theo ngày
        if (q.range === 'today') {
            where.createdAt = { gte: startOfToday() };
        } else if (q.range === '7d') {
            const from = startOfToday();
            from.setDate(from.getDate() - 6); // hôm nay + 6 ngày trước
            where.createdAt = { gte: from };
        }

        // Tìm theo mã đơn (đầu uuid) hoặc email khách
        const keyword = q.search?.trim();
        if (keyword) {
            where.OR = [
                { id: { startsWith: keyword.toLowerCase() } },
                { user: { email: { contains: keyword, mode: 'insensitive' } } },
            ];
        }

        // $transaction chạy đồng thời: lấy dữ liệu trang + tổng số đơn
        const [items, total] = await this.prisma.$transaction([
            this.prisma.order.findMany({
                where,
                orderBy: { createdAt: q.sort ?? 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                include: {
                    user: { select: { email: true } },
                    items: { include: { product: { select: { name: true } } } },
                },
            }),
            this.prisma.order.count({ where }),
        ]);

        return {
            items: items.map((order) => ({
                ...order,
                items: order.items.map((item) => ({
                    ...item,
                    product: item.product ?? { name: item.productName },
                })),
            })),
            total, page, limit,
        };
    }

    // Số đơn theo từng trạng thái + doanh thu hôm nay (cho tab và trang Tổng quan)
    async getCounts() {
        const grouped = await this.prisma.order.groupBy({
            by: ['status'],
            where: ADMIN_VISIBLE_ORDERS,
            _count: { _all: true },
        });

        // Trạng thái nào chưa có đơn thì mặc định 0
        const counts = Object.fromEntries(
            Object.values(OrderStatus).map((s) => [s, 0]),
        ) as Record<OrderStatus, number>;
        for (const g of grouped) counts[g.status] = g._count._all;

        const today = startOfToday();
        const todayOrders = await this.prisma.order.count({
            where: { createdAt: { gte: today }, status: { in: REVENUE_STATUSES } },
        });
        const revenue = await this.prisma.order.aggregate({
            _sum: { total: true },
            where: { createdAt: { gte: today }, status: { in: REVENUE_STATUSES } },
        });

        return { counts, todayOrders, todayRevenue: revenue._sum.total ?? 0 };
    }

    // Đổi trạng thái đơn và xử lý kho trong cùng giao dịch.
    async updateStatus(id: string, next: OrderStatus) {
        if (ADMIN_FORBIDDEN_TARGETS.includes(next)) {
            throw new BadRequestException(`Admin không được chuyển đơn sang ${next}`);
        }

        return this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${id} FOR UPDATE`;
            const order = await tx.order.findUnique({
                where: { id },
                include: { items: true },
            });
            if (!order) throw new NotFoundException(`Không tìm thấy đơn ${id}`);

            assertTransition(order.status, next);

            // Đơn chưa thanh toán chỉ giữ nguyên liệu; khi hủy phải nhả lượng đã giữ.
            if (next === OrderStatus.CANCELLED &&
                (order.status === OrderStatus.PENDING || order.status === OrderStatus.PAYMENT_FAILED) &&
                order.inventoryState === 'RESERVED') {
                await this.inventory.release(tx, order);
            }

            // Hủy đơn đã thanh toán -> hoàn kho + thu hồi điểm
            if (next === OrderStatus.CANCELLED && order.status === OrderStatus.PAID) {
                if (order.inventoryState === 'CONSUMED') {
                    await this.inventory.restore(tx, order);
                } else if (order.inventoryState === 'LEGACY') {
                    for (const item of order.items) {
                        if (!item.productId) continue; // Món cũ đã xóa chỉ còn bản chụp trong lịch sử.
                        await tx.product.update({
                            where: { id: item.productId },
                            data: { stock: { increment: item.qty }, version: { increment: 1 } },
                        });
                    }
                }
                if (order.loyaltyPointsEarned > 0) {
                    // Không để số dư điểm âm nếu khách đã dùng điểm
                    const u = await tx.user.findUnique({ where: { id: order.userId }, select: { loyaltyPoints: true } });
                    const refund = Math.min(order.loyaltyPointsEarned, u?.loyaltyPoints ?? 0);
                    if (refund > 0) {
                        const updated = await tx.user.update({
                            where: { id: order.userId },
                            data: { loyaltyPoints: { decrement: refund } },
                            select: { loyaltyPoints: true },
                        });
                        // Ghi sổ điểm để lịch sử khớp số dư
                        await tx.pointTransaction.create({
                            data: {
                                userId: order.userId,
                                type: PointTransactionType.REFUND,
                                points: -refund,
                                balanceAfter: updated.loyaltyPoints,
                                orderId: order.id,
                            },
                        });
                    }
                }
            }

            return tx.order.update({ where: { id }, data: { status: next } });
        });
    }

    // Kiểm tra lượng nguyên liệu theo Decimal(14, 3).
    private ingredientAmount(
        value: number,
        unit: IngredientUnit,
        label: string,
        allowZero = false,
    ) {
        const amount = new Prisma.Decimal(value);

        if (
            !amount.isFinite() ||
            amount.lt(allowZero ? 0 : 0.001) ||
            amount.decimalPlaces() > 3 ||
            amount.gt('99999999999.999')
        ) {
            throw new BadRequestException(
                `${label} phải là số ${allowZero ? 'không âm' : 'dương'}, tối đa 3 chữ số thập phân`,
            );
        }

        if (unit === IngredientUnit.PIECE && !amount.isInteger()) {
            throw new BadRequestException(`${label} tính bằng cái phải là số nguyên`);
        }

        return amount;
    }

    // Khóa dòng trước khi kiểm tra và cập nhật thông tin hoặc nhập kho.
    private async lockIngredient(tx: Prisma.TransactionClient, id: string) {
        await tx.$queryRaw`
            SELECT "id" FROM "ingredients"
            WHERE "id" = ${id}
            FOR UPDATE
        `;

        const ingredient = await tx.ingredient.findUnique({ where: { id } });
        if (!ingredient) {
            throw new NotFoundException('Không tìm thấy nguyên liệu');
        }

        return ingredient;
    }

    // Kiểm tra dữ liệu một nguyên liệu và dựng dữ liệu để ghi.
    private buildIngredientData(dto: CreateIngredientDto): Prisma.IngredientCreateInput {
        if (dto.trackStock && dto.onHand == null) {
            throw new BadRequestException('Nguyên liệu quản lý tồn phải có tồn ban đầu');
        }

        if (
            !dto.trackStock &&
            (dto.onHand != null || dto.lowStockThreshold != null)
        ) {
            throw new BadRequestException(
                'Nguyên liệu không quản lý tồn phải để trống tồn và ngưỡng cảnh báo',
            );
        }

        const onHand = dto.trackStock
            ? this.ingredientAmount(dto.onHand!, dto.unit, 'Tồn ban đầu', true)
            : null;

        const packageQuantity = dto.packageQuantity == null
            ? null
            : this.ingredientAmount(dto.packageQuantity, dto.unit, 'Quy cách nhập');

        const lowStockThreshold = dto.lowStockThreshold == null
            ? null
            : this.ingredientAmount(dto.lowStockThreshold, dto.unit, 'Ngưỡng cảnh báo', true);

        return {
            code: dto.code,
            name: dto.name,
            unit: dto.unit,
            trackStock: dto.trackStock,
            onHand,
            reserved: dto.trackStock ? new Prisma.Decimal(0) : null,
            packageQuantity,
            lowStockThreshold,
            isActive: dto.isActive ?? true,
        };
    }

    async createIngredient(dto: CreateIngredientDto) {
        const data = this.buildIngredientData(dto);

        try {
            return await this.prisma.ingredient.create({ data });
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
            ) {
                throw new ConflictException('Mã nguyên liệu đã tồn tại');
            }
            throw error;
        }
    }

    async updateIngredient(id: string, dto: UpdateIngredientDto) {
        return this.prisma.$transaction(async (tx) => {
            const ingredient = await this.lockIngredient(tx, id);

            if (ingredient.version !== dto.version) {
                throw new ConflictException(
                    'Nguyên liệu vừa thay đổi. Vui lòng chọn lại nguyên liệu trước khi sửa',
                );
            }

            const data: Prisma.IngredientUpdateInput = {
                version: { increment: 1 },
            };

            if (dto.name !== undefined) data.name = dto.name;
            if (dto.isActive !== undefined) data.isActive = dto.isActive;

            if (dto.packageQuantity !== undefined) {
                data.packageQuantity = dto.packageQuantity === null
                    ? null
                    : this.ingredientAmount(
                        dto.packageQuantity, ingredient.unit, 'Quy cách nhập',
                    );
            }

            if (dto.lowStockThreshold !== undefined) {
                if (!ingredient.trackStock && dto.lowStockThreshold !== null) {
                    throw new BadRequestException(
                        'Nguyên liệu không quản lý tồn không có ngưỡng cảnh báo',
                    );
                }

                data.lowStockThreshold = dto.lowStockThreshold === null
                    ? null
                    : this.ingredientAmount(
                        dto.lowStockThreshold,
                        ingredient.unit,
                        'Ngưỡng cảnh báo',
                        true,
                    );
            }

            return tx.ingredient.update({ where: { id }, data });
        });
    }

    async restockIngredient(id: string, dto: RestockIngredientDto) {
        return this.prisma.$transaction(async (tx) => {
            const ingredient = await this.lockIngredient(tx, id);

            if (!ingredient.trackStock) {
                throw new BadRequestException('Nguyên liệu này không quản lý tồn kho');
            }

            if (ingredient.onHand === null || ingredient.reserved === null) {
                throw new ConflictException('Dữ liệu tồn kho nguyên liệu không hợp lệ');
            }

            const quantity = this.ingredientAmount(
                dto.quantity, ingredient.unit, 'Số lượng nhập',
            );

            if (ingredient.onHand.add(quantity).gt('99999999999.999')) {
                throw new BadRequestException('Tồn sau nhập vượt giới hạn lưu trữ');
            }

            // quantity đã là g, ml hoặc cái, không nhân packageQuantity lần nữa.
            return tx.ingredient.update({
                where: { id },
                data: {
                    onHand: { increment: quantity },
                    version: { increment: 1 },
                },
            });
        });
    }

    // Chuẩn hóa thứ tự và số thập phân để so sánh công thức gốc.
    private recipeSignature(
        lines: { ingredientId: string; quantity: number | Prisma.Decimal }[],
    ) {
        return lines
            .map((line) =>
                `${line.ingredientId}:${new Prisma.Decimal(line.quantity).toFixed(3)}`)
            .sort()
            .join('|');
    }

    async saveProductRecipe(productId: string, size: ProductSize, dto: SaveRecipeDto) {
        return this.saveRecipe({ productId, size }, dto);
    }

    async saveToppingRecipe(toppingId: string, dto: SaveRecipeDto) {
        return this.saveRecipe({ toppingId }, dto);
    }

    private async saveRecipe(
        target: { productId: string; size: ProductSize } | { toppingId: string },
        dto: SaveRecipeDto,
    ) {
        const ids = dto.ingredients.map((line) => line.ingredientId);

        if (new Set(ids).size !== ids.length) {
            throw new BadRequestException('Một nguyên liệu chỉ được xuất hiện một lần');
        }

        return this.prisma.$transaction(async (tx) => {
            // Khóa đối tượng sở hữu công thức, kể cả khi chưa có dòng công thức.
            if ('productId' in target) {
                await tx.$queryRaw`
                    SELECT "id" FROM "products"
                    WHERE "id" = ${target.productId}
                    FOR UPDATE
                `;

                const product = await tx.product.findUnique({
                    where: { id: target.productId },
                    include: { prices: true },
                });

                if (!product) {
                    throw new NotFoundException('Không tìm thấy sản phẩm');
                }

                if (!product.prices.some((price) => price.size === target.size)) {
                    throw new BadRequestException('Sản phẩm không có size được chọn');
                }
            } else {
                await tx.$queryRaw`
                    SELECT "id" FROM "toppings"
                    WHERE "id" = ${target.toppingId}
                    FOR UPDATE
                `;

                const topping = await tx.topping.findUnique({
                    where: { id: target.toppingId },
                });

                if (!topping) {
                    throw new NotFoundException('Không tìm thấy topping');
                }
            }

            const where: Prisma.RecipeWhereInput = target;
            const current = await tx.recipe.findMany({
                where,
                select: { ingredientId: true, quantity: true },
            });

            if (
                this.recipeSignature(current) !==
                this.recipeSignature(dto.expectedIngredients)
            ) {
                throw new ConflictException(
                    'Công thức đã được người khác thay đổi. Hãy bỏ bản sửa và tải lại',
                );
            }

            // Topping là nguyên liệu đi kèm: đúng một nguyên liệu, chỉ chỉnh định lượng.
            // Không tự chọn hay xóa dòng khi dữ liệu hiện có không đúng một dòng.
            if ('toppingId' in target) {
                if (current.length !== 1) {
                    throw new BadRequestException(
                        `Topping đang có ${current.length} nguyên liệu trong công thức. Cần xử lý dữ liệu để còn đúng một nguyên liệu trước khi chỉnh định lượng`,
                    );
                }

                if (
                    dto.ingredients.length !== 1 ||
                    dto.ingredients[0].ingredientId !== current[0].ingredientId
                ) {
                    throw new BadRequestException('Topping chỉ được chỉnh định lượng, không đổi nguyên liệu');
                }
            }

            // Giữ trạng thái nguyên liệu ổn định trong lúc kiểm tra và lưu.
            await tx.$queryRaw`
                SELECT "id" FROM "ingredients"
                WHERE "id" IN (${Prisma.join(ids)})
                ORDER BY "id"
                FOR SHARE
            `;

            const ingredients = await tx.ingredient.findMany({
                where: { id: { in: ids } },
            });

            if (ingredients.length !== ids.length) {
                throw new BadRequestException('Có nguyên liệu không tồn tại');
            }

            const byId = new Map(
                ingredients.map((ingredient) => [ingredient.id, ingredient]),
            );

            const rows = dto.ingredients.map((line) => {
                const ingredient = byId.get(line.ingredientId)!;

                if (!ingredient.isActive) {
                    throw new BadRequestException(
                        `Nguyên liệu "${ingredient.name}" đang ngừng sử dụng`,
                    );
                }

                return {
                    ...target,
                    ingredientId: line.ingredientId,
                    quantity: this.ingredientAmount(
                        line.quantity, ingredient.unit, `Định lượng ${ingredient.name}`,
                    ),
                };
            });

            if ('productId' in target) {
                const byCode = new Map(
                    ingredients.map((ingredient) => [ingredient.code, ingredient]),
                );

                for (const code of ['WATER', 'ICE', 'STRAW', `CUP_${target.size}`]) {
                    if (!byCode.has(code)) {
                        throw new BadRequestException(`Công thức thiếu nguyên liệu ${code}`);
                    }
                }

                for (const ingredient of ingredients) {
                    if (
                        ingredient.code.startsWith('CUP_') &&
                        ingredient.code !== `CUP_${target.size}`
                    ) {
                        throw new BadRequestException('Công thức chứa ly không đúng size');
                    }

                    if (
                        ingredient.code === 'STRAW' ||
                        ingredient.code === `CUP_${target.size}`
                    ) {
                        const row = rows.find(
                            (entry) => entry.ingredientId === ingredient.id,
                        )!;

                        if (
                            ingredient.unit !== IngredientUnit.PIECE ||
                            !row.quantity.equals(1)
                        ) {
                            throw new BadRequestException(
                                'Mỗi ly đồ uống phải dùng một ly vật lý và một ống hút',
                            );
                        }
                    }
                }
            }

            // Xóa và tạo lại cùng transaction, lỗi thì giữ nguyên công thức cũ.
            await tx.recipe.deleteMany({ where });
            await tx.recipe.createMany({ data: rows });

            if ('productId' in target) {
                await tx.product.update({
                    where: { id: target.productId },
                    data: { version: { increment: 1 } },
                });
            }

            return tx.recipe.findMany({
                where,
                select: { ingredientId: true, quantity: true },
                orderBy: { ingredient: { name: 'asc' } },
            });
        });
    }

    // QUẢN LÝ TỒN KHO SẢN PHẨM CŨ.

    // Nguồn dữ liệu chỉ đọc cho giao diện nguyên liệu và công thức.
    // Trả thêm usage (suy ra từ bảng recipes và mã bao bì), không cần thêm cột phân loại.
    async listIngredients() {
        const [ingredients, inProducts, inToppings] = await Promise.all([
            this.prisma.ingredient.findMany({ orderBy: { name: 'asc' } }),
            this.prisma.recipe.groupBy({
                by: ['ingredientId'],
                where: { productId: { not: null } },
                _count: { _all: true },
            }),
            this.prisma.recipe.groupBy({
                by: ['ingredientId'],
                where: { toppingId: { not: null } },
                _count: { _all: true },
            }),
        ]);

        const productIds = new Set(inProducts.map((row) => row.ingredientId));
        const toppingIds = new Set(inToppings.map((row) => row.ingredientId));

        return ingredients.map((ingredient) => {
            const packaging = isPackagingCode(ingredient.code);
            const inProduct = productIds.has(ingredient.id);
            const inTopping = toppingIds.has(ingredient.id);

            return {
                ...ingredient,
                usage: {
                    drink: inProduct && !packaging,
                    topping: inTopping,
                    packaging,
                    unused: !inProduct && !inTopping,
                },
            };
        });
    }

    async listProductRecipe(productId: string, size: ProductSize) {
        return this.prisma.recipe.findMany({
            where: { productId, size },
            select: { ingredientId: true, quantity: true },
            orderBy: { ingredient: { name: 'asc' } },
        });
    }

    async listToppingRecipe(toppingId: string) {
        return this.prisma.recipe.findMany({
            where: { toppingId },
            select: { ingredientId: true, quantity: true },
            orderBy: { ingredient: { name: 'asc' } },
        });
    }

    // Danh sách toàn bộ sản phẩm cho Admin (kèm tồn kho, size, trạng thái)
    async listProducts(category?: string, search?: string) {
        const where: Prisma.ProductWhereInput = {};
        if (category && category !== 'all') {
            where.category = category;
        }
        if (search?.trim()) {
            where.name = { contains: search.trim(), mode: 'insensitive' };
        }

        return this.prisma.product.findMany({
            where,
            include: {
                prices: { orderBy: { size: 'asc' } },
            },
            orderBy: { name: 'asc' },
        });
    }

    // Cập nhật tồn kho: cộng thêm (+) hoặc gán mới
    async updateStock(id: string, dto: UpdateStockDto) {
        if ((dto.stock === undefined) === (dto.quantityToAdd === undefined)) {
            throw new BadRequestException('Chỉ gửi một trong hai: stock hoặc quantityToAdd');
        }

        if (dto.quantityToAdd !== undefined) {
            const r = await this.prisma.product.updateMany({
                where: { id },
                data: { stock: { increment: dto.quantityToAdd }, version: { increment: 1 } },
            });
            if (r.count === 0) throw new NotFoundException(`Không tìm thấy sản phẩm ${id}`);
            return this.prisma.product.findUnique({ where: { id } });
        }

        const product = await this.prisma.product.findUnique({ where: { id } });
        if (!product) throw new NotFoundException(`Không tìm thấy sản phẩm ${id}`);

        const r = await this.prisma.product.updateMany({
            where: { id, version: product.version },
            data: { stock: dto.stock, version: { increment: 1 } },
        });
        if (r.count === 0) throw new ConflictException('Tồn kho vừa thay đổi, vui lòng tải lại rồi thử lại');
        return this.prisma.product.findUnique({ where: { id } });
    }

    // Bật / tắt trạng thái mở bán sản phẩm
    async toggleProductAvailability(id: string) {
        const product = await this.prisma.product.findUnique({ where: { id } });
        if (!product) throw new NotFoundException(`Không tìm thấy sản phẩm ${id}`);

        return this.prisma.product.update({
            where: { id },
            data: {
                isAvailable: !product.isAvailable,
            },
        });
    }

    async createPromotion(dto: CreatePromotionDto) {
        const formattedCode = dto.code.trim().toUpperCase();
        // API nhận cả ngày đơn thuần và ISO có múi giờ; ngày đơn thuần hết hạn cuối ngày Việt Nam.
        const endDate = dto.endDate
            ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(dto.endDate)
                ? `${dto.endDate}T23:59:59+07:00`
                : dto.endDate)
            : null;
        if (endDate && (Number.isNaN(endDate.getTime()) || endDate.getTime() <= Date.now())) {
            throw new BadRequestException('Hạn dùng voucher phải ở trong tương lai theo giờ Việt Nam');
        }

        const existingPromo = await this.prisma.promotion.findUnique({
            where: { code: formattedCode },
        });

        if (existingPromo) {
            // Dùng backtick để ${...} được thay bằng giá trị thật
            throw new BadRequestException(`Mã voucher "${formattedCode}" đã tồn tại trên hệ thống`);
        }

        if (dto.discountType === 'PERCENTAGE' && dto.discountValue > 100) {
            throw new BadRequestException('Mức giảm theo phần trăm không được vượt quá 100%');
        }

        return this.prisma.promotion.create({
            data: {
                code: formattedCode,
                description: dto.description?.trim() || null,
                discountType: dto.discountType,
                discountValue: dto.discountValue,
                minOrderValue: dto.minOrderValue ?? 0,
                maxDiscount: dto.discountType === 'PERCENTAGE' ? (dto.maxDiscount ?? null) : null,
                startDate: new Date(),
                endDate,
                isActive: dto.isActive ?? true,
            },
        });
    }

    // Danh sách toàn bộ voucher cho Admin (kể cả mã đã tắt / đã hết hạn)
    async listPromotions() {
        return this.prisma.promotion.findMany({
            orderBy: { createdAt: 'desc' },
        });
    }

    // Bật / tắt một voucher (mã tắt thì khách không áp dụng được)
    async togglePromotionActive(id: string) {
        const promo = await this.prisma.promotion.findUnique({ where: { id } });
        if (!promo) throw new NotFoundException(`Không tìm thấy voucher ${id}`);

        return this.prisma.promotion.update({
            where: { id },
            data: { isActive: !promo.isActive },
        });
    }
}
