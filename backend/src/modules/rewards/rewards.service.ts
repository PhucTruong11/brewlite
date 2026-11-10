import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PointTransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

// 10.000đ = 1 điểm, làm tròn xuống
export const VND_PER_POINT = 10_000;

@Injectable()
export class RewardsService {
  constructor(private readonly prisma: PrismaService) {}

  calcPoints(total: number): number {
    return Math.floor(total / VND_PER_POINT);
  }

  // ---------------- GET /rewards ----------------
  async getOverview(userId: string) {
    const now = new Date();
    const usablePromotion = {
      isActive: true,
      startDate: { lte: now },
      OR: [{ endDate: null }, { endDate: { gt: now } }],
    };
    const [user, rewardItems, unusedVouchers, history] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { loyaltyPoints: true },
      }),
      this.prisma.rewardItem.findMany({
        where: { isActive: true, promotion: { is: usablePromotion } },
        include: { promotion: true },
        orderBy: { pointsCost: 'asc' },
      }),
      this.prisma.userVoucher.findMany({
        where: { userId, usedAt: null, promotion: { is: usablePromotion } },
        include: { promotion: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.pointTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    if (!user) throw new NotFoundException('Người dùng không tồn tại');

    // Gộp voucher chưa dùng theo mã: REWARD10K x3
    const grouped = new Map<string, {
      code: string;
      description: string | null;
      count: number;
      discountType: string;
      discountValue: number;
      minOrderValue: number;
      maxDiscount: number | null;
    }>();
    for (const v of unusedVouchers) {
      const cur = grouped.get(v.promotion.code);
      if (cur) cur.count += 1;
      else
        grouped.set(v.promotion.code, {
          code: v.promotion.code,
          description: v.promotion.description,
          count: 1,
          discountType: v.promotion.discountType,
          discountValue: v.promotion.discountValue,
          minOrderValue: v.promotion.minOrderValue,
          maxDiscount: v.promotion.maxDiscount,
        });
    }

    return {
      points: user.loyaltyPoints,
      rewards: rewardItems.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        pointsCost: r.pointsCost,
        code: r.promotion.code,
      })),
      vouchers: [...grouped.values()],
      history,
    };
  }

  // ---------------- POST /rewards/redeem ----------------
  // Trừ điểm + tạo voucher + ghi lịch sử trong CÙNG 1 transaction
  async redeem(userId: string, rewardItemId: string) {
    const reward = await this.prisma.rewardItem.findFirst({
      where: { id: rewardItemId, isActive: true },
      include: { promotion: true },
    });
    if (!reward || !reward.promotion.isActive || reward.promotion.startDate > new Date() ||
        (reward.promotion.endDate && reward.promotion.endDate <= new Date())) {
      throw new NotFoundException('Phần quà không tồn tại, chưa có hiệu lực hoặc đã hết hạn');
    }

    return this.prisma.$transaction(async (tx) => {
      // Trừ điểm nguyên tử: chỉ thành công nếu còn đủ điểm (chống âm điểm khi bấm/đổi đồng thời)
      const deducted = await tx.user.updateMany({
        where: { id: userId, loyaltyPoints: { gte: reward.pointsCost } },
        data: { loyaltyPoints: { decrement: reward.pointsCost } },
      });
      if (deducted.count === 0) {
        throw new BadRequestException('Số điểm của bạn chưa đủ để đổi voucher này');
      }

      const voucher = await tx.userVoucher.create({
        data: { userId, promotionId: reward.promotionId, rewardItemId: reward.id },
      });

      const updatedUser = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { loyaltyPoints: true },
      });

      await tx.pointTransaction.create({
        data: {
          userId,
          type: PointTransactionType.REDEEM,
          points: -reward.pointsCost,
          balanceAfter: updatedUser.loyaltyPoints,
          userVoucherId: voucher.id,
        },
      });

      return {
        message: `Đổi thành công mã ${reward.promotion.code}! Nhập mã này ở trang thanh toán để sử dụng.`,
        points: updatedUser.loyaltyPoints,
        code: reward.promotion.code,
      };
    });
  }

  // ---------------- Dùng trong CheckoutService (cộng điểm) ----------------
  // Gọi BÊN TRONG transaction thanh toán thành công. Unique (orderId, EARN) chặn cộng trùng.
  async earnPoints(
    tx: Prisma.TransactionClient,
    order: { id: string; userId: string; total: number },
  ): Promise<number> {
    const points = this.calcPoints(order.total);
    if (points <= 0) return 0;

    const user = await tx.user.update({
      where: { id: order.userId },
      data: { loyaltyPoints: { increment: points } },
      select: { loyaltyPoints: true },
    });

    await tx.pointTransaction.create({
      data: {
        userId: order.userId,
        type: PointTransactionType.EARN,
        points,
        balanceAfter: user.loyaltyPoints,
        orderId: order.id,
      },
    });
    return points;
  }

  // ---------------- Kiểm tra quyền dùng voucher (gọi lúc tạo đơn / áp mã) ----------------
  // Mã thường: bỏ qua. Mã reward-only: user phải có ít nhất 1 voucher chưa dùng.
  async assertVoucherUsable(userId: string, code: string): Promise<void> {
    const promo = await this.prisma.promotion.findUnique({
      where: { code: code.trim().toUpperCase() },
    });
    if (!promo || !promo.isRewardOnly) return;

    const available = await this.prisma.userVoucher.count({
      where: { userId, promotionId: promo.id, usedAt: null },
    });
    if (available === 0) {
      throw new BadRequestException(
        'Bạn chưa sở hữu voucher này. Hãy đổi điểm tại trang Tích điểm để nhận mã.',
      );
    }
  }

  // ---------------- Đánh dấu voucher đã dùng (gọi trong transaction thanh toán thành công) ----------------
  async consumeVoucher(
    tx: Prisma.TransactionClient,
    userId: string,
    promoCode: string | null | undefined,
    orderId: string,
  ): Promise<void> {
    if (!promoCode) return;

    const promo = await tx.promotion.findUnique({
      where: { code: promoCode.trim().toUpperCase() },
    });
    if (!promo || !promo.isRewardOnly) return;

    // Dùng voucher đổi sớm nhất trước (FIFO)
    const voucher = await tx.userVoucher.findFirst({
      where: { userId, promotionId: promo.id, usedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (!voucher) {
      throw new BadRequestException('Bạn không còn voucher này để sử dụng');
    }

    const marked = await tx.userVoucher.updateMany({
      where: { id: voucher.id, usedAt: null },
      data: { usedAt: new Date(), usedOrderId: orderId },
    });
    if (marked.count === 0) {
      throw new ConflictException('Voucher vừa được sử dụng ở một đơn khác, vui lòng thử lại');
    }
  }

  // ---------------- Hoàn lại voucher khi đơn hàng bị hủy ----------------
  async restoreVoucher(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<void> {
    await tx.userVoucher.updateMany({
      where: { usedOrderId: orderId },
      data: { usedAt: null, usedOrderId: null },
    });
  }
}
