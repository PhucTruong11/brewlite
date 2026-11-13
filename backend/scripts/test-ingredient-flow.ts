import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { InventoryService } from '../src/modules/inventory/inventory.service.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { CheckoutService } from '../src/modules/checkout/checkout.service.js';
import { RewardsService } from '../src/modules/rewards/rewards.service.js';
import { AdminService } from '../src/modules/admin/admin.service.js';

const database = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
if (database.pathname !== '/brewlite_inventory_test' || !['localhost', '127.0.0.1'].includes(database.hostname)) {
  throw new Error('test:ingredients chỉ được chạy trên DB brewlite_inventory_test');
}

const prisma = new PrismaClient();

async function cleanupFixtures() {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: '@example.test' }, OR: [{ email: { startsWith: 'ingredient-test-' } }, { email: { startsWith: 'ingredient-race-' } }] },
    select: { id: true },
  });
  const userId = { in: users.map(user => user.id) };
  await prisma.$transaction(async tx => {
    await tx.pointTransaction.deleteMany({ where: { userId } });
    await tx.userVoucher.deleteMany({ where: { userId } });
    await tx.orderCompensation.deleteMany({ where: { originalOrder: { userId } } });
    await tx.payment.deleteMany({ where: { order: { userId } } });
    await tx.order.deleteMany({ where: { userId } });
    await tx.user.deleteMany({ where: { id: userId } });
  });
}

