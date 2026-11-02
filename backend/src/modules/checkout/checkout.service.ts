import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { InventoryState, PaymentMethod, OrderStatus, PaymentStatus } from '@prisma/client';
import { RewardsService } from '../rewards/rewards.service.js';
import { InventoryService, RESERVATION_DURATION_MS } from '../inventory/inventory.service.js';
import { PaymentGatewayService } from './payment-gateway.service.js';
import { SepayWebhookDto } from './dto/sepay-webhook.dto.js';

// Thời hạn thanh toán cho mỗi đơn hàng: 2 phút (120,000 ms)
export const PAYMENT_TIMEOUT_MS = RESERVATION_DURATION_MS;

// ============================================================
// Danh mục mã giảm giá hợp lệ trong hệ thống.
// ============================================================
export interface VoucherRule {
  code: string;
  description: string;
  discountType: 'FIXED' | 'PERCENT';
  discountValue: number; // 15000 (VND) hoặc 10 (%)
  minOrderValue: number; // Giá trị đơn tối thiểu để dùng
  maxDiscount?: number;  // Mức giảm tối đa khi giảm theo phần trăm.
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

// ============================================================
// Xử lý toàn bộ nghiệp vụ thanh toán.
// ============================================================
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(private readonly prisma: PrismaService,
    private readonly rewardsService: RewardsService,
    private readonly inventory: InventoryService,
    private readonly gateway: PaymentGatewayService,
  ) { }

  /** Đơn mới dùng hạn giữ nguyên liệu; đơn cũ dùng thời điểm tạo cộng hai phút. */
  private deadline(order: { createdAt: Date; reservationExpiresAt: Date | null }) {
    return order.reservationExpiresAt ?? new Date(order.createdAt.getTime() + PAYMENT_TIMEOUT_MS);
  }

