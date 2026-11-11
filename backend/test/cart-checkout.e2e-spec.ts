import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/modules/prisma/prisma.service.js';
import { CheckoutService } from '../src/modules/checkout/checkout.service.js';
import { PaymentGatewayService } from '../src/modules/checkout/payment-gateway.service.js';

describe('Giỏ hàng quay lại đơn thanh toán đang giữ nguyên liệu', () => {
  let app: INestApplication;
  let db: PrismaService;
  let token: string;
  let otherToken: string;
  const userId = randomUUID();
  const otherId = randomUUID();
  const ingredientId = randomUUID();
  const productId = randomUUID();
  const item = (qty = 2) => ({ productId, size: 'S', qty, lineTotal: 1 });
  const auth = () => ({ Authorization: 'Bearer ' + token });
  const api = () => request(app.getHttpServer());
  const quantity = async () => Number((await db.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).reserved);

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/');
    if (process.env.E2E_DATABASE !== '1' || url.pathname !== '/brewlite_test' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('Test yêu cầu E2E_DATABASE=1 và DB riêng brewlite_test trên localhost');
    }
    vi.stubEnv('PAYOS_CLIENT_ID', '');
    vi.stubEnv('PAYOS_API_KEY', '');
    vi.stubEnv('PAYOS_CHECKSUM_KEY', '');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PaymentGatewayService).useValue({ charge: async () => ({ success: true, gatewayRef: 'test' }) }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    db = app.get(PrismaService);
    for (const id of [userId, otherId]) {
      await db.user.create({ data: { id, email: id + '@example.test', passwordHash: 'test-only', emailVerifiedAt: new Date() } });
    }
    await db.ingredient.create({ data: { id: ingredientId, code: 'TEST_' + ingredientId, name: 'Nguyên liệu test giỏ', unit: 'G', onHand: 12, reserved: 0 } });
    await db.product.create({ data: { id: productId, name: 'Món test giỏ', category: 'other', prices: { create: { size: 'S', price: 30000 } } } });
    await db.recipe.create({ data: { productId, size: 'S', ingredientId, quantity: 2 } });
    const jwt = new JwtService({ secret: process.env.JWT_SECRET || 'super-secret-key' });
    token = jwt.sign({ sub: userId, email: userId + '@example.test' });
    otherToken = jwt.sign({ sub: otherId, email: otherId + '@example.test' });
  }, 30000);

  afterAll(async () => {
    if (db) {
      await db.pointTransaction.deleteMany({ where: { userId: { in: [userId, otherId] } } });
      await db.payment.deleteMany({ where: { order: { userId: { in: [userId, otherId] } } } });
      await db.order.deleteMany({ where: { userId: { in: [userId, otherId] } } });
      await db.recipe.deleteMany({ where: { ingredientId } });
      await db.product.delete({ where: { id: productId } });
      await db.ingredient.delete({ where: { id: ingredientId } });
      await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    }
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('ba lần bấm đồng thời chỉ tạo một đơn và giữ nguyên liệu một lần; quay lại không bị kho của chính đơn chặn', async () => {
    const responses = await Promise.all(Array.from({ length: 3 }, () => api().post('/api/orders').set(auth()).send({ items: [item()] }).expect(201)));
    const id = responses[0].body.data.id;
    expect(responses.map(r => r.body.data.id)).toEqual([id, id, id]);
    expect(await quantity()).toBe(4);
    expect(await db.order.count({ where: { userId } })).toBe(1);
    const pending = await api().get('/api/orders/pending-checkout').set(auth()).expect(200);
    expect(pending.body.data.id).toBe(id);
    const resumed = await api().post('/api/orders').set(auth()).send({ items: [item()] }).expect(201);
    expect(resumed.body.data.id).toBe(id);
    expect(await quantity()).toBe(4);
    await api().post('/api/orders').set(auth()).send({ items: [item(3)] }).expect(409);
    await api().post('/api/checkout/' + id + '/cancel').set({ Authorization: 'Bearer ' + otherToken }).expect(404);
    expect(await quantity()).toBe(4);
    await api().post('/api/checkout/' + id + '/cancel').set(auth()).expect(200);
    await api().post('/api/checkout/' + id + '/cancel').set(auth()).expect(200);
    expect(await quantity()).toBe(0);
    expect((await api().get('/api/orders/pending-checkout').set(auth()).expect(200)).body.data).toBeNull();
  });

  it('thanh toán đúng đơn trừ kho một lần, đơn đã trả tiền không được hủy để hoàn kho', async () => {
    const created = await api().post('/api/orders').set(auth()).send({ items: [item()] }).expect(201);
    const id = created.body.data.id;
    await api().post('/api/checkout').set(auth()).set('Idempotency-Key', randomUUID()).send({ orderId: id, method: 'CARD' }).expect(201);
    expect(await quantity()).toBe(0);
    expect(Number((await db.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).onHand)).toBe(8);
    await api().post('/api/checkout/' + id + '/cancel').set(auth()).expect(409);
    expect(Number((await db.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).onHand)).toBe(8);
  });

  it('hết hạn trả nguyên liệu và giữ số lượng trong bản chụp đơn để mở lại sau refresh', async () => {
    const created = await api().post('/api/orders').set(auth()).send({ items: [item(3)] }).expect(201);
    const id = created.body.data.id;
    await db.order.update({ where: { id }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    const status = await api().get('/api/checkout/status/' + id).set(auth()).expect(200);
    expect(status.body.status).toBe('CANCELLED');
    expect(await quantity()).toBe(0);
    const detail = await api().get('/api/orders/' + id).set(auth()).expect(200);
    expect(detail.body.data.items[0].qty).toBe(3);

    // Webhook tới sau khi đã trả kho phải đối soát, không tự đổi đơn hủy thành PAID.
    const service = app.get(CheckoutService);
    Object.assign(service, { payos: { webhooks: { verify: async () => ({ orderCode: 1, description: 'BL' + id.replace(/-/g, '').slice(0, 8), amount: 90000, code: '00', reference: 'late-test' }) } } });
    const late = await api().post('/api/payments/payos-webhook').send({ success: true, code: '00', data: {}, signature: 'test' }).expect(200);
    expect(late.body.requiresReview).toBe(true);
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('CANCELLED');
    expect(await quantity()).toBe(0);
    expect(Number((await db.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).onHand)).toBe(8);
    Object.assign(service, { payos: undefined });
  });

  it('khách khác tranh ly cuối: chỉ một đơn giữ được kho, hủy trả đúng phần của đơn thắng', async () => {
    await db.ingredient.update({ where: { id: ingredientId }, data: { onHand: 2, reserved: 0 } });
    const results = await Promise.all([token, otherToken].map(t => api().post('/api/orders')
      .set('Authorization', 'Bearer ' + t).send({ items: [item(1)] })));
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
    expect([400, 409]).toContain(results.find(r => r.status !== 201)!.status);
    expect(await quantity()).toBe(2);
    const winner = results.findIndex(r => r.status === 201);
    await api().post('/api/checkout/' + results[winner].body.data.id + '/cancel')
      .set('Authorization', 'Bearer ' + [token, otherToken][winner]).expect(200);
    expect(await quantity()).toBe(0);
  });

  it('hủy giỏ 10 ly dù bộ đếm bị lệch 1: giữ nguyên kho và phần dành cho đơn khác, hủy lặp không trừ lặp', async () => {
    await db.ingredient.update({ where: { id: ingredientId }, data: { onHand: 100, reserved: 0 } });
    const id = (await api().post('/api/orders').set(auth()).send({ items: [item(10)] }).expect(201)).body.data.id;
    const other = (await api().post('/api/orders').set('Authorization', 'Bearer ' + otherToken)
      .send({ items: [item(3)] }).expect(201)).body.data.id;
    expect(await quantity()).toBe(26);
    // Mô phỏng script cũ ghi đè counter sau khi đơn đã tạo.
    await db.ingredient.update({ where: { id: ingredientId }, data: { reserved: 25 } });
    await api().post('/api/checkout/' + id + '/cancel').set(auth()).expect(200);
    expect(await quantity()).toBe(6);
    expect(Number((await db.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).onHand)).toBe(100);
    await api().post('/api/checkout/' + id + '/cancel').set(auth()).expect(200);
    expect(await quantity()).toBe(6);
    await api().post('/api/checkout').set('Authorization', 'Bearer ' + otherToken).set('Idempotency-Key', randomUUID())
      .send({ orderId: other, method: 'CARD' }).expect(201);
    expect(await quantity()).toBe(0);
    expect(Number((await db.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).onHand)).toBe(94);
  });

  it('đơn hết hạn có counter lệch vẫn tự nhả kho, không cần refresh hay sửa DB thủ công', async () => {
    const id = (await api().post('/api/orders').set(auth()).send({ items: [item(1)] }).expect(201)).body.data.id;
    await db.ingredient.update({ where: { id: ingredientId }, data: { reserved: 1 } });
    await db.order.update({ where: { id }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    await app.get(CheckoutService).handleExpiredOrders();
    expect((await db.order.findUniqueOrThrow({ where: { id } })).inventoryState).toBe('RELEASED');
    expect(await quantity()).toBe(0);
    expect(Number((await db.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).onHand)).toBe(94);
  });
});
