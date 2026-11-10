import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PayOS, PaymentRequests, type WebhookData } from '@payos/node';
import { ProductSize } from '@prisma/client';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/modules/prisma/prisma.service.js';

describe('Đền bù đơn đã thanh toán', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let customerToken: string;
  let adminToken: string;
  const customerId = randomUUID();
  const adminId = randomUUID();
  const ingredientId = randomUUID();
  const originalProductId = randomUUID();
  const replacementProductId = randomUUID();
  const toppingId = randomUUID();
  const toppingName = 'Topping test ' + toppingId;
  const voucher = 'TEST' + customerId.replace(/-/g, '').toUpperCase();
  const checksumKey = 'compensation-e2e-test-checksum';
  const password = 'TestPassword123!';

  beforeAll(async () => {
    const database = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/');
    if (process.env.E2E_DATABASE !== '1' || database.pathname !== '/brewlite_test' ||
        !['localhost', '127.0.0.1'].includes(database.hostname)) {
      throw new Error('Bộ test đền bù yêu cầu E2E_DATABASE=1 và DB brewlite_test trên localhost');
    }
    vi.stubEnv('PAYOS_CLIENT_ID', 'test-client');
    vi.stubEnv('PAYOS_API_KEY', 'test-api-key');
    vi.stubEnv('PAYOS_CHECKSUM_KEY', checksumKey);
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const passwordHash = await bcrypt.hash(password, 4);
    for (const [id, role] of [[customerId, 'USER'], [adminId, 'ADMIN']] as const) {
      await prisma.user.create({ data: { id, role, email: id + '@example.test', passwordHash, emailVerifiedAt: new Date() } });
    }
    await prisma.ingredient.create({
      data: { id: ingredientId, code: 'TEST_' + ingredientId, name: 'Nguyên liệu test', unit: 'G', onHand: 100, reserved: 0 },
    });
    await prisma.product.create({
      data: { id: originalProductId, name: 'Món gốc test', category: 'other', prices: { create: { size: 'S', price: 50_000 } } },
    });
    await prisma.product.create({
      data: {
        id: replacementProductId, name: 'Món thay thế test', category: 'other', allowToppings: true,
        prices: { create: [{ size: 'S', price: 40_000 }, { size: 'M', price: 45_000 }, { size: 'L', price: 55_000 }] },
      },
    });
    await prisma.topping.create({ data: { id: toppingId, name: toppingName, price: 5_000 } });
    await prisma.recipe.createMany({
      data: [
        { productId: originalProductId, size: 'S', ingredientId, quantity: 5 },
        ...(['S', 'M', 'L'] as const).map((size) => ({ productId: replacementProductId, size, ingredientId, quantity: 5 })),
        { toppingId, ingredientId, quantity: 1 },
      ],
    });
    await prisma.promotion.create({ data: { code: voucher, discountType: 'FIXED_AMOUNT', discountValue: 5_000 } });
    customerToken = await login(customerId);
    adminToken = await login(adminId);
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!prisma) return;
    await prisma.pointTransaction.deleteMany({ where: { userId: customerId } });
    await prisma.payment.deleteMany({ where: { order: { userId: customerId } } });
    await prisma.orderCompensation.deleteMany({ where: { originalOrder: { userId: customerId } } });
    await prisma.order.deleteMany({ where: { userId: customerId } });
    await prisma.recipe.deleteMany({ where: { ingredientId } });
    await prisma.product.deleteMany({ where: { id: { in: [originalProductId, replacementProductId] } } });
    await prisma.topping.deleteMany({ where: { id: toppingId } });
    await prisma.ingredient.deleteMany({ where: { id: ingredientId } });
    await prisma.promotion.deleteMany({ where: { code: voucher } });
    await prisma.user.deleteMany({ where: { id: { in: [customerId, adminId] } } });
    await app.close();
  });

  const api = () => request(app.getHttpServer());
  async function login(id: string) {
    const response = await api().post('/api/auth/login').send({ email: id + '@example.test', password }).expect(200);
    return response.body.accessToken as string;
  }
  const auth = (token = customerToken) => 'Bearer ' + token;
  const item = (productId: string, size: ProductSize, toppings: string[] = []) =>
    ({ productId, size, toppings, qty: 1, lineTotal: 1 });
  const adminStatus = (id: string, status: string, token = adminToken) => api()
    .patch('/api/admin/orders/' + id + '/status').set('Authorization', auth(token)).send({ status });
  const replacementPath = (id: string) => '/api/orders/' + id + '/replacement';
  const createReplacement = (id: string, size: ProductSize, toppings: string[] = []) => api()
    .post(replacementPath(id)).set('Authorization', auth()).send({ items: [item(replacementProductId, size, toppings)] });
  const feed = () => api().get('/api/orders/notifications').set('Authorization', auth()).expect(200);
  const mockLink = (linkId: string) => vi.spyOn(PaymentRequests.prototype, 'create').mockImplementation(async (payload) => ({
    ...payload, paymentLinkId: linkId, qrCode: 'qr-test', checkoutUrl: 'https://pay.payos.vn/web/' + linkId,
    status: 'PENDING', bin: '970416', accountName: 'TEST', accountNumber: '123456', currency: 'VND',
  }));

  async function paidOrder() {
    const created = await api().post('/api/orders').set('Authorization', auth())
      .send({ items: [item(originalProductId, 'S')], promoCode: voucher }).expect(201);
    expect(created.body.data.total).toBe(45_000);
    const id = created.body.data.id as string;
    await api().post('/api/checkout').set('Authorization', auth()).set('Idempotency-Key', randomUUID())
      .send({ orderId: id, method: 'CARD' }).expect(201);
    return id;
  }

  it('admin hủy, thông báo đúng chủ đơn và chỉ tạo một đơn thay thế đồng giá', async () => {
    const id = await paidOrder();
    const stockAfterPurchase = await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredientId } });
    await adminStatus(id, 'CANCELLED', customerToken).expect(403);
    await Promise.all([adminStatus(id, 'CANCELLED').expect(200), adminStatus(id, 'CANCELLED').expect(200)]);
    const restored = await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredientId } });
    expect(restored.onHand!.sub(stockAfterPurchase.onHand!).toNumber()).toBe(5);
    const notice = (await feed()).body.data.items.filter((entry: { orderId: string; status: string }) =>
      entry.orderId === id && entry.status === 'CANCELLED');
    expect(notice).toHaveLength(1);
    expect(notice[0].order.compensationIssued.amount).toBe(45_000);
    await api().get(replacementPath(id)).set('Authorization', auth(adminToken)).expect(404);
    await api().patch('/api/orders/notifications/' + notice[0].id + '/read').set('Authorization', auth()).expect(200);
    expect((await prisma.orderNotification.findUniqueOrThrow({ where: { id: notice[0].id } })).readAt).not.toBeNull();
    await createReplacement(id, 'S').expect(400);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: customerId } });
    const results = await Promise.all([
      createReplacement(id, 'S', [toppingName]).expect(201), createReplacement(id, 'M').expect(201),
    ]);
    const replacement = results[0].body.data;
    expect(replacement.status).toBe('PAID');
    expect(results[1].body.data.id).toBe(replacement.id);
    expect(await prisma.payment.count({ where: { orderId: replacement.id } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: customerId } })).loyaltyPoints).toBe(before.loyaltyPoints);
    await adminStatus(replacement.id, 'PREPARING').expect(200);
    await adminStatus(replacement.id, 'CANCELLED').expect(409);
  });

  it('PayOS chỉ thu chênh lệch, kiểm tra chữ ký và xử lý webhook lặp đúng một lần', async () => {
    const id = await paidOrder();
    await adminStatus(id, 'CANCELLED').expect(200);
    const startedAt = Date.now();
    const order = (await createReplacement(id, 'L').expect(201)).body.data;
    expect(order.status).toBe('PENDING');
    const deadline = (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).reservationExpiresAt!.getTime();
    expect(deadline).toBeGreaterThanOrEqual(startedAt + 5 * 60 * 1000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
    await api().post('/api/checkout').set('Authorization', auth()).set('Idempotency-Key', randomUUID())
      .send({ orderId: order.id, method: 'CARD' }).expect(400);
    const linkId = randomUUID();
    const provider = mockLink(linkId);
    try {
      const paymentLink = await api().post(replacementPath(id) + '/payment').set('Authorization', auth()).expect(201);
      expect(paymentLink.body.data).toEqual({ qrCodeUrl: expect.stringMatching(/^data:image\/png;base64,/) });
      await api().post(replacementPath(id) + '/payment').set('Authorization', auth()).expect(201);
      expect(provider).toHaveBeenCalledTimes(1);
      const payload = provider.mock.calls[0][0];
      expect(payload.amount).toBe(10_000);
      expect(payload.expiredAt).toBe(Math.floor(deadline / 1000));
      const current = (await api().get(replacementPath(id)).set('Authorization', auth()).expect(200)).body.data.replacement;
      expect(current.paymentLink).toEqual(paymentLink.body.data);
      expect(current.remainingSeconds).toBeGreaterThan(120);
      expect(current.remainingSeconds).toBeLessThanOrEqual(300);
      const payos = new PayOS({ clientId: 'test', apiKey: 'test', checksumKey });
      const data: WebhookData = {
        orderCode: payload.orderCode, amount: payload.amount, description: payload.description, accountNumber: '123456',
        reference: randomUUID(), transactionDateTime: new Date().toISOString(), currency: 'VND', paymentLinkId: linkId,
        code: '00', desc: 'Success',
      };
      const sign = async (body: WebhookData) => (await payos.crypto.createSignatureFromObj(body, checksumKey))!;
      const hook = (body: WebhookData, signature: string) => api().post('/api/payments/payos-webhook')
        .send({ code: '00', success: true, desc: 'Success', data: body, signature });
      await hook(data, 'invalid').expect(400);
      const wrong = { ...data, amount: 9_000 };
      await hook(wrong, await sign(wrong)).expect(200);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING');
      const signature = await sign(data);
      await Promise.all([hook(data, signature).expect(200), hook(data, signature).expect(200)]);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PAID');
      expect(await prisma.payment.findMany({ where: { orderId: order.id }, select: { amount: true } })).toEqual([{ amount: 10_000 }]);
      expect(await prisma.pointTransaction.findMany({ where: { orderId: order.id }, select: { points: true } })).toEqual([{ points: 1 }]);
      await adminStatus(order.id, 'CANCELLED').expect(200);
      expect((await createReplacement(id, 'M').expect(201)).body.data.id).toBe(order.id);
    } finally {
      provider.mockRestore();
    }
  });

  it('đơn chênh lệch hết hạn nhả nguyên liệu và cho chọn lại bằng lượt đền bù cũ', async () => {
    const id = await paidOrder();
    await adminStatus(id, 'CANCELLED').expect(200);
    const attempt = (await createReplacement(id, 'L').expect(201)).body.data;
    const linkId = randomUUID();
    const provider = mockLink(linkId);
    const lookup = vi.spyOn(PaymentRequests.prototype, 'get');
    try {
      await api().post(replacementPath(id) + '/payment').set('Authorization', auth()).expect(201);
      lookup.mockResolvedValue({
        id: linkId, orderCode: provider.mock.calls[0][0].orderCode, amount: 10_000,
        amountPaid: 0, amountRemaining: 10_000, status: 'EXPIRED',
        createdAt: new Date().toISOString(), transactions: [], cancellationReason: null, canceledAt: null,
      });
      await prisma.order.update({
        where: { id: attempt.id }, data: { reservationExpiresAt: new Date(Date.now() - 1000) },
      });
      const status = await api().get(replacementPath(id)).set('Authorization', auth()).expect(200);
      expect(lookup).toHaveBeenCalledWith(linkId);
      expect(status.body.data).toEqual({ amount: 45_000, replacement: null });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: attempt.id } })).inventoryState).toBe('RELEASED');
      const next = (await createReplacement(id, 'M').expect(201)).body.data;
      expect(next.id).not.toBe(attempt.id);
      expect(next.status).toBe('PAID');
    } finally {
      provider.mockRestore();
      lookup.mockRestore();
    }
  });
});
