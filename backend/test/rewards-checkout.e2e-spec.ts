import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/modules/prisma/prisma.service.js';
import { CheckoutService } from '../src/modules/checkout/checkout.service.js';
import { PaymentGatewayService } from '../src/modules/checkout/payment-gateway.service.js';

describe('Điểm thưởng, voucher và giao dịch thanh toán', () => {
  let app: INestApplication;
  let db: PrismaService;
  let token: string;
  let adminToken: string;
  let succeeds = true;
  const userId = randomUUID(), adminId = randomUUID(), ingredientId = randomUUID(), productId = randomUUID();
  const rewardId = randomUUID(), promotionId = randomUUID();
  const code = 'REWARD' + randomUUID().slice(0, 8).toUpperCase();
  const api = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: 'Bearer ' + token });
  const balance = async () => (await db.user.findUniqueOrThrow({ where: { id: userId } })).loyaltyPoints;
  const create = async (promoCode?: string) => (await api().post('/api/orders').set(auth())
    .send({ items: [{ productId, size: 'S', qty: 1, lineTotal: 1 }], ...(promoCode && { promoCode }) }).expect(201)).body.data.id as string;
  const pay = (id: string, key = randomUUID()) => api().post('/api/checkout').set(auth()).set('Idempotency-Key', key)
    .send({ orderId: id, method: 'CARD' });
  const complete = async (id: string) => {
    for (const status of ['PREPARING', 'READY', 'COMPLETED']) {
      await api().patch('/api/admin/orders/' + id + '/status').set('Authorization', 'Bearer ' + adminToken)
        .send({ status }).expect(200);
    }
  };

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/');
    if (process.env.E2E_DATABASE !== '1' || url.pathname !== '/brewlite_test' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('Chỉ chạy trên DB riêng brewlite_test tại localhost');
    }
    for (const key of ['PAYOS_CLIENT_ID', 'PAYOS_API_KEY', 'PAYOS_CHECKSUM_KEY']) vi.stubEnv(key, '');
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PaymentGatewayService)
      .useValue({ charge: async () => ({ success: succeeds, gatewayRef: 'rewards-test' }) }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    db = app.get(PrismaService);
    for (const [id, role] of [[userId, 'USER'], [adminId, 'ADMIN']] as const) {
      await db.user.create({ data: { id, role, email: id + '@example.test', passwordHash: 'test-only', emailVerifiedAt: new Date() } });
    }
    await db.ingredient.create({ data: { id: ingredientId, code: 'TEST_' + ingredientId, name: 'Rewards test', unit: 'G', onHand: 1000, reserved: 0 } });
    await db.product.create({ data: { id: productId, name: 'Rewards test drink', category: 'other', prices: { create: { size: 'S', price: 59000 } } } });
    await db.recipe.create({ data: { productId, size: 'S', ingredientId, quantity: 1 } });
    await db.promotion.create({ data: { id: promotionId, code, isRewardOnly: true, discountType: 'FIXED_AMOUNT', discountValue: 10000 } });
    await db.rewardItem.create({ data: { id: rewardId, name: 'Rewards test voucher', pointsCost: 5, promotionId } });
    const jwt = new JwtService({ secret: process.env.JWT_SECRET || 'super-secret-key' });
    token = jwt.sign({ sub: userId }); adminToken = jwt.sign({ sub: adminId });
  }, 30000);

  afterAll(async () => {
    if (db) {
      const orders = { userId };
      await db.pointTransaction.deleteMany({ where: { userId } });
      await db.userVoucher.deleteMany({ where: { userId } });
      await db.orderCompensation.deleteMany({ where: { originalOrder: orders } });
      await db.payment.deleteMany({ where: { order: orders } });
      await db.order.deleteMany({ where: orders });
      await db.rewardItem.deleteMany({ where: { id: rewardId } });
      await db.promotion.deleteMany({ where: { id: promotionId } });
      await db.recipe.deleteMany({ where: { ingredientId } });
      await db.product.deleteMany({ where: { id: productId } });
      await db.ingredient.deleteMany({ where: { id: ingredientId } });
      await db.user.deleteMany({ where: { id: { in: [userId, adminId] } } });
    }
    await app?.close(); vi.unstubAllEnvs();
  });

  it('đơn chờ, thất bại và PAID chưa cộng điểm; chỉ cộng một lần khi COMPLETED', async () => {
    const id = await create();
    expect(await balance()).toBe(0);
    succeeds = false;
    const failed = await pay(id).expect(201);
    expect(failed.body.pointsEarned).toBe(0);
    expect(await balance()).toBe(0);
    succeeds = true;
    const key = randomUUID();
    await Promise.all([pay(id, key).expect(201), pay(id, key).expect(201)]);
    expect(await balance()).toBe(0);
    expect(await db.pointTransaction.count({ where: { orderId: id, type: 'EARN' } })).toBe(0);
    for (let n = 0; n < 3; n++) {
      const status = await api().get('/api/checkout/status/' + id).set(auth()).expect(200);
      expect(status.body.loyaltyPointsEarned).toBe(0);
    }
    await complete(id);
    expect(await db.pointTransaction.findMany({ where: { orderId: id }, select: { points: true, balanceAfter: true } }))
      .toEqual([{ points: 5, balanceAfter: 5 }]);
    expect(await balance()).toBe(5);
  });

  it('hai lượt đổi cùng lúc không âm điểm, không tạo voucher thừa; không đủ điểm báo lỗi', async () => {
    const responses = await Promise.all([0, 1].map(() => api().post('/api/rewards/redeem').set(auth()).send({ rewardItemId: rewardId })));
    expect(responses.map(r => r.status).sort()).toEqual([200, 400]);
    expect(await balance()).toBe(0);
    expect(await db.userVoucher.count({ where: { userId, usedAt: null } })).toBe(1);
    expect(await db.pointTransaction.count({ where: { userId, type: 'REDEEM' } })).toBe(1);
  });

  it('hủy đơn đã trả tiền trước khi hoàn tất: hoàn lại voucher và cấp đền bù theo giá trước giảm', async () => {
    const cancelled = await create(code);
    await api().post('/api/checkout/' + cancelled + '/cancel').set(auth()).expect(200);
    expect(await balance()).toBe(0);
    expect(await db.userVoucher.count({ where: { userId, usedAt: null } })).toBe(1);
    const id = await create(code);
    await pay(id).expect(201);
    expect(await balance()).toBe(0);
    expect(await db.userVoucher.count({ where: { userId, usedOrderId: id, usedAt: { not: null } } })).toBe(1);
    await api().post('/api/orders').set(auth()).send({ items: [{ productId, size: 'S', qty: 1, lineTotal: 1 }], promoCode: code }).expect(400);
    await Promise.all([0, 1].map(() => api().patch('/api/admin/orders/' + id + '/status').set('Authorization', 'Bearer ' + adminToken)
      .send({ status: 'CANCELLED' }).expect(200)));
    expect(await balance()).toBe(0);
    expect(await db.userVoucher.count({ where: { userId, usedAt: null } })).toBe(1);
    expect((await db.orderCompensation.findUniqueOrThrow({ where: { originalOrderId: id } })).amount).toBe(59_000);
    const overview = (await api().get('/api/rewards').set(auth()).expect(200)).body;
    expect(overview.points).toBe(0);
    expect(overview.vouchers.find((v: { code: string }) => v.code === code).count).toBe(1);
  });

  it('webhook PayOS lặp chỉ ghi một giao dịch; điểm được cộng khi COMPLETED', async () => {
    const id = await create();
    const service = app.get(CheckoutService);
    let amount = 58000;
    Object.assign(service, { payos: { webhooks: { verify: async () => ({ orderCode: 1, description: 'BL' + id.replace(/-/g, '').slice(0, 8), amount, code: '00', reference: 'rewards-webhook' }) } } });
    const hook = () => api().post('/api/payments/payos-webhook').send({ success: true, code: '00', data: {}, signature: 'test' }).expect(200);
    try {
      await hook();
      expect(await db.payment.count({ where: { orderId: id } })).toBe(0);
      amount = 59000;
      await Promise.all([hook(), hook()]);
      expect(await db.payment.count({ where: { orderId: id, status: 'SUCCESS' } })).toBe(1);
      expect(await balance()).toBe(0);
      await complete(id);
      expect(await balance()).toBe(5);
      expect(await db.pointTransaction.count({ where: { orderId: id, type: 'EARN' } })).toBe(1);
    } finally { Object.assign(service, { payos: undefined }); }
  });

  it('hủy đồng thời hai đơn cũ đã tích điểm chỉ thu hồi số điểm còn trong tài khoản', async () => {
    await db.user.update({ where: { id: userId }, data: { loyaltyPoints: 4 } });
    const orders = await Promise.all([0, 1].map(() => db.order.create({
      data: { userId, status: 'PAID', total: 40_000, loyaltyPointsEarned: 4, inventoryState: 'LEGACY' },
    })));
    await Promise.all(orders.map(({ id }) => api().patch('/api/admin/orders/' + id + '/status')
      .set('Authorization', 'Bearer ' + adminToken).send({ status: 'CANCELLED' }).expect(200)));

    expect(await balance()).toBe(0);
    const refunds = await db.pointTransaction.findMany({
      where: { orderId: { in: orders.map(({ id }) => id) }, type: 'REFUND' },
      select: { points: true, balanceAfter: true },
    });
    expect(refunds).toEqual([{ points: -4, balanceAfter: 0 }]);
  });
});
