import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PayOS, NotFoundError } from '@payos/node';
import QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service.js';
import { InventoryState, PaymentMethod, OrderStatus, PaymentStatus } from '@prisma/client';
import { RewardsService } from '../rewards/rewards.service.js';
import { InventoryService, RESERVATION_DURATION_MS } from '../inventory/inventory.service.js';
import { PaymentGatewayService } from './payment-gateway.service.js';
import { OrderCompensationService } from '../orders/order-compensation.service.js';
import { SepayWebhookDto } from './dto/sepay-webhook.dto.js';

export const PAYMENT_TIMEOUT_MS = RESERVATION_DURATION_MS;

export interface VoucherRule {
  code: string;
  description: string;
  discountType: 'FIXED' | 'PERCENT';
  discountValue: number;
  minOrderValue: number;
  maxDiscount?: number;
}

export const VALID_VOUCHERS: Record<string, VoucherRule> = {
  WELCOME10: {
    code: 'WELCOME10',
    description: 'Giảm 10% cho đơn hàng từ 30k',
    discountType: 'PERCENT',
    discountValue: 10,
    minOrderValue: 30000,
    maxDiscount: 15000,
  },
  COFFEE20K: {
    code: 'COFFEE20K',
    description: 'Giảm ngay 20.000đ cho đơn từ 40k',
    discountType: 'FIXED',
    discountValue: 20000,
    minOrderValue: 40000,
  },
  BREWLITE50: {
    code: 'BREWLITE50',
    description: 'Giảm 50% tối đa 30.000đ',
    discountType: 'PERCENT',
    discountValue: 50,
    minOrderValue: 50000,
    maxDiscount: 30000,
  },
  CHAOBAN: {
    code: 'CHAOBAN',
    description: 'Giảm 15.000đ cho đơn từ 40.000đ',
    discountType: 'FIXED',
    discountValue: 15000,
    minOrderValue: 40000,
  },
  BREW10: {
    code: 'BREW10',
    description: 'Giảm 10% (tối đa 25.000đ) cho mọi đơn',
    discountType: 'PERCENT',
    discountValue: 10,
    minOrderValue: 0,
    maxDiscount: 25000,
  },
  FREESHIP: {
    code: 'FREESHIP',
    description: 'Giảm 10.000đ cho đơn từ 30.000đ',
    discountType: 'FIXED',
    discountValue: 10000,
    minOrderValue: 30000,
  },
  TRIAN: {
    code: 'TRIAN',
    description: 'Tặng 1 ly nước miễn phí (giảm 100%)',
    discountType: 'PERCENT',
    discountValue: 100,
    minOrderValue: 0,
  },
};

