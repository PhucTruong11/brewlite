import { NotFoundException } from '@nestjs/common';
import { PromotionsService } from './promotions.service.js';

describe('PromotionsService', () => {
  const prisma = { promotion: { findMany: vi.fn(), findUnique: vi.fn() } };
  const service = new PromotionsService(prisma as never);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T04:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('chỉ liệt kê voucher đã có hiệu lực và chưa hết hạn', async () => {
    prisma.promotion.findMany.mockResolvedValue([]);
    await service.findAll();
    expect(prisma.promotion.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        isActive: true,
        startDate: { lte: new Date() },
        OR: [{ endDate: null }, { endDate: { gt: new Date() } }],
      }),
    }));
  });

  it('từ chối mã vừa hết hạn ở API áp voucher', async () => {
    prisma.promotion.findUnique.mockResolvedValue({
      code: 'OLD', isActive: true,
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date(),
    });
    await expect(service.applyPromotion({ code: 'OLD', subtotal: 50000 }))
      .rejects.toThrow(NotFoundException);
  });

  it('cho phép mã còn hạn và tính giảm giá', async () => {
    prisma.promotion.findUnique.mockResolvedValue({
      code: 'LIVE', isActive: true,
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2026-10-29T00:00:00.000Z'),
      minOrderValue: 0, discountType: 'FIXED_AMOUNT', discountValue: 10000,
    });
    await expect(service.applyPromotion({ code: 'LIVE', subtotal: 50000 }))
      .resolves.toMatchObject({ discountAmount: 10000 });
  });
});