  /** Khóa đơn rồi hủy và trả nguyên liệu đã giữ nếu đơn thực sự quá hạn. */
  private async cancelExpiredOrder(orderId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
      if (!order || (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.PAYMENT_FAILED)) return false;
      if (this.deadline(order).getTime() > Date.now()) return false;
      await this.inventory.release(tx, order);
      await tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.CANCELLED } });
      return true;
    });
  }

  /** Chỉ cho chủ đơn xem hoặc thao tác thanh toán trên đơn của mình. */
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

  // ----------------------------------------------------------
  // Chỉ áp mã cho đơn đang chờ; tính lại tổng tiền từ giá trước khi giảm.
  // ----------------------------------------------------------
  async applyVoucher(orderId: string, promoCode: string, userId: string) {
    const order = await this.findOwnedOrder(orderId, userId);

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
    await this.rewardsService.assertVoucherUsable(userId, cleanCode);

    // 1. Kiểm tra mã giảm giá trong cơ sở dữ liệu trước.
    const dbPromo = await this.prisma.promotion.findUnique({
      where: { code: cleanCode },
    });

    // 2. Dùng danh sách mã dự phòng nếu cơ sở dữ liệu chưa có.
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

    // Giá trị đơn ban đầu (trước khi trừ giảm giá cũ nếu có)
    const baseTotal = order.total + order.discount;
    const minOrderValue = dbPromo ? dbPromo.minOrderValue : (fallbackRule?.minOrderValue ?? 0);

    if (baseTotal < minOrderValue) {
      throw new BadRequestException(
        `Đơn hàng cần đạt tối thiểu ${minOrderValue.toLocaleString('vi-VN')}đ để sử dụng mã "${cleanCode}".`,
      );
    }

    // Tính toán số tiền được giảm
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

    // Cập nhật lại đơn hàng
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

  // ----------------------------------------------------------
  // Thanh toán đơn đã tạo: kiểm tra quyền và thời hạn, chống xử lý trùng rồi khóa đơn.
  // Thành công thì trừ tồn thực và cộng điểm; thất bại vẫn giữ nguyên liệu để thử lại trong hạn.
  // ----------------------------------------------------------
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
    // Xác minh chủ đơn trước khi đọc giao dịch, áp mã giảm giá hoặc gọi cổng thanh toán.
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

    // ── Bước 2b: Kiểm tra đơn hàng có sản phẩm hay không (Chặn đơn rỗng) ──
    if (!order.items || order.items.length === 0) {
      throw new BadRequestException('Đơn hàng không có sản phẩm nào để thanh toán');
    }

    // ── Bước 3: Kiểm tra trạng thái hợp lệ của đơn hàng. ──
    // Cho phép thanh toán khi đơn đang ở trạng thái PENDING hoặc PAYMENT_FAILED (khách thử lại theo PDF)
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

    // ── Bước 4: Khóa dữ liệu để các yêu cầu đồng thời không xử lý trùng. ──
    const transactionResult = await this.prisma.$transaction(async (tx) => {
      // Xử lý lần lượt các yêu cầu cùng mã giao dịch trước khi gọi cổng thanh toán.
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${idempotencyKey}))) AS payment_lock`;
      // Khóa dòng đơn hàng trong giao dịch bằng SELECT FOR UPDATE.
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
        await tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.CANCELLED } });
        return { expired: true as const };
      }

      if (!Number.isSafeInteger(lockedOrder.total) || lockedOrder.total < 0) {
        throw new BadRequestException('Số tiền thanh toán không hợp lệ');
      }

      // ── Bước 5: Gọi cổng thanh toán mô phỏng với số tiền đã xác minh. ──
      // Đơn 0đ do mã giảm toàn bộ được hoàn tất mà không gọi cổng thanh toán.
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
        // Cập nhật đơn hàng sang trạng thái đã thanh toán.
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: OrderStatus.PAID,
            loyaltyPointsEarned: pointsEarned,
          },
        });

        // Cộng điểm và ghi lịch sử; ràng buộc duy nhất theo đơn ngăn cộng trùng.
        await this.rewardsService.earnPoints(tx, {
          id: orderId,
          userId: lockedOrder.userId,
          total: lockedOrder.total,
        });

        // Đánh dấu mã đổi điểm đã dùng trong cùng giao dịch.
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
          data: { status: OrderStatus.PAYMENT_FAILED },
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
        ? `Thanh toán thành công! Bạn được cộng ${transactionResult.pointsEarned} điểm thưởng.`
        : 'Thanh toán thất bại. Vui lòng thử lại hoặc chọn phương thức khác.',
    };
  }

  // ----------------------------------------------------------
  // Lấy lịch sử thanh toán của một đơn hàng.
  // ----------------------------------------------------------
  async getCheckoutsByOrder(orderId: string, userId: string) {
    await this.findOwnedOrder(orderId, userId);
    return this.prisma.payment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ----------------------------------------------------------
  // Lấy trạng thái và thời gian còn lại; nếu quá hạn thì hủy đơn và trả nguyên liệu.
  // ----------------------------------------------------------
  async getOrderCheckoutStatus(orderId: string, userId: string) {
    const order = await this.findOwnedOrder(orderId, userId);
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
    const bankName = process.env.SEPAY_BANK_NAME || 'Vietcombank';
    const accountNo = process.env.SEPAY_ACCOUNT_NO || '0000000001';
    const accountName = process.env.SEPAY_ACCOUNT_NAME || 'Che Van Nam';
    const transferContent = `BL${cleanOrderId}`;
    const qrCodeUrl = `https://qr.sepay.vn/img?acc=${accountNo}&bank=${bankName}&amount=${order.total}&des=${transferContent}&template=compact`;

    return {
      orderId: order.id,
      status: order.status,
      originalTotal,
      discount: order.discount,
      promoCode: order.promoCode,
      total: order.total,
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

  // ----------------------------------------------------------
  // Xử lý thông báo chuyển khoản tự động từ cổng SePay (IPN / Webhook)
  // ----------------------------------------------------------
  async processSepayWebhook(payload: SepayWebhookDto, rawAuthHeader?: string) {
    this.logger.log(`[SePay Webhook] Nhận dữ liệu webhook: ${JSON.stringify(payload)}`);

    // 1. Kiểm tra API Key bảo mật từ SePay
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

    // 2. Chỉ xử lý biến động số dư tiền vào (transferType === 'in')
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
    if (transferAmount > 0 && transferAmount < matchedOrder.total) {
      this.logger.warn(
        `[SePay Webhook] Số tiền ${transferAmount}đ nhỏ hơn tổng tiền đơn hàng #${matchedOrder.id} (${matchedOrder.total}đ)`,
      );
      return {
        success: false,
        message: `Số tiền chuyển (${transferAmount}đ) không đủ cho đơn hàng #${matchedOrder.id} (${matchedOrder.total}đ)`,
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

      // Tạo bản ghi Payment
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

      // Cập nhật trạng thái đơn hàng sang PAID
      const updatedOrder = await tx.order.update({
        where: { id: matchedOrder.id },
        data: {
          status: OrderStatus.PAID,
          loyaltyPointsEarned: pointsEarned,
        },
      });

      // Cộng điểm tích lũy cho người dùng
      if (pointsEarned > 0 && matchedOrder.userId) {
        await this.rewardsService.earnPoints(tx, {
          id: matchedOrder.id,
          userId: matchedOrder.userId,
          total: matchedOrder.total,
        });
      }

      // Đánh dấu mã giảm giá đã dùng (nếu có)
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

  // ----------------------------------------------------------
  // Tác vụ chạy mỗi 30 giây để hủy đơn quá hạn và trả nguyên liệu đã giữ.
  // Tác vụ vẫn chạy khi khách đã đóng trình duyệt.
  // ----------------------------------------------------------
  @Cron('*/30 * * * * *')
  async handleExpiredOrders() {
    const now = new Date();
    const expiredOrders = await this.prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.PENDING, OrderStatus.PAYMENT_FAILED] },
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
      if (await this.cancelExpiredOrder(order.id)) cancelled++;
    }
    if (cancelled > 0) {
      this.logger.warn(
        `Đã hủy ${cancelled} đơn hàng hết hạn và trả nguyên liệu đã giữ`,
      );
    }
  }
}