async function main() {
  await cleanupFixtures();
  const inventory = new InventoryService(prisma as never);
  const rewards = new RewardsService(prisma as never);
  const orders = new OrdersService(prisma as never, {} as never, rewards, inventory);
  const checkout = new CheckoutService(prisma as never, rewards, inventory, {
    charge: async () => ({ success: true, gatewayRef: 'inventory-test' }),
  } as never);
  const admin = new AdminService(prisma as never, inventory, rewards);
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: { email: `ingredient-test-${suffix}@example.test`, passwordHash: 'test-only' },
  });
  const otherUser = await prisma.user.create({
    data: { email: `ingredient-race-${suffix}@example.test`, passwordHash: 'test-only' },
  });
  const coffee = await prisma.product.findFirstOrThrow({ where: { name: 'Phin Sữa Đá', isAvailable: true } });
  const blackCoffee = await prisma.product.findFirstOrThrow({ where: { name: 'Phin Đen Đá', isAvailable: true } });
  const tea = await prisma.product.findFirstOrThrow({ where: { name: 'Trà Thanh Đào', isAvailable: true } });
  await prisma.ingredient.updateMany({
    where: { trackStock: true },
    data: { onHand: 10_000, reserved: 0 },
  });
  const water = await prisma.ingredient.findUniqueOrThrow({ where: { code: 'WATER' } });
  assert.equal(water.onHand, null);

  const teaCart = [{ productId: tea.id, size: 'S' as const, qty: 2, toppings: ['Trân Châu Trắng'], lineTotal: 1 }];
  const teaValidation = await inventory.validateCart(teaCart);
  assert.equal(teaValidation.available, true);
  const teaRecipe = await inventory.prepareCart(teaCart);
  const pearls = await prisma.ingredient.findUniqueOrThrow({ where: { code: 'WHITE_PEARLS' } });
  assert.equal(teaRecipe.required.get(pearls.id)?.toNumber(), 60);
  await assert.rejects(
    inventory.validateCart([{ ...teaCart[0], toppings: ['Topping không tồn tại'] }]),
    /không tồn tại/,
  );

  // Kiểm tra toàn bộ giỏ, kể cả hai dòng món cùng dùng một nguyên liệu.
  await prisma.ingredient.update({ where: { code: 'CUP_S' }, data: { onHand: 1 } });
  const singleCup = { productId: blackCoffee.id, size: 'S' as const, qty: 1, lineTotal: 1 };
  const shortage = await inventory.validateCart([singleCup, singleCup]);
  assert.equal(shortage.available, false);
  assert(shortage.shortages.some((entry) => entry.ingredientName === 'Ly size S'));
  const race = await Promise.allSettled([
    orders.create({ items: [singleCup] }, user.id),
    orders.create({ items: [singleCup] }, otherUser.id),
  ]);
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(race.filter((result) => result.status === 'rejected').length, 1);
  const raceOrder = race.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof orders.create>>> => result.status === 'fulfilled')!;
  await prisma.order.update({ where: { id: raceOrder.value.id }, data: { reservationExpiresAt: new Date(0) } });
  await checkout.getOrderCheckoutStatus(raceOrder.value.id, raceOrder.value.userId!);
  const cupAfterRelease = await prisma.ingredient.findUniqueOrThrow({ where: { code: 'CUP_S' } });
  assert.equal(cupAfterRelease.reserved?.toNumber(), 0);
  assert.equal(cupAfterRelease.onHand?.toNumber(), 1);
  await prisma.ingredient.update({ where: { code: 'CUP_S' }, data: { onHand: 10_000 } });

  const beansBefore = await prisma.ingredient.findUniqueOrThrow({ where: { code: 'COFFEE_BEANS' } });
  const order = await orders.create({
    items: [{ productId: coffee.id, size: 'M', qty: 2, lineTotal: 1 }],
  }, user.id);
  assert.equal(order.status, 'PENDING');
  assert.equal(order.inventoryState, 'RESERVED');
  assert(order.items[0].recipeSnapshot);
  const beansReserved = await prisma.ingredient.findUniqueOrThrow({ where: { code: 'COFFEE_BEANS' } });
  assert.equal(beansReserved.onHand?.toNumber(), beansBefore.onHand?.toNumber());
  assert.equal(beansReserved.reserved?.toNumber(), 48);

  // Thanh toán thất bại vẫn giữ nguyên liệu để khách thử lại trong thời hạn.
  const failedCheckout = new CheckoutService(prisma as never, rewards, inventory, {
    charge: async () => ({ success: false, gatewayRef: 'TEST-FAIL' }),
  } as never);
  const failed = await failedCheckout.processCheckout(order.id, 'CARD', randomUUID(), user.id);
  assert.equal(failed.success, false);
  const failedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(failedOrder.status, 'PAYMENT_FAILED');
  assert.equal(failedOrder.inventoryState, 'RESERVED');

  const paymentKey = randomUUID();
  const paid = await checkout.processCheckout(order.id, 'EWALLET', paymentKey, user.id);
  assert.equal(paid.success, true);
  const beansPaid = await prisma.ingredient.findUniqueOrThrow({ where: { code: 'COFFEE_BEANS' } });
  assert.equal(beansPaid.reserved?.toNumber(), 0);
  assert.equal(beansPaid.onHand?.toNumber(), beansBefore.onHand!.toNumber() - 48);
  const duplicate = await checkout.processCheckout(order.id, 'EWALLET', paymentKey, user.id);
  assert.equal(duplicate.isDuplicate, true);
  const beansAfterDuplicate = await prisma.ingredient.findUniqueOrThrow({ where: { code: 'COFFEE_BEANS' } });
  assert.equal(beansAfterDuplicate.onHand?.toNumber(), beansPaid.onHand?.toNumber());
  assert.equal(await prisma.pointTransaction.count({ where: { orderId: order.id, type: 'EARN' } }), 0);

  // Quản trị viên hủy đơn đã trả tiền thì hoàn nguyên liệu theo bản chụp công thức đúng một lần.
  await admin.updateStatus(order.id, 'CANCELLED');
  const beansRestored = await prisma.ingredient.findUniqueOrThrow({ where: { code: 'COFFEE_BEANS' } });
  assert.equal(beansRestored.onHand?.toNumber(), beansBefore.onHand?.toNumber());
  const cancelled = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(cancelled.inventoryState, 'RESTORED');

  const simultaneous = await orders.create({ items: [singleCup] }, user.id);
  const simultaneousKey = randomUUID();
  const beansBeforeSimultaneous = await prisma.ingredient.findUniqueOrThrow({ where: { code: 'COFFEE_BEANS' } });
  const concurrentPayments = await Promise.all([
    checkout.processCheckout(simultaneous.id, 'CARD', simultaneousKey, user.id),
    checkout.processCheckout(simultaneous.id, 'CARD', simultaneousKey, user.id),
  ]);
  assert.equal(concurrentPayments.filter((result) => result.isDuplicate).length, 1);
  assert.equal(await prisma.payment.count({ where: { orderId: simultaneous.id } }), 1);
  assert.equal(await prisma.pointTransaction.count({ where: { orderId: simultaneous.id, type: 'EARN' } }), 0);
  const beansAfterSimultaneous = await prisma.ingredient.findUniqueOrThrow({ where: { code: 'COFFEE_BEANS' } });
  const simultaneousRecipe = await inventory.prepareCart([singleCup]);
  const beansIngredient = await prisma.ingredient.findUniqueOrThrow({ where: { code: 'COFFEE_BEANS' } });
  assert.equal(
    beansAfterSimultaneous.onHand?.toNumber(),
    beansBeforeSimultaneous.onHand!.toNumber() - simultaneousRecipe.required.get(beansIngredient.id)!.toNumber(),
  );

  // Đơn hết hạn phải trả nguyên liệu đã giữ và không cho thanh toán tiếp.
  const expiring = await orders.create({ items: [{ productId: coffee.id, size: 'S', qty: 1, lineTotal: 1 }] }, user.id);
  await prisma.order.update({ where: { id: expiring.id }, data: { reservationExpiresAt: new Date(0) } });
  const status = await checkout.getOrderCheckoutStatus(expiring.id, user.id);
  assert.equal(status.status, 'CANCELLED');
  const expired = await prisma.order.findUniqueOrThrow({ where: { id: expiring.id } });
  assert.equal(expired.inventoryState, 'RELEASED');
  await assert.rejects(checkout.processCheckout(expiring.id, 'EWALLET', randomUUID(), user.id), /không thể thanh toán/);

  console.log('PASS: cart recipes, topping, shortages, concurrent reservation, failure/retry, simultaneous idempotency, payment consumption, cancellation restoration, expiry');
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    try { await cleanupFixtures(); } finally { await prisma.$disconnect(); }
  });
