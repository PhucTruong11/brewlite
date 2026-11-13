import { randomInt } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PayOS, type WebhookData } from '@payos/node';
import { OrderStatus, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import QRCode from 'qrcode';
import { InventoryService } from '../inventory/inventory.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RewardsService } from '../rewards/rewards.service.js';
import { CreateOrderItemDto } from './dto/create-order.dto.js';

const DETAILS = { items: true, compensationSource: true, compensationPayosLink: true } satisfies Prisma.OrderInclude;
const COMPENSATION_PAYMENT_DURATION_MS = 5 * 60 * 1000;
type Replacement = Prisma.OrderGetPayload<{ include: typeof DETAILS }>;

@Injectable()
export class OrderCompensationService {
  private readonly logger = new Logger(OrderCompensationService.name);
  private readonly payos?: PayOS;
  private readonly payosBankInfoCache = new Map<string, { bankName: string; accountNo: string; accountName: string }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly rewards: RewardsService,
  ) {
    const { PAYOS_CLIENT_ID: clientId, PAYOS_API_KEY: apiKey, PAYOS_CHECKSUM_KEY: checksumKey } = process.env;
    if (clientId && apiKey && checksumKey) {
      this.payos = new PayOS({ clientId, apiKey, checksumKey, timeout: 3500, maxRetries: 0, logLevel: 'off' });
    }
  }

  async get(originalOrderId: string, userId: string) {
    const compensation = await this.prisma.orderCompensation.findFirst({
      where: { originalOrderId, originalOrder: { userId } },
    });
    if (!compensation) throw new NotFoundException('Không tìm thấy lượt đền bù');
    let order = await this.findCurrent(this.prisma, originalOrderId);
    if (order?.status === OrderStatus.PENDING && order.reservationExpiresAt! <= new Date()) {
      await this.expire(order.id);
      order = await this.findCurrent(this.prisma, originalOrderId);
    }
    const remainingSeconds = order?.reservationExpiresAt
      ? Math.max(0, Math.ceil((order.reservationExpiresAt.getTime() - Date.now()) / 1000))
      : 0;
    const canPay = order?.status === OrderStatus.PENDING && remainingSeconds > 0;

    if (canPay && order && !order.compensationPayosLink) {
      await this.createPayosLink(originalOrderId, userId).catch(() => null);
      order = await this.findCurrent(this.prisma, originalOrderId);
    }

    const description = order ? 'BLDB' + order.id.replace(/-/g, '').slice(0, 8).toUpperCase() : '';
    const cachedBank = order ? this.payosBankInfoCache.get(order.id) : null;
    const defaultBank = {
      bankName: 'ACB (VietQR Pro)',
      accountNo: '28642481',
      accountName: 'CHE VAN NAM',
      transferContent: description,
    };

    return {
      amount: compensation.amount,
      bankInfo: cachedBank
        ? { ...cachedBank, transferContent: description }
        : defaultBank,
      replacement: order ? {
        id: order.id,
        status: order.status,
        total: order.total,
        amountDue: order.total - compensation.amount,
        loyaltyPointsEarned: order.loyaltyPointsEarned,
        expiresAt: order.reservationExpiresAt,
        remainingSeconds,
        canPay,
        paymentLink: canPay && order.compensationPayosLink
          ? { qrCodeUrl: order.compensationPayosLink.qrCodeUrl, checkoutUrl: order.compensationPayosLink.checkoutUrl }
          : null,
      } : null,
    };
  }

  async create(originalOrderId: string, userId: string, items: CreateOrderItemDto[]) {
    await this.get(originalOrderId, userId);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${originalOrderId} FOR UPDATE`;
      const compensation = await tx.orderCompensation.findFirst({
        where: { originalOrderId, originalOrder: { userId, status: OrderStatus.CANCELLED } },
      });
      if (!compensation) throw new NotFoundException('Không tìm thấy lượt đền bù');
      const current = await this.findCurrent(tx, originalOrderId);
      if (current) {
        // Quay lại thanh toán tiếp cùng đơn; muốn đổi món phải hủy link cũ trước.
        return { id: current.id, status: current.status, difference: 0 };
      }

      const cart = await this.inventory.prepareCart(items, tx);
      const difference = cart.subtotal - compensation.amount;
      if (difference < 0) throw new BadRequestException('Hãy thêm món hoặc topping để dùng đủ giá trị đền bù');
      if (cart.shortages.length) throw new ConflictException('Một số món đã hết nguyên liệu, vui lòng chọn lại');
      await this.inventory.reserve(tx, cart);
      const order = await tx.order.create({
        data: {
          userId, total: cart.subtotal, compensationSourceId: originalOrderId, inventoryState: 'RESERVED',
          reservationExpiresAt: difference > 0 ? new Date(Date.now() + COMPENSATION_PAYMENT_DURATION_MS) : null,
          items: { create: cart.orderItems },
          ...(difference > 0 && { notifications: { create: { status: OrderStatus.PENDING } } }),
        },
        include: DETAILS,
      });
      if (difference === 0) await this.complete(tx, order, 0);
      return { id: order.id, status: difference === 0 ? OrderStatus.PAID : OrderStatus.PENDING, difference };
    });

    if (result.status === OrderStatus.PENDING && result.difference > 0) {
      await this.createPayosLink(originalOrderId, userId).catch((err) => {
        this.logger.warn('Chưa tạo trước được link PayOS: ' + err.message);
      });
    }

    return { id: result.id, status: result.status };
  }

  async createPayosLink(originalOrderId: string, userId: string) {
    const compensation = await this.prisma.orderCompensation.findFirst({
      where: { originalOrderId, originalOrder: { userId } },
    });
    if (!compensation) throw new NotFoundException('Không tìm thấy lượt đền bù');
    const replacement = await this.findCurrent(this.prisma, originalOrderId);
    if (!replacement || replacement.status !== OrderStatus.PENDING) {
      throw new ConflictException('Không có đơn thay thế đang chờ thanh toán');
    }
    return this.withLockedOrder(replacement.id, async (tx, order) => {
      if (order.status !== OrderStatus.PENDING || !order.reservationExpiresAt || order.reservationExpiresAt <= new Date()) {
        throw new ConflictException('Đơn thay thế đã hết hạn hoặc đã được thanh toán');
      }
      const existingLink = await tx.compensationPayosLink.findUnique({ where: { orderId: order.id } });
      if (existingLink) return { qrCodeUrl: existingLink.qrCodeUrl };

      const amount = order.total - order.compensationSource!.amount;
      const url = new URL('/orders/' + originalOrderId + '/replacement', process.env.FRONTEND_URL || 'http://localhost:3000');
      let orderCode = randomInt(1_000_000_000, 2_147_483_647);
      while (await tx.compensationPayosLink.findUnique({ where: { orderCode } })) {
        orderCode = randomInt(1_000_000_000, 2_147_483_647);
      }
      const description = 'BLDB' + order.id.replace(/-/g, '').slice(0, 8).toUpperCase();

      if (this.payos) {
        try {
          const link = await this.payos.paymentRequests.create({
            orderCode, amount,
            description,
            returnUrl: url.href,
            cancelUrl: url.href,
            expiredAt: Math.floor(order.reservationExpiresAt.getTime() / 1000),
          });
          if (link && link.amount === amount && link.status === 'PENDING' && link.paymentLinkId && link.qrCode) {
            this.payosBankInfoCache.set(order.id, {
              bankName: 'ACB (VietQR Pro)',
              accountNo: link.accountNumber || '28642481',
              accountName: link.accountName || 'CHE VAN NAM',
            });
            return await tx.compensationPayosLink.create({
              data: {
                id: link.paymentLinkId, orderId: order.id, orderCode, checkoutUrl: link.checkoutUrl,
                qrCodeUrl: await QRCode.toDataURL(link.qrCode, { width: 320, margin: 2 }),
              },
              select: { qrCodeUrl: true },
            });
          }
        } catch (err: any) {
          this.logger.warn(`PayOS create failed: ${err?.message || err}`);
          throw new ConflictException('Chưa tạo được mã PayOS. Vui lòng thử lại, chưa chuyển tiền.');
        }
        throw new ConflictException('PayOS chưa trả về mã thanh toán hợp lệ. Vui lòng thử lại.');
      }

      const accountNo = '28642481';
      const bankName = 'ACB';
      const fallbackQr = `https://qr.sepay.vn/img?acc=${accountNo}&bank=${bankName}&amount=${amount}&des=${description}&template=compact`;
      return tx.compensationPayosLink.create({
        data: {
          id: 'QR-' + order.id,
          orderId: order.id,
          orderCode,
          checkoutUrl: '',
          qrCodeUrl: fallbackQr,
        },
        select: { qrCodeUrl: true },
      });
    });
  }

  async cancelPendingReplacement(originalOrderId: string, userId: string) {
    const compensation = await this.prisma.orderCompensation.findFirst({
      where: { originalOrderId, originalOrder: { userId } },
    });
    if (!compensation) throw new NotFoundException('Không tìm thấy lượt đền bù');
    const current = await this.findCurrent(this.prisma, originalOrderId);
    if (current) {
      await this.withLockedOrder(current.id, async (tx, order) => {
        if (order.status === OrderStatus.CANCELLED) return;
        if (order.status !== OrderStatus.PENDING) throw new ConflictException('Đơn đã được thanh toán hoặc xử lý. Vui lòng xem lịch sử đơn hàng.');
        await this.cancelRemotePayment(order);
        await this.inventory.release(tx, order);
        await this.rewards.restoreVoucher(tx, order.id);
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.CANCELLED,
            notifications: { create: { status: OrderStatus.CANCELLED } },
          },
        });
      });
    }
    return { success: true };
  }

  async payWithCard(originalOrderId: string, userId: string, method: PaymentMethod = PaymentMethod.CARD) {
    if (method !== PaymentMethod.CARD && method !== PaymentMethod.EWALLET) throw new BadRequestException('Phương thức thanh toán không hợp lệ');
    const compensation = await this.prisma.orderCompensation.findFirst({
      where: { originalOrderId, originalOrder: { userId } },
    });
    if (!compensation) throw new NotFoundException('Không tìm thấy lượt đền bù');
    const replacement = await this.findCurrent(this.prisma, originalOrderId);
    if (!replacement || replacement.status !== OrderStatus.PENDING) {
      throw new ConflictException('Không có đơn thay thế đang chờ thanh toán');
    }
    return this.withLockedOrder(replacement.id, async (tx, order) => {
      if (order.status !== OrderStatus.PENDING || !order.reservationExpiresAt || order.reservationExpiresAt <= new Date()) {
        throw new ConflictException('Đơn thay thế đã hết hạn hoặc đã được thanh toán');
      }
      await this.cancelRemotePayment(order);
      const difference = order.total - order.compensationSource!.amount;
      await this.complete(tx, order, Math.max(0, difference), method);
      return { id: order.id, status: OrderStatus.PAID };
    });
  }

  async handleVerifiedWebhook(data: WebhookData): Promise<boolean> {
    if (!data.paymentLinkId) return false;
    const link = await this.prisma.compensationPayosLink.findUnique({ where: { id: data.paymentLinkId } });
    if (!link) return false;
    await this.withLockedOrder(link.orderId, async (tx, order) => {
      if (order.status !== OrderStatus.PENDING) return;
      const difference = order.total - order.compensationSource!.amount;
      if (data.code !== '00' || data.currency !== 'VND' || data.orderCode !== link.orderCode ||
          data.amount !== difference || difference <= 0) {
        this.logger.warn('Giao dịch PayOS không khớp đơn thay thế ' + order.id);
        return;
      }
      await this.complete(tx, order, difference);
    });
    return true;
  }

  @Cron('*/30 * * * * *')
  async expireOrders() {
    const expired = await this.prisma.order.findMany({
      where: {
        compensationSourceId: { not: null }, status: OrderStatus.PENDING,
        reservationExpiresAt: { lte: new Date() },
      },
      orderBy: { reservationExpiresAt: 'asc' },
      select: { id: true },
      take: 50,
    });
    for (const order of expired) {
      await this.expire(order.id).catch(() => this.logger.warn('Chưa đối soát được đơn thay thế ' + order.id));
    }
  }

  private async expire(id: string) {
    return this.withLockedOrder(id, async (tx, order) => {
      if (order.status !== OrderStatus.PENDING || !order.reservationExpiresAt || order.reservationExpiresAt > new Date()) return;
      const isLocalDemoLink = !this.payos && order.compensationPayosLink?.id === 'QR-' + order.id;
      if (order.compensationPayosLink && !isLocalDemoLink) {
        const payos = this.payos;
        if (!payos) return;
        const linkId = order.compensationPayosLink.id;
        let payment = await payos.paymentRequests.get(linkId).catch(() => null);
        if (payment?.status === 'PENDING' && payment.amountPaid === 0) {
          payment = await payos.paymentRequests.cancel(linkId, 'Đơn thay thế đã hết hạn').catch(() => null);
        }
        if (!payment || payment.id !== linkId) return;
        const difference = order.total - order.compensationSource!.amount;
        if (payment.status === 'PAID' && payment.amountPaid === difference && payment.amount === difference) {
          await this.complete(tx, order, difference);
          return;
        }
        if (payment.amountPaid !== 0 || !['CANCELLED', 'EXPIRED'].includes(payment.status)) return;
      }
      await this.inventory.release(tx, order);
      await this.rewards.restoreVoucher(tx, id);
      await tx.order.update({
        where: { id },
        data: { status: OrderStatus.CANCELLED, notifications: { create: { status: OrderStatus.CANCELLED } } },
      });
    });
  }

  private findCurrent(db: Prisma.TransactionClient, originalOrderId: string) {
    return db.order.findFirst({
      where: {
        compensationSourceId: originalOrderId,
        // Một đơn đã thanh toán rồi bị quầy hủy có lượt đền bù mới của riêng nó.
        // Không mở lại quyền lợi của đơn gốc để sử dụng cùng giá trị hai lần.
        OR: [
          { status: { not: OrderStatus.CANCELLED } },
          { compensationIssued: { isNot: null } },
        ],
      },
      include: { compensationPayosLink: true, items: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  private withLockedOrder<T>(id: string, operation: (tx: Prisma.TransactionClient, order: Replacement) => Promise<T>) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${id} FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id }, include: DETAILS });
      if (!order?.compensationSource) throw new NotFoundException('Không tìm thấy đơn thay thế');
      return operation(tx, order);
    }, { timeout: 12_000 });
  }

  private async cancelRemotePayment(order: Replacement) {
    if (!this.payos || !order.compensationPayosLink) return;
    const linkId = order.compensationPayosLink.id;
    try {
      const link = await this.payos.paymentRequests.get(linkId);
      if (link.id !== linkId || link.amountPaid !== 0 || !['PENDING', 'CANCELLED', 'EXPIRED'].includes(link.status)) {
        throw new Error('Payment already received or unresolved');
      }
      if (link.status === 'PENDING') {
        const cancelled = await this.payos.paymentRequests.cancel(linkId, 'Khách hủy mã để chọn món hoặc phương thức khác');
        if (cancelled.id !== linkId || cancelled.status !== 'CANCELLED' || cancelled.amountPaid !== 0) throw new Error('Payment not cancelled');
      }
    } catch {
      throw new ConflictException('Chưa xác nhận hủy mã PayOS. Vui lòng kiểm tra thanh toán và thử lại.');
    }
  }

  private async complete(tx: Prisma.TransactionClient, order: Replacement, difference: number, method: PaymentMethod = PaymentMethod.EWALLET) {
    await this.inventory.consume(tx, order);
    if (difference > 0) {
      await tx.payment.create({
        data: {
          orderId: order.id, idempotencyKey: 'COMPENSATION-' + method + '-' + order.id,
          amount: difference, method, status: PaymentStatus.SUCCESS,
        },
      });
    }
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.PAID, loyaltyPointsEarned: 0,
        notifications: { create: { status: OrderStatus.PAID } },
      },
    });
  }
}
