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
    };
    const prisma = {
        $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
        product: { findUnique: vi.fn(), updateMany: vi.fn() },
        order: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), aggregate: vi.fn() },
        promotion: { findUnique: vi.fn(), create: vi.fn() },
    };
    const inventory = { release: vi.fn(), restore: vi.fn() };
    const service = new AdminService(prisma as never, inventory as never);

    beforeEach(() => vi.clearAllMocks());

    it('danh sách admin loại đơn chờ thanh toán và chỉ giữ đơn hủy đã trả tiền', async () => {
        prisma.order.findMany.mockResolvedValue([]);
        prisma.order.count.mockResolvedValue(0);
        prisma.$transaction.mockImplementationOnce(async (requests: Promise<unknown>[]) => Promise.all(requests));

        await service.listOrders({ range: 'all' });

        expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                AND: [expect.objectContaining({ OR: [
                    { status: { in: ['PAID', 'PREPARING', 'READY', 'COMPLETED'] } },
                    { status: 'CANCELLED', payments: { some: { status: 'SUCCESS' } } },
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

    it.each(['PENDING', 'PAYMENT_FAILED'])(
        'hủy đơn %s: nhả nguyên liệu đã giữ trước khi đổi trạng thái',
        async (status) => {
            const order = {
                id: 'o1', status, inventoryState: 'RESERVED', items: [],
            };
            tx.order.findUnique.mockResolvedValue(order);

            await service.updateStatus('o1', 'CANCELLED' as never);

            expect(inventory.release).toHaveBeenCalledExactlyOnceWith(tx, order);
            expect(inventory.restore).not.toHaveBeenCalled();
            expect(inventory.release.mock.invocationCallOrder[0]).toBeLessThan(
                tx.order.update.mock.invocationCallOrder[0],
            );
            expect(tx.order.update).toHaveBeenCalledWith({
                where: { id: 'o1' }, data: { status: 'CANCELLED' },
            });
        },
    );

    it('không nhả kho lần nữa nếu nguyên liệu của đơn đã được trả', async () => {
        tx.order.findUnique.mockResolvedValue({
            id: 'o1', status: 'PENDING', inventoryState: 'RELEASED', items: [],
        });

        await service.updateStatus('o1', 'CANCELLED' as never);

        expect(inventory.release).not.toHaveBeenCalled();
        expect(tx.order.update).toHaveBeenCalledWith({
            where: { id: 'o1' }, data: { status: 'CANCELLED' },
        });
    });

    it('hủy đơn PAID: hoàn kho, thu hồi điểm, ghi sổ điểm', async () => {
        tx.order.findUnique.mockResolvedValue({
            id: 'o1', status: 'PAID', inventoryState: 'LEGACY', userId: 'u1', loyaltyPointsEarned: 3,
            items: [{ productId: 'p1', qty: 2 }],
        });
        tx.user.findUnique.mockResolvedValue({ loyaltyPoints: 10 });
        tx.user.update.mockResolvedValue({ loyaltyPoints: 7 });

        await service.updateStatus('o1', 'CANCELLED' as never);

        expect(tx.product.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ stock: { increment: 2 } }) }),
        );
        expect(tx.pointTransaction.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ type: 'REFUND', points: -3 }) }),
        );
    });

    it('hủy đơn nguyên liệu: hoàn nguyên liệu từ snapshot, không cộng Product.stock', async () => {
        tx.order.findUnique.mockResolvedValue({
            id: 'o2', status: 'PAID', inventoryState: 'CONSUMED', userId: 'u1',
            loyaltyPointsEarned: 0, items: [{ recipeSnapshot: [{ ingredientId: 'i1', quantity: '20.000' }] }],
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