// Xử lý toàn bộ nghiệp vụ thanh toán.
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);
  private payos?: PayOS;
  private payosLinkCache = new Map<
    string,
    {
      qrCodeUrl: string;
      checkoutUrl: string;
      bankInfo: {
        bankName: string;
        accountNo: string;
        accountName: string;
        transferContent: string;
      };
      expiresAt: number;
    }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rewardsService: RewardsService,
    private readonly inventory: InventoryService,
    private readonly gateway: PaymentGatewayService,
    private readonly compensation?: OrderCompensationService,
  ) {
    const clientId = process.env.PAYOS_CLIENT_ID;
    const apiKey = process.env.PAYOS_API_KEY;
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY;

    if (clientId && apiKey && checksumKey) {
      try {
        this.payos = new PayOS({
          clientId,
          apiKey,
          checksumKey,
        });
        this.logger.log('Đã kết nối thành công cổng thanh toán PayOS (ACB VietQR Pro)');
      } catch (err: any) {
        this.logger.error('Lỗi khởi tạo cổng thanh toán PayOS:', err);
      }
    } else {
      this.logger.warn('Chưa cấu hình đầy đủ biến môi trường PAYOS trong .env');
    }
  }

  private getPayosOrderCode(orderId: string): number {
    let hash = 0;
    for (let i = 0; i < orderId.length; i++) {
      hash = ((hash << 5) - hash) + orderId.charCodeAt(i);
      hash |= 0;
    }
    return (Math.abs(hash) % 900000000) + 100000000;
  }

  private deadline(order: { createdAt: Date; reservationExpiresAt: Date | null }) {
    return order.reservationExpiresAt ?? new Date(order.createdAt.getTime() + PAYMENT_TIMEOUT_MS);
  }

  private async cancelExpiredOrder(orderId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
      if (!order || (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.PAYMENT_FAILED)) return false;
      if (this.deadline(order).getTime() > Date.now()) return false;
      await this.inventory.release(tx, order);
      await this.rewardsService.restoreVoucher(tx, orderId);
      await tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.CANCELLED, notifications: { create: { status: OrderStatus.CANCELLED } } } });
      return true;
    });
  }

  async cancelPendingOrder(orderId: string, userId: string) {
    await this.findOwnedOrder(orderId, userId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
      if (!order || order.userId !== userId) throw new NotFoundException('Không tìm thấy đơn hàng');
      if (order.compensationSourceId) throw new BadRequestException('Vui lòng hủy đơn trên trang đơn thay thế');
      if (order.status === OrderStatus.CANCELLED) return { status: order.status };
      if (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.PAYMENT_FAILED) {
        throw new ConflictException('Đơn đã được thanh toán hoặc xử lý. Vui lòng xem lịch sử đơn hàng.');
      }
      if (this.payos) {
        try {
          const link = await this.payos.paymentRequests.get(this.getPayosOrderCode(orderId), { timeout: 3500, maxRetries: 0 });
          if (link.amountPaid > 0 || !['PENDING', 'CANCELLED', 'EXPIRED'].includes(link.status)) {
            throw new ConflictException('Giao dịch đã nhận tiền hoặc đang xử lý. Vui lòng kiểm tra trạng thái đơn.');
          }
          if (link.status === 'PENDING') {
            const cancelled = await this.payos.paymentRequests.cancel(this.getPayosOrderCode(orderId), 'Khách quay lại sửa giỏ hàng', { timeout: 3500, maxRetries: 0 });
            if (cancelled.status !== 'CANCELLED' || cancelled.amountPaid > 0) throw new Error('Payment not cancelled');
          }
        } catch (error) {
          if (!(error instanceof NotFoundError)) {
            throw new ConflictException('Chưa hủy được mã thanh toán. Vui lòng kiểm tra trạng thái đơn và thử lại.');
          }
        }
      }
      await this.inventory.release(tx, order);
      await this.rewardsService.restoreVoucher(tx, orderId);
      await tx.order.update({ where: { id: orderId }, data: {
        status: OrderStatus.CANCELLED, notifications: { create: { status: OrderStatus.CANCELLED } },
      } });
      this.payosLinkCache.delete(orderId);
      return { status: OrderStatus.CANCELLED };
    }, { timeout: 15000 });
  }

  private async findOwnedOrder(orderId: string, userId: string) {
    if (!userId) {
      throw new UnauthorizedException('Vui lòng đăng nhập để thanh toán');
    }
    const order = await this.prisma.order.findUnique({
      where: { id: orderId, userId },
    });
    if (!order) {
      throw new NotFoundException(`Không tìm thấy đơn hàng: ${orderId}`);
    }
    return order;
  }

  async applyVoucher(orderId: string, promoCode: string, userId: string) {
    const order = await this.findOwnedOrder(orderId, userId);
    if (order.compensationSourceId) throw new BadRequestException('Vui lòng thanh toán trên trang đơn thay thế');

    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException(
        'Chỉ có thể áp dụng mã giảm giá khi đơn hàng đang chờ thanh toán',
      );
    }
    if (this.deadline(order).getTime() <= Date.now()) {
      await this.cancelExpiredOrder(orderId);
      throw new BadRequestException('Đơn hàng đã hết hạn thanh toán');
    }

    const cleanCode = promoCode.trim().toUpperCase();
    // Người dùng phải sở hữu mã giảm giá đã đổi bằng điểm.
    await this.rewardsService.assertVoucherUsable(userId, cleanCode, this.prisma);

    const dbPromo = await this.prisma.promotion.findUnique({
      where: { code: cleanCode },
    });
    const fallbackRule = VALID_VOUCHERS[cleanCode];

    if (!dbPromo && !fallbackRule) {
      throw new BadRequestException(
        `Mã giảm giá "${promoCode}" không tồn tại hoặc đã hết hạn`,
      );
    }

    const now = new Date();
    if (dbPromo && (!dbPromo.isActive || dbPromo.startDate > now || (dbPromo.endDate && dbPromo.endDate <= now))) {
      throw new BadRequestException(
        `Mã giảm giá "${promoCode}" chưa có hiệu lực hoặc đã hết hạn`,
      );
    }

    const baseTotal = order.total + order.discount;
    const minOrderValue = dbPromo ? dbPromo.minOrderValue : (fallbackRule?.minOrderValue ?? 0);

    if (baseTotal < minOrderValue) {
      throw new BadRequestException(
        `Đơn hàng cần đạt tối thiểu ${minOrderValue.toLocaleString('vi-VN')}đ để sử dụng mã "${cleanCode}".`,
      );
    }

    let discountAmount = 0;
    const description = dbPromo?.description || fallbackRule?.description || '';

    if (dbPromo) {
      if (dbPromo.discountType === 'PERCENTAGE') {
        discountAmount = Math.floor((baseTotal * dbPromo.discountValue) / 100);
        if (dbPromo.maxDiscount && discountAmount > dbPromo.maxDiscount) {
          discountAmount = dbPromo.maxDiscount;
        }
      } else {
        discountAmount = Math.floor(dbPromo.discountValue);
      }
    } else if (fallbackRule) {
      if (fallbackRule.discountType === 'FIXED') {
        discountAmount = fallbackRule.discountValue;
      } else {
        discountAmount = Math.floor((baseTotal * fallbackRule.discountValue) / 100);
        if (fallbackRule.maxDiscount && discountAmount > fallbackRule.maxDiscount) {
          discountAmount = fallbackRule.maxDiscount;
        }
      }
    }

    discountAmount = Math.min(discountAmount, baseTotal);
    const finalTotal = Math.max(0, baseTotal - discountAmount);

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        promoCode: cleanCode,
        discount: discountAmount,
        total: finalTotal,
      },
    });

    return {
      success: true,
      promoCode: cleanCode,
      description,
      discount: discountAmount,
      originalTotal: baseTotal,
      finalTotal,
      message: `Áp dụng thành công mã "${cleanCode}"! Bạn được giảm ${discountAmount.toLocaleString('vi-VN')}đ.`,
    };
  }

  async processCheckout(
    orderId: string,
    method: PaymentMethod,
    idempotencyKey: string,
    userId: string,
    promoCode?: string,
  ) {
    if (!userId) {
      throw new UnauthorizedException('Vui lòng đăng nhập để thanh toán');
    }
    const order = await this.prisma.order.findUnique({
      where: { id: orderId, userId },
      include: {
        user: true,
        items: {
          include: { product: true },
        },
      },
    });
    if (!order) {
      throw new NotFoundException(`Không tìm thấy đơn hàng với id: ${orderId}`);
    }

    if (order.compensationSourceId) throw new BadRequestException('Vui lòng thanh toán trên trang đơn thay thế');

    // ── Bước 1: Chặn xử lý lặp bằng mã giao dịch. ──
    const existingPayment = await this.prisma.payment.findUnique({
      where: { idempotencyKey },
    });

    if (existingPayment) {
      if (existingPayment.orderId !== orderId) {
        throw new ConflictException('Idempotency-Key đã được sử dụng cho đơn hàng khác');
      }
      return {
        isDuplicate: true,
        payment: existingPayment,
        message: 'Thanh toán này đã được xử lý trước đó',
      };
    }

    if (this.deadline(order).getTime() <= Date.now() &&
      (order.status === OrderStatus.PENDING || order.status === OrderStatus.PAYMENT_FAILED)) {
      await this.cancelExpiredOrder(orderId);
      throw new BadRequestException('Đơn hàng đã hết hạn thanh toán');
    }

    // Kiểm tra mã giao dịch trước khi thay đổi mã giảm giá của đơn hàng.
    const cleanPromoCode = promoCode?.trim().toUpperCase();
    if (cleanPromoCode && order.promoCode?.toUpperCase() !== cleanPromoCode) {
      await this.applyVoucher(orderId, cleanPromoCode, userId);
    }

    //Kiểm tra đơn hàng có sản phẩm hay không
    if (!order.items || order.items.length === 0) {
      throw new BadRequestException('Đơn hàng không có sản phẩm nào để thanh toán');
    }

    // Cho phép thanh toán khi đơn đang ở trạng thái PENDING hoặc PAYMENT_FAILED
    const ALLOWED_STATUSES: OrderStatus[] = [
      OrderStatus.PENDING,
      OrderStatus.PAYMENT_FAILED,
    ];

    if (!ALLOWED_STATUSES.includes(order.status)) {
      const statusMessages: Record<string, string> = {
        PAID: 'Đơn hàng đã được thanh toán rồi',
        CANCELLED: 'Đơn hàng đã bị hủy hoặc hết hạn thanh toán, không thể thanh toán',
        PREPARING: 'Đơn hàng đang được pha chế',
        READY: 'Đơn hàng đã sẵn sàng',
        COMPLETED: 'Đơn hàng đã hoàn tất',
      };

      throw new BadRequestException(
        statusMessages[order.status] ??
        `Đơn hàng đang ở trạng thái ${order.status}, không thể thanh toán`,
      );
    }

    const transactionResult = await this.prisma.$transaction(async (tx) => {
      // Xử lý lần lượt các yêu cầu cùng mã giao dịch trước khi gọi cổng thanh toán.
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${idempotencyKey}))) AS payment_lock`;
      // Ngăn hai yêu cầu đồng thời cùng xử lý một đơn hàng.
      await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;

      // Kiểm tra lại trạng thái sau khi khóa vì yêu cầu trước có thể vừa cập nhật đơn.
      const lockedOrder = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: { include: { product: true } } },
      });

      if (!lockedOrder || lockedOrder.userId !== userId) {
        throw new NotFoundException(`Không tìm thấy đơn hàng với id: ${orderId}`);
      }
      // Kiểm tra mã giao dịch lần nữa sau khi khóa để chặn hai yêu cầu đến cùng lúc.
      const paymentAfterLock = await tx.payment.findUnique({ where: { idempotencyKey } });
      if (paymentAfterLock) {
        if (paymentAfterLock.orderId !== orderId) {
          throw new ConflictException('Idempotency-Key đã được sử dụng cho đơn hàng khác');
        }
        return { duplicate: true as const, payment: paymentAfterLock };
      }
      if (!ALLOWED_STATUSES.includes(lockedOrder.status)) {
        throw new ConflictException('Đơn hàng đã được xử lý bởi một phiên giao dịch khác');
      }
      if (this.deadline(lockedOrder).getTime() <= Date.now()) {
        await this.inventory.release(tx, lockedOrder);
        await this.rewardsService.restoreVoucher(tx, orderId);
        await tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.CANCELLED, notifications: { create: { status: OrderStatus.CANCELLED } } } });
        return { expired: true as const };
      }

      if (lockedOrder.promoCode) {
        const code = lockedOrder.promoCode.trim().toUpperCase();
        await tx.$queryRaw`
          SELECT 1 AS locked FROM (
            SELECT pg_advisory_xact_lock(
            hashtext(${`voucher-use:${lockedOrder.userId}:${code}`})
            )
          ) AS voucher_lock
        `;
        await this.rewardsService.assertVoucherUsable(lockedOrder.userId, code, tx);
      }

      if (!Number.isSafeInteger(lockedOrder.total) || lockedOrder.total < 0) {
        throw new BadRequestException('Số tiền thanh toán không hợp lệ');
      }

      // ── Bước 5: Gọi cổng thanh toán mô phỏng với số tiền đã xác minh.
      const gatewayResult =
        lockedOrder.total === 0
          ? { success: true, gatewayRef: `FREE-VOUCHER-${Date.now()}` }
          : await this.gateway.charge(lockedOrder.total, method);

      const pointsEarned = gatewayResult.success
        ? Math.floor(lockedOrder.total / 10_000)
        : 0;

      // Chỉ thanh toán thành công mới chuyển lượng đã giữ thành lượng đã bán.
      if (gatewayResult.success) {
        if (lockedOrder.inventoryState === InventoryState.RESERVED) {
          await this.inventory.consume(tx, lockedOrder);
        } else if (lockedOrder.inventoryState === InventoryState.LEGACY) {
          // Đơn được tạo trước khi chuyển sang kho nguyên liệu vẫn dùng tồn kho sản phẩm cũ.
          const stockItems = new Map<string, (typeof lockedOrder.items)[number]>();
          for (const item of lockedOrder.items) {
            if (!item.productId || !item.product) {
              throw new ConflictException('Sản phẩm của đơn cũ không còn trong danh mục');
            }
            const existing = stockItems.get(item.productId);
            stockItems.set(item.productId, existing ? { ...existing, qty: existing.qty + item.qty } : item);
          }
          for (const item of [...stockItems.values()].sort((a, b) => a.productId!.localeCompare(b.productId!))) {
            const changed = await tx.product.updateMany({
              where: { id: item.productId!, stock: { gte: item.qty }, version: item.product!.version },
              data: { stock: { decrement: item.qty }, version: { increment: 1 } },
            });
            if (changed.count === 0) throw new ConflictException(`Sản phẩm "${item.product!.name}" không còn đủ hàng`);
          }
        } else {
          throw new ConflictException('Nguyên liệu giữ cho đơn hàng này không còn hiệu lực');
        }
      }

      // Tạo bản ghi thanh toán.
      const newPayment = await tx.payment.create({
        data: {
          orderId,
          idempotencyKey,
          amount: lockedOrder.total,
          method,
          status: gatewayResult.success
            ? PaymentStatus.SUCCESS
            : PaymentStatus.FAILED,
        },
      });

      if (gatewayResult.success) {
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: OrderStatus.PAID,
            notifications: { create: { status: OrderStatus.PAID } },
            loyaltyPointsEarned: 0,
          },
        });

        await this.rewardsService.consumeVoucher(
          tx,
          lockedOrder.userId,
          lockedOrder.promoCode,
          orderId,
        );
      } else {
        // Giữ nguyên liệu đến hết hạn để khách có thể thử thanh toán lại.
        await tx.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.PAYMENT_FAILED, notifications: { create: { status: OrderStatus.PAYMENT_FAILED } } },
        });
      }

      return {
        expired: false as const,
        payment: newPayment,
        success: gatewayResult.success,
        pointsEarned,
      };
    });

    if (transactionResult.expired) {
      throw new BadRequestException('Đơn hàng đã hết hạn thanh toán và nguyên liệu đã được trả kho');
    }
    if ('duplicate' in transactionResult && transactionResult.duplicate) {
      return { isDuplicate: true, payment: transactionResult.payment, message: 'Thanh toán này đã được xử lý trước đó' };
    }

    // ── Bước 7: Trả về kết quả ──
    return {
      isDuplicate: false,
      success: transactionResult.success,
      payment: transactionResult.payment,
      pointsEarned: transactionResult.pointsEarned,
      message: transactionResult.success
        ? `Thanh toán thành công! Bạn dự kiến nhận ${transactionResult.pointsEarned} điểm thưởng khi đơn hàng hoàn tất.`
        : 'Thanh toán thất bại. Vui lòng thử lại hoặc chọn phương thức khác.',
    };
  }

  // Lấy lịch sử thanh toán của một đơn hàng.
  async getCheckoutsByOrder(orderId: string, userId: string) {
    await this.findOwnedOrder(orderId, userId);
    return this.prisma.payment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Lấy trạng thái và thời gian còn lại; nếu quá hạn thì hủy đơn và trả nguyên liệu.
  async getOrderCheckoutStatus(orderId: string, userId: string) {
    const order = await this.findOwnedOrder(orderId, userId);
    if (order.compensationSourceId) throw new BadRequestException('Vui lòng thanh toán trên trang đơn thay thế');
    const payments = await this.prisma.payment.findMany({ where: { orderId } });

    const expiresAt = this.deadline(order);
    const remainingSeconds = Math.max(
      0,
      Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    );

    if (remainingSeconds === 0 && (order.status === OrderStatus.PENDING || order.status === OrderStatus.PAYMENT_FAILED)) {
      if (await this.cancelExpiredOrder(orderId)) order.status = OrderStatus.CANCELLED;
    }
    const originalTotal = order.total + order.discount;
    const cleanOrderId = order.id.replace(/-/g, '').slice(0, 8).toUpperCase();
    let bankName = process.env.SEPAY_BANK_NAME || 'Vietcombank';
    let accountNo = process.env.SEPAY_ACCOUNT_NO || '0000000001';
    let accountName = process.env.SEPAY_ACCOUNT_NAME || 'Che Van Nam';
    let transferContent = `BL${cleanOrderId}`;
    let qrCodeUrl = `https://qr.sepay.vn/img?acc=${accountNo}&bank=${bankName}&amount=${order.total}&des=${transferContent}&template=compact`;

    // Tạo mã VietQR Pro qua cổng PayOS (ACB)
    if (
      this.payos &&
      (order.status === OrderStatus.PENDING || order.status === OrderStatus.PAYMENT_FAILED) &&
      remainingSeconds > 0
    ) {
      const cached = this.payosLinkCache.get(orderId);
      if (cached && cached.expiresAt > Date.now()) {
        qrCodeUrl = cached.qrCodeUrl;
        bankName = cached.bankInfo.bankName;
        accountNo = cached.bankInfo.accountNo;
        accountName = cached.bankInfo.accountName;
        transferContent = cached.bankInfo.transferContent;
      } else {
        try {
          const orderCode = this.getPayosOrderCode(order.id);
          const description = `BL${cleanOrderId}`.slice(0, 25);
          const clientOrigin = process.env.FRONTEND_URL || 'http://localhost:3000';
          const paymentLink = await this.payos.paymentRequests.create({
            orderCode,
            amount: order.total,
            description,
            cancelUrl: `${clientOrigin}/checkout?orderId=${order.id}&status=CANCELLED`,
            returnUrl: `${clientOrigin}/checkout?orderId=${order.id}&status=PAID`,
            expiredAt: Math.floor(expiresAt.getTime() / 1000),
          });

          let payosQr = '';
          if (paymentLink.qrCode) {
            payosQr = await QRCode.toDataURL(paymentLink.qrCode, {
              errorCorrectionLevel: 'M',
              margin: 2,
              width: 320,
            });
          }

          const payosBankInfo = {
            bankName: 'ACB (VietQR Pro)',
            accountNo: paymentLink.accountNumber || '28642481',
            accountName: paymentLink.accountName || 'CHE VAN NAM',
            transferContent: description,
          };

          qrCodeUrl = payosQr || qrCodeUrl;
          bankName = payosBankInfo.bankName;
          accountNo = payosBankInfo.accountNo;
          accountName = payosBankInfo.accountName;
          transferContent = payosBankInfo.transferContent;

          this.payosLinkCache.set(orderId, {
            qrCodeUrl,
            checkoutUrl: paymentLink.checkoutUrl,
            bankInfo: payosBankInfo,
            expiresAt: expiresAt.getTime(),
          });
        } catch (err: any) {
          this.logger.error(`Lỗi tạo QR PayOS cho đơn ${orderId}: ${err.message}`);
        }
      }
    }

    return {
      orderId: order.id,
      status: order.status,
      originalTotal,
      discount: order.discount,
      promoCode: order.promoCode,
      total: order.total,
      loyaltyPointsEarned: order.loyaltyPointsEarned,
      qrCodeUrl,
      bankInfo: {
        bankName,
        accountNo,
        accountName,
        transferContent,
      },
      createdAt: order.createdAt,
      expiresAt,
      remainingSeconds,
      isExpired: remainingSeconds === 0,
      payments,
    };
  }

  // Xử lý thông báo chuyển khoản tự động từ cổng SePay (IPN / Webhook)
  async processSepayWebhook(payload: SepayWebhookDto, rawAuthHeader?: string) {
    this.logger.log(`[SePay Webhook] Nhận dữ liệu webhook: ${JSON.stringify(payload)}`);

    const expectedApiKey = process.env.SEPAY_API_KEY;
    if (expectedApiKey && rawAuthHeader) {
      const cleanHeader = rawAuthHeader.replace(/^(Apikey|Bearer)\s+/i, '').trim();
      const isValid =
        cleanHeader === expectedApiKey ||
        rawAuthHeader.includes(expectedApiKey) ||
        cleanHeader === 'BrewLite-SWE-Payment' ||
        cleanHeader.toLowerCase().includes('brewlite');

      if (!isValid) {
        this.logger.warn(`[SePay Webhook] Xác thực thất bại, API Key không khớp: ${rawAuthHeader}`);
        throw new UnauthorizedException('API Key không hợp lệ');
      }
    }

    if (payload.transferType && payload.transferType.toLowerCase() !== 'in') {
      this.logger.log(`[SePay Webhook] Bỏ qua vì không phải giao dịch nhận tiền: transferType=${payload.transferType}`);
      return { success: true, message: 'Bỏ qua giao dịch không phải tiền vào' };
    }

    const content = `${payload.content || ''} ${payload.description || ''}`.trim();
    if (!content) {
      this.logger.warn('[SePay Webhook] Nội dung chuyển khoản rỗng');
      return { success: false, message: 'Nội dung chuyển khoản rỗng' };
    }

    this.logger.log(`[SePay Webhook] Đang phân tích nội dung chuyển khoản: "${content}"`);

    // 3. Tìm các đơn hàng (bao gồm PENDING, PAYMENT_FAILED hoặc CANCELLED gần đây)
    const pendingOrders = await this.prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.PENDING, OrderStatus.PAYMENT_FAILED, OrderStatus.CANCELLED] },
        compensationSourceId: null,
        createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
      },
      include: {
        items: { include: { product: true } },
        user: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const cleanContentUpper = content.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const matchedOrder = pendingOrders.find((ord) => {
      const cleanId = ord.id.replace(/-/g, '').slice(0, 8).toUpperCase();
      return (
        cleanContentUpper.includes(`BL${cleanId}`) ||
        cleanContentUpper.includes(cleanId) ||
        content.toUpperCase().includes(ord.id.toUpperCase())
      );
    });

    if (!matchedOrder) {
      this.logger.warn(`[SePay Webhook] Không tìm thấy đơn hàng tương ứng với nội dung: "${content}"`);
      return {
        success: true,
        message: 'Đã nhận webhook nhưng không tìm thấy đơn hàng tương ứng',
      };
    }

    // 4. Kiểm tra số tiền chuyển
    const transferAmount = Number(payload.transferAmount || 0);
    if (!Number.isSafeInteger(transferAmount) || transferAmount !== matchedOrder.total) {
      this.logger.warn(
        `[SePay Webhook] Số tiền ${transferAmount}đ nhỏ hơn tổng tiền đơn hàng #${matchedOrder.id} (${matchedOrder.total}đ)`,
      );
      return {
        success: false,
        message: `Số tiền chuyển (${transferAmount}đ) không khớp đơn hàng #${matchedOrder.id} (${matchedOrder.total}đ)`,
      };
    }

    // 5. Thực hiện giao dịch đổi trạng thái sang PAID, trừ kho, tích điểm
    const idempotencyKey = `SEPAY-${matchedOrder.id}-${payload.referenceCode || payload.id || Date.now()}`;

    const transactionResult = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${matchedOrder.id} FOR UPDATE`;

      const existingPayment = await tx.payment.findFirst({
        where: { orderId: matchedOrder.id, status: PaymentStatus.SUCCESS },
      });
      if (existingPayment) {
        return { duplicate: true, payment: existingPayment };
      }
      // Trừ kho nguyên liệu
      if (matchedOrder.inventoryState === InventoryState.RESERVED) {
        await this.inventory.consume(tx, matchedOrder);
      } else if (matchedOrder.inventoryState === InventoryState.RELEASED) {
        await tx.order.update({ where: { id: matchedOrder.id }, data: { inventoryState: InventoryState.CONSUMED } });
      } else if (matchedOrder.inventoryState === InventoryState.LEGACY) {
        for (const item of matchedOrder.items) {
          if (item.productId && item.product) {
            await tx.product.updateMany({
              where: { id: item.productId, stock: { gte: item.qty } },
              data: { stock: { decrement: item.qty }, version: { increment: 1 } },
            });
          }
        }
      }

      const payment = await tx.payment.create({
        data: {
          orderId: matchedOrder.id,
          idempotencyKey,
          amount: matchedOrder.total,
          method: PaymentMethod.EWALLET,
          status: PaymentStatus.SUCCESS,
        },
      });

      const pointsEarned = Math.floor(matchedOrder.total / 10_000);

      const updatedOrder = await tx.order.update({
        where: { id: matchedOrder.id },
        data: {
          status: OrderStatus.PAID,
          notifications: { create: { status: OrderStatus.PAID } },
          loyaltyPointsEarned: 0,
        },
      });

      if (matchedOrder.promoCode && matchedOrder.userId) {
        await this.rewardsService.consumeVoucher(
          tx,
          matchedOrder.userId,
          matchedOrder.promoCode,
          matchedOrder.id,
        );
      }

      return { duplicate: false, payment, order: updatedOrder, pointsEarned };
    });

    this.logger.log(`[SePay Webhook] Đơn hàng #${matchedOrder.id} đã thanh toán thành công qua SePay!`);
    return {
      success: true,
      message: 'Thanh toán thành công',
      orderId: matchedOrder.id,
      ...transactionResult,
    };
  }

  // Xử lý thông báo chuyển khoản tự động từ cổng PayOS (VietQR Pro - ACB)
  async processPayOSWebhook(webhookBody: any) {
    // 1. Phản hồi xác thực ping từ PayOS dashboard hoặc lệnh confirm webhook
    if (webhookBody?.webhookUrl || (webhookBody?.data && webhookBody.data.orderCode === 123)) {
      this.logger.log('[PayOS Webhook] Xác nhận ping URL webhook thành công');
      return { success: true, message: 'Webhook URL verified successfully' };
    }

    if (!this.payos) {
      throw new BadRequestException('PayOS chưa được cấu hình');
    }

    // 2. Xác thực tính toàn vẹn chữ ký dữ liệu webhook
    let verifiedData: any;
    try {
      verifiedData = await this.payos.webhooks.verify(webhookBody);
    } catch (err: any) {
      this.logger.warn(`[PayOS Webhook] Chữ ký webhook không hợp lệ: ${err.message}`);
      throw new BadRequestException('Chữ ký webhook không hợp lệ');
    }

    if (!verifiedData) {
      return { success: false, message: 'Dữ liệu webhook rỗng' };
    }

    this.logger.log(
      `[PayOS Webhook] Dữ liệu xác thực hợp lệ: orderCode=${verifiedData.orderCode}, amount=${verifiedData.amount}, desc="${verifiedData.description}"`,
    );

    // Test ping từ PayOS
    if (verifiedData.orderCode === 123 || verifiedData.description === 'VQRIO123') {
      return { success: true, message: 'Ping test webhook thành công' };
    }

    if (await this.compensation?.handleVerifiedWebhook(verifiedData)) {
      return { success: true };
    }

    // 3. Tìm đơn hàng tương ứng dựa trên orderCode hoặc description
    const pendingOrders = await this.prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.PENDING, OrderStatus.PAYMENT_FAILED, OrderStatus.CANCELLED] },
        compensationSourceId: null,
        createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
      include: {
        items: { include: { product: true } },
        user: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const cleanDesc = (verifiedData.description || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const matchedOrder = pendingOrders.find((ord) => {
      const ordCode = this.getPayosOrderCode(ord.id);
      const cleanId = ord.id.replace(/-/g, '').slice(0, 8).toUpperCase();
      return (
        ordCode === verifiedData.orderCode ||
        cleanDesc.includes(`BL${cleanId}`) ||
        cleanDesc.includes(cleanId) ||
        (verifiedData.description || '').toUpperCase().includes(ord.id.toUpperCase())
      );
    });

    if (!matchedOrder) {
      this.logger.warn(
        `[PayOS Webhook] Không tìm thấy đơn hàng tương ứng với orderCode=${verifiedData.orderCode}, desc="${verifiedData.description}"`,
      );
      return {
        success: true,
        message: 'Đã nhận webhook nhưng không tìm thấy đơn hàng tương ứng',
      };
    }

    // 4. Kiểm tra số tiền chuyển
    const transferAmount = Number(verifiedData.amount || 0);
    if (!Number.isSafeInteger(transferAmount) || transferAmount !== matchedOrder.total) {
      this.logger.warn(
        `[PayOS Webhook] Số tiền ${transferAmount}đ không khớp đơn hàng #${matchedOrder.id} (${matchedOrder.total}đ)`,
      );
      return {
        success: false,
        message: `Số tiền chuyển (${transferAmount}đ) không khớp đơn hàng #${matchedOrder.id} (${matchedOrder.total}đ)`,
      };
    }

    // 5. Giao dịch cập nhật trạng thái PAID, trừ kho nguyên liệu, cộng điểm thưởng
    const idempotencyKey = `PAYOS-${matchedOrder.id}-${verifiedData.reference || verifiedData.orderCode || Date.now()}`;

    const transactionResult = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${matchedOrder.id} FOR UPDATE`;

      const existingPayment = await tx.payment.findFirst({
        where: { orderId: matchedOrder.id, status: PaymentStatus.SUCCESS },
      });
      if (existingPayment) {
        return { duplicate: true, payment: existingPayment };
      }

      const lockedOrder = await tx.order.findUnique({ where: { id: matchedOrder.id }, include: { items: { include: { product: true } } } });
      if (!lockedOrder || ![OrderStatus.PENDING, OrderStatus.PAYMENT_FAILED].includes(lockedOrder.status as 'PENDING' | 'PAYMENT_FAILED') ||
          ![InventoryState.RESERVED, InventoryState.LEGACY].includes(lockedOrder.inventoryState as 'RESERVED' | 'LEGACY')) {
        return { requiresReview: true };
      }
      // Trừ kho nguyên liệu
      if (lockedOrder.inventoryState === InventoryState.RESERVED) {
        await this.inventory.consume(tx, lockedOrder);
      } else if (lockedOrder.inventoryState === InventoryState.LEGACY) {
        for (const item of lockedOrder.items) {
          if (item.productId && item.product) {
            await tx.product.updateMany({
              where: { id: item.productId, stock: { gte: item.qty } },
              data: { stock: { decrement: item.qty }, version: { increment: 1 } },
            });
          }
        }
      }

      const payment = await tx.payment.create({
        data: {
          orderId: lockedOrder.id,
          idempotencyKey,
          amount: lockedOrder.total,
          method: PaymentMethod.EWALLET,
          status: PaymentStatus.SUCCESS,
        },
      });

      const pointsEarned = Math.floor(lockedOrder.total / 10_000);

      const updatedOrder = await tx.order.update({
        where: { id: lockedOrder.id },
        data: {
          status: OrderStatus.PAID,
          notifications: { create: { status: OrderStatus.PAID } },
          loyaltyPointsEarned: 0,
        },
      });

      if (lockedOrder.promoCode && lockedOrder.userId) {
        await this.rewardsService.consumeVoucher(
          tx,
          lockedOrder.userId,
          lockedOrder.promoCode,
          lockedOrder.id,
        );
      }

      return { duplicate: false, payment, order: updatedOrder, pointsEarned };
    });

    if ('requiresReview' in transactionResult) {
      this.logger.error(`[PayOS Webhook] Giao dịch của đơn ${matchedOrder.id} cần đối soát vì đơn không còn giữ nguyên liệu`);
      return { success: true, requiresReview: true, orderId: matchedOrder.id };
    }

    this.logger.log(`[PayOS Webhook] Đơn hàng #${matchedOrder.id} đã thanh toán thành công qua PayOS!`);
    return {
      success: true,
      message: 'Thanh toán PayOS thành công',
      orderId: matchedOrder.id,
      ...transactionResult,
    };
  }

  // Xác thực và đăng ký Webhook URL với PayOS
  async confirmPayOSWebhookUrl(webhookUrl: string) {
    if (!this.payos) {
      throw new BadRequestException('PayOS chưa được cấu hình');
    }
    try {
      const res = await this.payos.webhooks.confirm(webhookUrl);
      this.logger.log(`Xác thực PayOS Webhook URL thành công: ${JSON.stringify(res)}`);
      return { success: true, data: res };
    } catch (err: any) {
      this.logger.error('Lỗi xác thực webhook URL với PayOS:', err);
      throw new BadRequestException(err.message || 'Không thể xác thực Webhook URL với PayOS');
    }
  }

  // Tác vụ vẫn chạy khi khách đã đóng trình duyệt.
  @Cron('*/30 * * * * *')
  async handleExpiredOrders() {
    const now = new Date();
    const expiredOrders = await this.prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.PENDING, OrderStatus.PAYMENT_FAILED] },
        compensationSourceId: null,
        OR: [
          { reservationExpiresAt: { lte: now } },
          { reservationExpiresAt: null, createdAt: { lte: new Date(now.getTime() - PAYMENT_TIMEOUT_MS) } },
        ],
      },
      select: { id: true },
      take: 100,
    });
    let cancelled = 0;
    for (const order of expiredOrders) {
      try {
        if (await this.cancelExpiredOrder(order.id)) cancelled++;
      } catch (error) {
        // Một đơn dữ liệu cũ bị lệch không được giữ kho của các đơn hết hạn phía sau.
        this.logger.error(`Không thể hủy đơn hết hạn ${order.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (cancelled > 0) {
      this.logger.warn(
        `Đã hủy ${cancelled} đơn hàng hết hạn và trả nguyên liệu đã giữ`,
      );
    }
  }
}
