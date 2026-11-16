import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PaymentGatewayService } from '../src/modules/checkout/payment-gateway.service.js';
import { PrismaService } from '../src/modules/prisma/prisma.service.js';

describe('Race Condition: 2 khách hàng tranh đơn khi kho còn ít', () => {
  let app: INestApplication;
  let db: PrismaService;
  let tokenA: string;
  let tokenB: string;
  const customerAId = randomUUID();
  const customerBId = randomUUID();
  const ingredientId = randomUUID();
  const productId = randomUUID();
  const UNITS_PER_CUP = 2;

  const api = () => request(app.getHttpServer());
  const orderBody = (qty: number) => ({ items: [{ productId, size: 'S', qty, lineTotal: 1 }] });

  async function stockSnapshot() {
    const row = await db.ingredient.findUniqueOrThrow({ where: { id: ingredientId } });
    const onHand = Number(row.onHand ?? 0);
    const reserved = Number(row.reserved ?? 0);
    return { onHand, reserved, available: onHand - reserved };
  }

  async function clearTestOrders() {
    const userIds = [customerAId, customerBId];
    await db.pointTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await db.payment.deleteMany({ where: { order: { userId: { in: userIds } } } });
    await db.order.deleteMany({ where: { userId: { in: userIds } } });
  }

  async function setupStock(cups: number) {
    await clearTestOrders();
    await db.ingredient.update({
      where: { id: ingredientId },
      data: { onHand: cups * UNITS_PER_CUP, reserved: 0 },
    });
  }

  function formatAttempt(label: string, res: request.Response) {
    if (res.status === 201) {
      return `${label}: 201 Created (orderId=${res.body.data.id})`;
    }
    return `${label}: ${res.status} (${res.body?.message ?? 'Từ chối'})`;
  }

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/');
    if (
      process.env.E2E_DATABASE !== '1' ||
      url.pathname !== '/brewlite_test' ||
      !['localhost', '127.0.0.1'].includes(url.hostname)
    ) {
      throw new Error('Test yêu cầu E2E_DATABASE=1 và DB riêng brewlite_test trên localhost');
    }

    vi.stubEnv('PAYOS_CLIENT_ID', '');
    vi.stubEnv('PAYOS_API_KEY', '');
    vi.stubEnv('PAYOS_CHECKSUM_KEY', '');

    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PaymentGatewayService)
      .useValue({ charge: async () => ({ success: true, gatewayRef: 'test' }) })
      .compile();

    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    db = app.get(PrismaService);
    for (const id of [customerAId, customerBId]) {
      await db.user.create({
        data: { id, email: `${id}@example.test`, passwordHash: 'test-only', emailVerifiedAt: new Date() },
      });
    }
    await db.ingredient.create({
      data: { id: ingredientId, code: `RACE_${ingredientId}`, name: 'Nguyên liệu test race', unit: 'G', onHand: 2, reserved: 0 },
    });
    await db.product.create({
      data: { id: productId, name: 'Món test race', category: 'other', prices: { create: { size: 'S', price: 30000 } } },
    });
    await db.recipe.create({
      data: { productId, size: 'S', ingredientId, quantity: UNITS_PER_CUP },
    });

    const jwt = new JwtService({ secret: process.env.JWT_SECRET || 'super-secret-key' });
    tokenA = jwt.sign({ sub: customerAId, email: `${customerAId}@example.test` });
    tokenB = jwt.sign({ sub: customerBId, email: `${customerBId}@example.test` });
  }, 30000);

  afterAll(async () => {
    if (db) {
      await clearTestOrders();
      await db.recipe.deleteMany({ where: { ingredientId } });
      await db.product.deleteMany({ where: { id: productId } });
      await db.ingredient.deleteMany({ where: { id: ingredientId } });
      await db.user.deleteMany({ where: { id: { in: [customerAId, customerBId] } } });
    }
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('tranh ly cuối (kho còn 1 ly): Khách A và Khách B đặt 1 ly cùng lúc -> chỉ 1 khách giữ được kho', async () => {
    await setupStock(1);
    const before = await stockSnapshot();

    const [resA, resB] = await Promise.all([
      api().post('/api/orders').set('Authorization', `Bearer ${tokenA}`).send(orderBody(1)),
      api().post('/api/orders').set('Authorization', `Bearer ${tokenB}`).send(orderBody(1)),
    ]);

    const attempts = [
      { label: 'Khách A', token: tokenA, res: resA },
      { label: 'Khách B', token: tokenB, res: resB },
    ];
    const winners = attempts.filter((a) => a.res.status === 201);
    const losers = attempts.filter((a) => a.res.status !== 201);
    const during = await stockSnapshot();

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect([400, 409]).toContain(losers[0].res.status);
    expect(during).toEqual({ onHand: 2, reserved: 2, available: 0 });

    await api()
      .post(`/api/checkout/${winners[0].res.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${winners[0].token}`)
      .expect(200);

    const afterCancel = await stockSnapshot();
    console.log(
      [
        '[Case 1 - Tranh ly cuối (1 ly = 2 đơn vị)]',
        `  Kho ban đầu : onHand=${before.onHand}, reserved=${before.reserved}, khả dụng=${before.available}`,
        `  ${formatAttempt('Khách A', resA)}`,
        `  ${formatAttempt('Khách B', resB)}`,
        `  Kho sau race: onHand=${during.onHand}, reserved=${during.reserved}, khả dụng=${during.available}`,
        `  Sau hủy đơn : onHand=${afterCancel.onHand}, reserved=${afterCancel.reserved}, khả dụng=${afterCancel.available}`,
      ].join('\n'),
    );
    expect(afterCancel).toEqual({ onHand: 2, reserved: 0, available: 2 });
  });

  it('kho còn ít (còn 3 ly): Khách A và Khách B cùng đặt 2 ly -> chỉ 1 khách giữ được 2 ly, còn dư đúng 1 ly', async () => {
    await setupStock(3);
    const before = await stockSnapshot();

    const [resA, resB] = await Promise.all([
      api().post('/api/orders').set('Authorization', `Bearer ${tokenA}`).send(orderBody(2)),
      api().post('/api/orders').set('Authorization', `Bearer ${tokenB}`).send(orderBody(2)),
    ]);

    const attempts = [
      { label: 'Khách A', token: tokenA, res: resA },
      { label: 'Khách B', token: tokenB, res: resB },
    ];
    const winners = attempts.filter((a) => a.res.status === 201);
    const losers = attempts.filter((a) => a.res.status !== 201);
    const during = await stockSnapshot();

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect([400, 409]).toContain(losers[0].res.status);
    expect(during).toEqual({ onHand: 6, reserved: 4, available: 2 });

    // Khách thua đặt lại đúng 1 ly còn lại phải thành công.
    const retry = await api()
      .post('/api/orders')
      .set('Authorization', `Bearer ${losers[0].token}`)
      .send(orderBody(1))
      .expect(201);

    const afterRetry = await stockSnapshot();

    console.log(
      [
        '[Case 2 - Kho còn 3 ly, cả 2 cùng đặt 2 ly]',
        `  Kho ban đầu : onHand=${before.onHand}, reserved=${before.reserved}, khả dụng=${before.available}`,
        `  ${formatAttempt('Khách A', resA)}`,
        `  ${formatAttempt('Khách B', resB)}`,
        `  Kho sau race: onHand=${during.onHand}, reserved=${during.reserved}, khả dụng=${during.available} (còn dư 1 ly)`,
        `  ${losers[0].label} đặt lại 1 ly: ${retry.status} Created (orderId=${retry.body.data.id}) -> khả dụng=${afterRetry.available}`,
      ].join('\n'),
    );

    expect(afterRetry).toEqual({ onHand: 6, reserved: 6, available: 0 });
  });
});
