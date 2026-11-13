import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApplyPromotionDto } from './dto/apply-promotion.dto.js';

@Injectable()
export class PromotionsService {
  constructor(private readonly prisma: PrismaService) {}

  // Lấy tất cả mã đang active để hiển thị lên UI
  async findAll() {
    const now = new Date();
    return this.prisma.promotion.findMany({
      where: {
        isActive: true,
        isRewardOnly: false,
        startDate: { lte: now },
        OR: [{ endDate: null }, { endDate: { gt: now } }],
      },
      orderBy: { minOrderValue: 'asc' },
    });
  }

  async applyPromotion(
    dto: ApplyPromotionDto,
    client: Pick<Prisma.TransactionClient, 'promotion'> = this.prisma,
  ) {
    const { code, subtotal } = dto;

    if (!code) {
      throw new BadRequestException('Vui lòng nhập mã ưu đãi');
    }

    const promo = await client.promotion.findUnique({
      where: { code: code.trim().toUpperCase() },
    });

    const now = new Date();
    if (!promo || !promo.isActive || promo.startDate > now || (promo.endDate && promo.endDate <= now)) {
      throw new NotFoundException('Mã ưu đãi không tồn tại hoặc đã hết hạn');
    }

    if (subtotal < promo.minOrderValue) {
      throw new BadRequestException(
        `Đơn hàng tối thiểu phải từ ${promo.minOrderValue.toLocaleString('vi-VN')}đ để áp dụng mã này`
      );
    }

    let discountAmount = 0;
    if (promo.discountType === 'PERCENTAGE') {
      discountAmount = Math.floor((subtotal * promo.discountValue) / 100);
      if (promo.maxDiscount && discountAmount > promo.maxDiscount) {
        discountAmount = promo.maxDiscount;
      }
    } else if (promo.discountType === 'FIXED_AMOUNT') {
      discountAmount = promo.discountValue;
    }

    discountAmount = Math.min(discountAmount, subtotal);

    return {
      success: true,
      code: promo.code,
      discountAmount,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      minOrderValue: promo.minOrderValue,
      maxDiscount: promo.maxDiscount,
      message: 'Áp dụng mã ưu đãi thành công!',
    };
  }
}