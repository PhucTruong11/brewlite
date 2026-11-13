import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RewardsService } from './rewards.service.js';

describe('RewardsService và hạn voucher', () => {
  const tx = {
    $queryRaw: vi.fn(),
    rewardItem: { findFirst: vi.fn() },
    userVoucher: { count: vi.fn(), create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    user: { updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    pointTransaction: { create: vi.fn() },
    promotion: { findUnique: vi.fn() },
  };
  const prisma = {
    user: { findUnique: vi.fn() },
    rewardItem: { findMany: vi.fn(), findFirst: vi.fn() },
    userVoucher: { findMany: vi.fn() },
    pointTransaction: { findMany: vi.fn() },
    promotion: { findUnique: vi.fn() },
    $transaction: vi.fn((callback: (transaction: typeof tx) => unknown) => callback(tx)),
  };
  const service = new RewardsService(prisma as never);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T04:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('chỉ tải quà và voucher có promotion còn hiệu lực', async () => {
    prisma.user.findUnique.mockResolvedValue({ loyaltyPoints: 20 });
    prisma.rewardItem.findMany.mockResolvedValue([]);
    prisma.userVoucher.findMany.mockResolvedValue([]);
    prisma.pointTransaction.findMany.mockResolvedValue([]);

    await service.getOverview('u1');

    const activePromotion = expect.objectContaining({
      isActive: true,
      startDate: { lte: new Date() },
      OR: [{ endDate: null }, { endDate: { gt: new Date() } }],
    });
    expect(prisma.rewardItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ promotion: { is: activePromotion } }),
    }));
    expect(prisma.userVoucher.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ promotion: { is: activePromotion } }),
    }));
  });

  it('không trừ điểm nếu quà vừa hết hạn', async () => {
    tx.rewardItem.findFirst.mockResolvedValue({
      isActive: true,
      promotion: {
        isActive: true,
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        endDate: new Date(),
      },
    });
    await expect(service.redeem('u1', 'r1')).rejects.toThrow(NotFoundException);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it('không cho đổi quà khi admin đã tắt promotion', async () => {
    tx.rewardItem.findFirst.mockResolvedValue({
      isActive: true,
      promotion: {
        isActive: false,
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        endDate: null,
      },
    });
    await expect(service.redeem('u1', 'r1')).rejects.toThrow(NotFoundException);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it('ẩn quà đổi thưởng đã hết số lượng nhưng vẫn trả voucher đã đổi chưa dùng', async () => {
    prisma.user.findUnique.mockResolvedValue({ loyaltyPoints: 20 });
    const endDate = new Date('2026-12-01T16:59:59.000Z');
    prisma.rewardItem.findMany.mockResolvedValue([
      {
        id: 'available',
        redemptionLimit: 10,
        pointsCost: 5,
        _count: { userVouchers: 9 },
        promotion: { code: 'AVAILABLE', endDate },
      },
      {
        id: 'sold-out',
        redemptionLimit: 10,
        pointsCost: 5,
        _count: { userVouchers: 10 },
        promotion: { code: 'SOLDOUT' },
      },
    ]);
    prisma.userVoucher.findMany.mockResolvedValue([
      { promotion: { code: 'SOLDOUT', description: 'Voucher đã cấp' } },
    ]);
    prisma.pointTransaction.findMany.mockResolvedValue([]);

    const overview = await service.getOverview('u1');

    expect(overview.rewards).toEqual([
      expect.objectContaining({
        id: 'available',
        redemptionLimit: 10,
        remainingCount: 1,
        endDate,
      }),
    ]);
    expect(overview.vouchers).toEqual([
      expect.objectContaining({ code: 'SOLDOUT' }),
    ]);
  });

  it('từ chối đổi khi giới hạn số lượng đã hết', async () => {
    tx.rewardItem.findFirst.mockResolvedValue({
      id: 'r1',
      promotionId: 'p1',
      pointsCost: 5,
      redemptionLimit: 2,
      isActive: true,
      promotion: {
        code: 'LIMITED',
        isActive: true,
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        endDate: null,
      },
    });
    tx.userVoucher.count.mockResolvedValue(2);

    await expect(service.redeem('u1', 'r1')).rejects.toThrow(BadRequestException);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(tx.userVoucher.create).not.toHaveBeenCalled();
  });

  it('voucher dùng chung không cần kiểm tra quyền sở hữu voucher đổi thưởng', async () => {
    prisma.promotion.findUnique.mockResolvedValue({
      id: 'p1',
      isRewardOnly: false,
      isActive: true,
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: null,
    });

    await expect(service.assertVoucherUsable('u1', 'SHARED')).resolves.toBeUndefined();
    expect(prisma.promotion.findUnique).toHaveBeenCalledWith({
      where: { code: 'SHARED' },
    });
  });

  it('không tiêu thụ UserVoucher khi thanh toán bằng voucher dùng chung', async () => {
    tx.promotion.findUnique.mockResolvedValue({
      id: 'p1',
      isRewardOnly: false,
      isActive: true,
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: null,
    });

    await service.consumeVoucher(tx as never, 'u1', 'ONCE', 'order1');

    expect(tx.userVoucher.findFirst).not.toHaveBeenCalled();
    expect(tx.userVoucher.updateMany).not.toHaveBeenCalled();
  });

  it('báo mã không tồn tại khi promotion đã bị admin tắt', async () => {
    prisma.promotion.findUnique.mockResolvedValue({
      id: 'p1',
      isRewardOnly: false,
      isActive: false,
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: null,
    });

    await expect(service.assertVoucherUsable('u1', 'OFF')).rejects.toThrow(NotFoundException);
  });
});
