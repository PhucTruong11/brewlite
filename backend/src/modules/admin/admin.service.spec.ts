import { BadRequestException, ConflictException } from '@nestjs/common';
import { AdminService } from './admin.service.js';

describe('AdminService', () => {
    // tx giả dùng trong $transaction
    const tx = {
        $queryRaw: vi.fn(),
        order: { findUnique: vi.fn(), update: vi.fn() },
        product: { update: vi.fn() },
        user: { findUnique: vi.fn(), update: vi.fn() },
        pointTransaction: { create: vi.fn() },
        promotion: { findUnique: vi.fn(), update: vi.fn() },
        userVoucher: { count: vi.fn(), updateMany: vi.fn() },
    };
    const prisma = {
        $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
        product: { findUnique: vi.fn(), updateMany: vi.fn() },
        order: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), aggregate: vi.fn() },
        promotion: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn() },
        rewardItem: { findMany: vi.fn() },
        userVoucher: { groupBy: vi.fn() },
    };
    const inventory = { release: vi.fn(), restore: vi.fn() };
    const rewards = { earnPoints: vi.fn() };
    const service = new AdminService(prisma as never, inventory as never, rewards as never);

    beforeEach(() => {
        vi.clearAllMocks();
        rewards.earnPoints.mockResolvedValue(0);
    });

    it('danh sách admin loại đơn chờ thanh toán và chỉ giữ đơn hủy đã trả tiền', async () => {
        prisma.order.findMany.mockResolvedValue([]);
        prisma.order.count.mockResolvedValue(0);
        (prisma.$transaction as any).mockImplementationOnce(async (requests: Promise<unknown>[]) => Promise.all(requests));

        await service.listOrders({ range: 'all' });

        expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                AND: [expect.objectContaining({ OR: [
                    { status: { in: ['PAID', 'PREPARING', 'READY', 'COMPLETED'] } },
                    { status: 'CANCELLED', OR: [
                        { payments: { some: { status: 'SUCCESS' } } },
                        { compensationIssued: { isNot: null } },
                    ] },
                ] })],
            }),
        }));
    });

    it('không cho tạo voucher có hạn dùng đã qua', async () => {
        await expect(service.createPromotion({
            code: 'OLD', discountType: 'FIXED_AMOUNT', discountValue: 1000,
            endDate: '2020-01-01T16:59:59.000Z',
        })).rejects.toThrow(BadRequestException);
        expect(prisma.promotion.create).not.toHaveBeenCalled();
    });

    it('mặc định tạo voucher áp dụng chung khi không nhập điểm đổi', async () => {
        prisma.promotion.findUnique.mockResolvedValue(null);
        prisma.promotion.create.mockResolvedValue({ id: 'promo1' });

        await service.createPromotion({
            code: 'GENERAL10', discountType: 'PERCENTAGE', discountValue: 10,
        });

        expect(prisma.promotion.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                code: 'GENERAL10',
                isRewardOnly: false,
            }),
        }));
        expect(prisma.promotion.create.mock.calls[0][0].data.rewardItems).toBeUndefined();
    });

    it('tạo voucher đổi thưởng và danh mục quà với số điểm cần đổi', async () => {
        prisma.promotion.findUnique.mockResolvedValue(null);
        prisma.promotion.create.mockResolvedValue({ id: 'promo1' });

        await service.createPromotion({
            code: 'REWARD10K', discountType: 'FIXED_AMOUNT', discountValue: 10_000,
            isRewardOnly: true, pointsCost: 25, redemptionLimit: 100,
        });

        expect(prisma.promotion.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                code: 'REWARD10K',
                isRewardOnly: true,
                rewardItems: {
                    create: expect.objectContaining({
                        name: 'Giảm 10.000đ cho mọi đơn hàng',
                        description: 'Giảm 10.000đ cho mọi đơn hàng',
                        pointsCost: 25,
                        redemptionLimit: 100,
                    }),
                },
                description: 'Giảm 10.000đ cho mọi đơn hàng',
            }),
        }));
    });

    it('không tạo voucher đổi thưởng nếu thiếu điểm cần đổi', async () => {
        prisma.promotion.findUnique.mockResolvedValue(null);

        await expect(service.createPromotion({
            code: 'REWARD10K', discountType: 'FIXED_AMOUNT', discountValue: 10_000,
            isRewardOnly: true,
        })).rejects.toThrow(BadRequestException);

        expect(prisma.promotion.create).not.toHaveBeenCalled();
    });

    it('không tạo voucher đổi thưởng nếu thiếu giới hạn số lượng', async () => {
        prisma.promotion.findUnique.mockResolvedValue(null);

        await expect(service.createPromotion({
            code: 'REWARD10K', discountType: 'FIXED_AMOUNT', discountValue: 10_000,
            pointsCost: 25,
        })).rejects.toThrow(BadRequestException);

        expect(prisma.promotion.create).not.toHaveBeenCalled();
    });

    it('trả số lượng đổi còn lại và số lượt đã áp dụng trong danh sách admin', async () => {
        prisma.promotion.findMany.mockResolvedValue([
            { id: 'reward-promo', code: 'REWARD', isRewardOnly: true },
            { id: 'shared-promo', code: 'SHARED', isRewardOnly: false },
        ]);
        prisma.rewardItem.findMany.mockResolvedValue([
            { promotionId: 'reward-promo', pointsCost: 20, redemptionLimit: 10 },
        ]);
        prisma.userVoucher.groupBy
            .mockResolvedValueOnce([{ promotionId: 'reward-promo', _count: { _all: 4 } }])
            .mockResolvedValueOnce([{ promotionId: 'reward-promo', _count: { _all: 2 } }]);
        prisma.order.findMany.mockResolvedValue([
            { promoCode: 'SHARED' },
            { promoCode: 'shared' },
            { promoCode: null },
        ]);

        const result = await service.listPromotions();

        expect(result).toEqual([
            expect.objectContaining({
                id: 'reward-promo',
                redemptionLimit: 10,
                redeemedCount: 4,
                remainingCount: 6,
                appliedCount: 2,
            }),
            expect.objectContaining({
                id: 'shared-promo',
                redemptionLimit: null,
                remainingCount: null,
                appliedCount: 2,
            }),
        ]);
    });

    it('không cho giảm giới hạn thấp hơn số voucher đã phát hành', async () => {
        tx.promotion.findUnique.mockResolvedValue({
            id: 'promo1',
            code: 'REWARD',
            isRewardOnly: true,
            discountType: 'FIXED_AMOUNT',
            discountValue: 10_000,
            minOrderValue: 0,
            maxDiscount: null,
            endDate: null,
            rewardItems: [{ id: 'reward1', pointsCost: 20, redemptionLimit: 10 }],
        });
        tx.userVoucher.count.mockResolvedValueOnce(5).mockResolvedValueOnce(0);

        await expect(service.updatePromotion('promo1', { redemptionLimit: 4 }))
            .rejects.toThrow(BadRequestException);
        expect(tx.promotion.update).not.toHaveBeenCalled();
    });

    it('ngày kết thúc không có giờ được hiểu là cuối ngày Việt Nam', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-28T04:00:00.000Z'));
        try {
            prisma.promotion.findUnique.mockResolvedValue(null);
            prisma.promotion.create.mockResolvedValue({ id: 'promo1' });
            await service.createPromotion({
                code: 'TODAY', discountType: 'FIXED_AMOUNT', discountValue: 1000,
                endDate: '2026-10-28',
            });
            expect(prisma.promotion.create).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({ endDate: new Date('2026-10-28T16:59:59.000Z') }),
            }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('chặn admin đặt trạng thái PAID', async () => {
        await expect(service.updateStatus('o1', 'PAID' as never)).rejects.toThrow(BadRequestException);
    });

    it('chặn chuyển trạng thái không hợp lệ (COMPLETED -> PREPARING)', async () => {
        tx.order.findUnique.mockResolvedValue({ id: 'o1', status: 'COMPLETED', items: [] });
        await expect(service.updateStatus('o1', 'PREPARING' as never)).rejects.toThrow(BadRequestException);
    });

    it('chỉ cộng điểm khi admin chuyển đơn sang COMPLETED', async () => {
        tx.order.findUnique.mockResolvedValue({
            id: 'o1', status: 'READY', userId: 'u1', total: 50_000,
            compensationSourceId: null, loyaltyPointsEarned: 0,
            payments: [{ amount: 50_000 }], items: [],
        });
        rewards.earnPoints.mockResolvedValue(5);

        await service.updateStatus('o1', 'COMPLETED' as never);

        expect(rewards.earnPoints).toHaveBeenCalledWith(tx, {
            id: 'o1', userId: 'u1', total: 50_000,
        });
        expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'COMPLETED', loyaltyPointsEarned: 5 }),
        }));
    });

    it('tính điểm đơn thay thế theo tổng giá, không phải phần thanh toán thêm', async () => {
        tx.order.findUnique.mockResolvedValue({
            id: 'replacement1', status: 'READY', userId: 'u1', total: 75_000,
            compensationSourceId: 'original1', loyaltyPointsEarned: 0,
            payments: [{ amount: 25_000 }], items: [],
        });
        rewards.earnPoints.mockResolvedValue(7);

        await service.updateStatus('replacement1', 'COMPLETED' as never);

        expect(rewards.earnPoints).toHaveBeenCalledWith(tx, {
            id: 'replacement1', userId: 'u1', total: 75_000,
        });
    });

    it.each(['PENDING', 'PAYMENT_FAILED', 'PREPARING', 'READY', 'COMPLETED'])(
        'chặn admin hủy đơn %s',
        async (status) => {
            tx.order.findUnique.mockResolvedValue({ id: 'o1', status, items: [] });
            await expect(service.updateStatus('o1', 'CANCELLED' as never)).rejects.toThrow(ConflictException);
            expect(inventory.release).not.toHaveBeenCalled();
            expect(tx.order.update).not.toHaveBeenCalled();
        },
    );

    it('hủy đơn PAID: hoàn kho, thu hồi điểm đã cộng và tạo đền bù', async () => {
        tx.user.findUnique.mockResolvedValue({ loyaltyPoints: 2 });
        tx.user.update.mockResolvedValue({ loyaltyPoints: 0 });
        tx.order.findUnique.mockResolvedValue({
            id: 'o1', status: 'PAID', inventoryState: 'LEGACY', userId: 'u1', loyaltyPointsEarned: 4,
            payments: [{ amount: 45_000 }], items: [{ productId: 'p1', qty: 2 }],
        });
        await service.updateStatus('o1', 'CANCELLED' as never);
        expect(tx.product.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ stock: { increment: 2 } }) }),
        );
        expect(tx.user.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { loyaltyPoints: { decrement: 2 } },
            select: { loyaltyPoints: true },
        });
        expect(tx.pointTransaction.create).toHaveBeenCalledWith({
            data: {
                userId: 'u1',
                type: 'REFUND',
                points: -2,
                balanceAfter: 0,
                orderId: 'o1',
            },
        });
        expect(tx.userVoucher.updateMany).toHaveBeenCalledWith({
            where: { usedOrderId: 'o1' },
            data: { usedAt: null, usedOrderId: null },
        });
        expect(tx.order.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: {
            status: 'CANCELLED',
            compensationIssued: { create: { amount: 45_000 } },
            notifications: { create: { status: 'CANCELLED' } },
        } });
    });

    it('hủy đơn nguyên liệu: hoàn nguyên liệu từ snapshot, không cộng Product.stock', async () => {
        tx.order.findUnique.mockResolvedValue({
            id: 'o2', status: 'PAID', inventoryState: 'CONSUMED', userId: 'u1',
            loyaltyPointsEarned: 0, payments: [{ amount: 30_000 }], items: [{ recipeSnapshot: [{ ingredientId: 'i1', quantity: '20.000' }] }],
        });
        await service.updateStatus('o2', 'CANCELLED' as never);
        expect(inventory.restore).toHaveBeenCalledWith(tx, expect.objectContaining({ id: 'o2' }));
        expect(tx.product.update).not.toHaveBeenCalled();
    });

    it('updateStock: cộng thêm dùng increment', async () => {
        prisma.product.updateMany.mockResolvedValue({ count: 1 });
        prisma.product.findUnique.mockResolvedValue({ id: 'p1', stock: 15 });
        await service.updateStock('p1', { quantityToAdd: 5 });
        expect(prisma.product.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ stock: { increment: 5 } }) }),
        );
    });

    it('updateStock: đặt lại báo 409 khi version đã đổi', async () => {
        prisma.product.findUnique.mockResolvedValue({ id: 'p1', version: 3 });
        prisma.product.updateMany.mockResolvedValue({ count: 0 });
        await expect(service.updateStock('p1', { stock: 20 })).rejects.toThrow(ConflictException);
    });

    it('updateStock: gửi cả hai trường thì lỗi 400', async () => {
        await expect(service.updateStock('p1', { stock: 1, quantityToAdd: 1 })).rejects.toThrow(BadRequestException);
    });
});
