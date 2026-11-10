import { PrismaClient, InventoryState, OrderStatus, ProductSize } from '@prisma/client';
import { PayOS } from '@payos/node';

const prisma = new PrismaClient();
const API_URL = process.env.API_URL || 'http://localhost:3001/api';

const clientId = process.env.PAYOS_CLIENT_ID || 'c9759eb5-0914-43eb-977f-5bf143750b08';
const apiKey = process.env.PAYOS_API_KEY || '47ccb33f-123e-4469-831d-f895f1ab9a90';
const checksumKey = process.env.PAYOS_CHECKSUM_KEY || 'c279b8706edf7901537f745404ad8c4506df6c55cebc9f73daa7ebf1a44d242e';

const payos = new PayOS({ clientId, apiKey, checksumKey });

function getPayosOrderCode(orderId: string): number {
  let hash = 0;
  for (let i = 0; i < orderId.length; i++) {
    hash = ((hash << 5) - hash) + orderId.charCodeAt(i);
    hash |= 0;
  }
  return (Math.abs(hash) % 900000000) + 100000000;
}

async function createFreshPendingOrder() {
  const user = await prisma.user.findFirst();
  const product = await prisma.product.findFirst({
    where: { isAvailable: true },
    include: { prices: true, recipes: true },
  });

  if (!user || !product) {
    throw new Error('Cần có user và sản phẩm trong DB để tạo đơn test');
  }

  const price = product.prices[0]?.price || 30000;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 1000);

  const snapshot = product.recipes
    .filter((r) => r.size === ProductSize.S || !r.size)
    .map((r) => ({
      ingredientId: r.ingredientId,
      quantity: r.quantity.toString(),
    }));

  const order = await prisma.order.create({
    data: {
      userId: user.id,
      status: OrderStatus.PENDING,
      total: price,
      discount: 0,
      inventoryState: InventoryState.RESERVED,
      reservationExpiresAt: expiresAt,
      items: {
        create: {
          productId: product.id,
          productName: product.name,
          productImageUrl: product.imageUrl,
          size: ProductSize.S,
          qty: 1,
          lineTotal: price,
          recipeSnapshot: snapshot.length > 0 ? (snapshot as any) : null,
        },
      },
    },
    include: { items: true },
  });

  return order;
}

async function sendFakePayOSWebhook(order: any, amountToTransfer: number, customDescription?: string) {
  const cleanId = order.id.replace(/-/g, '').slice(0, 8).toUpperCase();
  const orderCode = customDescription ? 999999999 : getPayosOrderCode(order.id);
  const description = customDescription ?? `BL${cleanId}`;

  const data: any = {
    orderCode,
    amount: amountToTransfer,
    description,
    accountNumber: '28642481',
    reference: `TEST-${Date.now().toString().slice(-6)}`,
    transactionDateTime: new Date().toISOString().replace('T', ' ').slice(0, 19),
    currency: 'VND',
    paymentLinkId: `test-link-${cleanId}`,
    code: '00',
    desc: 'success',
    counterAccountBankId: '970407',
    counterAccountBankName: 'Techcombank',
    counterAccountName: 'TEST USER',
    counterAccountNumber: '1903666888',
    virtualAccountName: 'CHE VAN NAM',
    virtualAccountNumber: 'LOCCASS000341696',
  };

  const signature = await payos.crypto.createSignatureFromObj(data, checksumKey);

  const payload = {
    code: '00',
    desc: 'success',
    success: true,
    data,
    signature,
  };

  const res = await fetch(`${API_URL}/checkout/payos-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const json = await res.json();
  return { status: res.status, json, sentData: data };
}

async function main() {
  const rawArgs = process.argv.slice(2).join(' ').toLowerCase();
  let mode = 'success';
  if (rawArgs.includes('under') || rawArgs.includes('thieu')) {
    mode = 'underpay';
  } else if (rawArgs.includes('wrong') || rawArgs.includes('sai')) {
    mode = 'wrong-code';
  }

  console.log('====================================================');
  console.log(`🧪 CÔNG CỤ TEST WEBHOOK PAYOS (CHẾ ĐỘ: ${mode.toUpperCase()})`);
  console.log('====================================================\n');

  // Tìm đơn PENDING còn hạn trong 60 phút gần nhất
  const sixtyMinsAgo = new Date(Date.now() - 60 * 60 * 1000);
  let order = await prisma.order.findFirst({
    where: {
      status: OrderStatus.PENDING,
      createdAt: { gte: sixtyMinsAgo },
    },
    orderBy: { createdAt: 'desc' },
    include: { items: true },
  });

  if (!order) {
    console.log('ℹ️ Không có đơn PENDING nào gần đây, tự động tạo một đơn hàng mới...');
    order = await createFreshPendingOrder();
  }

  const cleanId = order.id.replace(/-/g, '').slice(0, 8).toUpperCase();
  console.log(`📦 Đơn hàng kiểm thử: #${order.id}`);
  console.log(`   - Mã đơn hiển thị trên web: BL${cleanId}`);
  console.log(`   - Trạng thái trước khi test: ${order.status}`);
  console.log(`   - Tổng tiền đơn hàng: ${order.total.toLocaleString('vi-VN')}đ`);
  console.log(`   - Món: ${order.items.map((i) => i.productName).join(', ')}\n`);

  if (mode === 'underpay') {
    const underAmount = Math.max(1000, Math.floor(order.total / 2));
    console.log(`⚠️ KỊCH BẢN: Giả lập chuyển THIẾU TIỀN (${underAmount.toLocaleString('vi-VN')}đ < ${order.total.toLocaleString('vi-VN')}đ)`);
    const result = await sendFakePayOSWebhook(order, underAmount);
    console.log('👉 Phản hồi từ Server:', result.json);
  } else if (mode === 'wrong-code') {
    console.log(`⚠️ KỊCH BẢN: Giả lập chuyển SAI NỘI DUNG (ghi "NAM CHUYEN TIEN" thay vì "BL${cleanId}")`);
    const result = await sendFakePayOSWebhook(order, order.total, 'NAM CHUYEN TIEN');
    console.log('👉 Phản hồi từ Server:', result.json);
  } else {
    console.log(`✅ KỊCH BẢN: Giả lập chuyển ĐÚNG & ĐỦ TIỀN (${order.total.toLocaleString('vi-VN')}đ kèm nội dung "BL${cleanId}")`);
    const result = await sendFakePayOSWebhook(order, order.total);
    console.log('👉 Phản hồi từ Server:', result.json);
  }

  // Kiểm tra lại trạng thái DB sau xử lý
  const updated = await prisma.order.findUnique({
    where: { id: order.id },
  });
  console.log('\n----------------------------------------------------');
  console.log(`📊 KẾT QUẢ TRONG DATABASE SAU KHI TEST:`);
  console.log(`   - Trạng thái đơn: ${updated?.status}`);
  console.log(`   - Trạng thái kho nguyên liệu: ${updated?.inventoryState}`);
  console.log(`   - Điểm tích lũy cộng thêm: +${updated?.loyaltyPointsEarned} điểm`);
  console.log('----------------------------------------------------\n');
}

main().finally(() => prisma.$disconnect());
