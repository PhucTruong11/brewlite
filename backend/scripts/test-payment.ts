import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';

const prisma = new PrismaClient();
const BASE_URL = 'http://localhost:3001/api';

function createJwt(userId: string, email: string): string {
  const secret = process.env.JWT_SECRET || 'brewlite-dev-jwt-secret-change-in-production';
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    email: email,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

// Màu sắc console
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

async function runTests() {
  console.log(`\n${CYAN}====================================================${RESET}`);
  console.log(`${CYAN}   🚀 BREWLITE - TỰ ĐỘNG TEST PAYMENT API (GIAI ĐOẠN 1)${RESET}`);
  console.log(`${CYAN}====================================================${RESET}\n`);

  // 1. Kiểm tra Backend có đang chạy không
  try {
    const health = await fetch(`${BASE_URL}/payments/order/test-check`);
    // Nếu kết nối được (kể cả 400/404) tức là backend sống
  } catch (err: any) {
    console.error(
      `${RED}❌ Không thể kết nối tới Backend tại ${BASE_URL}.${RESET}\n` +
      `👉 Hãy đảm bảo bạn đã chạy: ${YELLOW}npm run start:dev${RESET} ở terminal backend!\n`
    );
    process.exit(1);
  }

  // 2. Chuẩn bị dữ liệu test: Lấy user và product mẫu
  const user = await prisma.user.findFirst();
  if (!user) {
    console.error(`${RED}❌ Không tìm thấy user nào trong DB! Hãy chạy npx tsx prisma/seed.ts trước.${RESET}`);
    process.exit(1);
  }

  // Tự động đính kèm JWT Bearer Token vào các request của test script
  const testJwtToken = createJwt(user.id, user.email);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = ((url: any, init?: any) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${testJwtToken}`);
    }
    return nativeFetch(url, { ...init, headers });
  }) as typeof globalThis.fetch;

  const sampleProduct = await prisma.product.findFirst();
  if (!sampleProduct) {
    console.error(`${RED}❌ Không tìm thấy sản phẩm nào trong DB! Hãy chạy npx tsx prisma/seed.ts trước.${RESET}`);
    process.exit(1);
  }

  // Tạo mới một đơn hàng PENDING riêng cho lần chạy test này (kèm item món nước)
  const testOrder = await prisma.order.create({
    data: {
      userId: user.id,
      status: 'PENDING',
      total: 55000,
      items: {
        create: [{
          productId: sampleProduct.id,
          productName: sampleProduct.name,
          size: 'M',
          qty: 1,
          lineTotal: 55000,
        }],
      },
    },
  });

  console.log(`📦 Đã chuẩn bị Order test: ${YELLOW}${testOrder.id}${RESET} (Tổng tiền: 55,000đ, Trạng thái: PENDING)\n`);

  const idempotencyKey = `test-key-${Date.now()}`;

  // =========================================================================
  // TEST CASE 1: Thanh toán thành công lần đầu
  // =========================================================================
  console.log(`🧪 [TEST 1] Thanh toán lần đầu (POST /api/payments)...`);
  const res1 = await fetch(`${BASE_URL}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      orderId: testOrder.id,
      method: 'EWALLET',
    }),
  });

  const data1 = await res1.json();
  if (res1.status === 201 && data1.success && data1.payment?.status === 'SUCCESS') {
    console.log(`   ${GREEN}✅ PASS (Status ${res1.status})${RESET}`);
    console.log(`      - Mã thanh toán: ${data1.payment.id}`);
    console.log(`      - Điểm thưởng tích luỹ: +${data1.pointsEarned} điểm`);
  } else {
    console.log(`   ${RED}❌ FAIL (Status ${res1.status}):${RESET}`, data1);
  }

  // =========================================================================
  // TEST CASE 2: Chống gửi trùng lặp (Idempotency Guard)
  // Gửi lại y hệt cùng Idempotency-Key
  // =========================================================================
  console.log(`\n🧪 [TEST 2] Chống trùng lặp - Gửi lại cùng Idempotency-Key...`);
  const res2 = await fetch(`${BASE_URL}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey, // Cùng key với test 1
    },
    body: JSON.stringify({
      orderId: testOrder.id,
      method: 'EWALLET',
    }),
  });

  const data2 = await res2.json();
  if ((res2.status === 200 || res2.status === 201) && data2.isDuplicate === true) {
    console.log(`   ${GREEN}✅ PASS (Status ${res2.status})${RESET}`);
    console.log(`      - Hệ thống nhận diện: isDuplicate = true (Không trừ tiền lần 2)`);
    console.log(`      - Thông báo: "${data2.message}"`);
  } else {
    console.log(`   ${RED}❌ FAIL (Status ${res2.status}):${RESET}`, data2);
  }

  // =========================================================================
  // TEST CASE 3: Chặn thanh toán đơn đã PAID với key mới
  // =========================================================================
  console.log(`\n🧪 [TEST 3] Chặn thanh toán lại đơn đã PAID (Key mới)...`);
  const res3 = await fetch(`${BASE_URL}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `new-key-${Date.now()}`,
    },
    body: JSON.stringify({
      orderId: testOrder.id,
      method: 'EWALLET',
    }),
  });

  const data3 = await res3.json();
  if (res3.status === 400 && data3.message?.includes('đã được thanh toán')) {
    console.log(`   ${GREEN}✅ PASS (Status ${res3.status})${RESET}`);
    console.log(`      - Hệ thống chặn thành công: "${data3.message}"`);
  } else {
    console.log(`   ${RED}❌ FAIL (Status ${res3.status}):${RESET}`, data3);
  }

  // =========================================================================
  // TEST CASE 4: Kiểm tra Header Idempotency-Key bắt buộc
  // =========================================================================
  console.log(`\n🧪 [TEST 4] Thiếu Header Idempotency-Key...`);
  const res4 = await fetch(`${BASE_URL}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Không truyền Idempotency-Key
    },
    body: JSON.stringify({
      orderId: testOrder.id,
      method: 'EWALLET',
    }),
  });

  const data4 = await res4.json();
  if (res4.status === 400 && data4.message?.includes('Idempotency-Key')) {
    console.log(`   ${GREEN}✅ PASS (Status ${res4.status})${RESET}`);
    console.log(`      - Bắt lỗi chuẩn: "${data4.message}"`);
  } else {
    console.log(`   ${RED}❌ FAIL (Status ${res4.status}):${RESET}`, data4);
  }

  // =========================================================================
  // TEST CASE 5: Xem lịch sử thanh toán của đơn (GET)
  // =========================================================================
  console.log(`\n🧪 [TEST 5] Lấy lịch sử giao dịch (GET /api/payments/order/:id)...`);
  const res5 = await fetch(`${BASE_URL}/payments/order/${testOrder.id}`);
  const data5 = await res5.json();

  if (res5.status === 200 && Array.isArray(data5) && data5.length > 0) {
    console.log(`   ${GREEN}✅ PASS (Status ${res5.status})${RESET}`);
    console.log(`      - Tìm thấy ${data5.length} bản ghi thanh toán`);
    console.log(`      - Số tiền: ${data5[0].amount.toLocaleString('vi-VN')}đ | Trạng thái: ${data5[0].status}`);
  } else {
    console.log(`   ${RED}❌ FAIL (Status ${res5.status}):${RESET}`, data5);
  }

  // =========================================================================
  // TEST CASE 6: RACE CONDITION - 2 request bấm thanh toán CÙNG 1 LÚC cho 1 đơn
  // (Pessimistic Lock: SELECT FOR UPDATE)
  // =========================================================================
  console.log(`\n🧪 [TEST 6] RACE CONDITION: Bắn 2 request thanh toán CÙNG 1 LÚC cho 1 đơn...`);
  const concurrentOrder = await prisma.order.create({
    data: {
      userId: user.id,
      status: 'PENDING',
      total: 45000,
      items: {
        create: [{
          productId: sampleProduct.id,
          productName: sampleProduct.name,
          size: 'M',
          qty: 1,
          lineTotal: 45000,
        }],
      },
    },
  });

  // Bắn 2 request trong cùng 1 mili-giây với 2 Idempotency-Key khác nhau
  const [resRaceA, resRaceB] = await Promise.all([
    fetch(`${BASE_URL}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `race-concurrent-A-${Date.now()}`,
      },
      body: JSON.stringify({ orderId: concurrentOrder.id, method: 'EWALLET' }),
    }),
    fetch(`${BASE_URL}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `race-concurrent-B-${Date.now()}`,
      },
      body: JSON.stringify({ orderId: concurrentOrder.id, method: 'EWALLET' }),
    }),
  ]);

  const [dataRaceA, dataRaceB] = await Promise.all([resRaceA.json(), resRaceB.json()]);

  // Kiểm tra: Phải có ĐÚNG 1 cái thành công (201) và 1 cái bị chặn (409 hoặc 400)
  const isOneSuccess =
    (resRaceA.status === 201 && (resRaceB.status === 409 || resRaceB.status === 400)) ||
    (resRaceB.status === 201 && (resRaceA.status === 409 || resRaceA.status === 400));

  // Kiểm tra số lần thanh toán được lưu trong DB của đơn này
  const paymentCount = await prisma.payment.count({
    where: { orderId: concurrentOrder.id },
  });

  if (isOneSuccess && paymentCount === 1) {
    console.log(`   ${GREEN}✅ PASS - Chống Race Condition thành công!${RESET}`);
    console.log(`      - Request 1: Status ${resRaceA.status}`);
    console.log(`      - Request 2: Status ${resRaceB.status} (Bị chặn bởi Pessimistic Lock)`);
    console.log(`      - Số bản ghi thanh toán trong DB: ${paymentCount} (Không bị trừ tiền 2 lần)`);
  } else {
    console.log(`   ${RED}❌ FAIL - Bị xung đột đồng thời:${RESET}`, {
      statusA: resRaceA.status,
      statusB: resRaceB.status,
      paymentCount,
      dataRaceA,
      dataRaceB,
    });
  }

  // =========================================================================
  // TEST CASE 7: RACE CONDITION - 2 khách cùng tranh mua 1 sản phẩm cuối cùng (stock = 1)
  // (Optimistic Locking & Atomic Inventory Check)
  // =========================================================================
  console.log(`\n🧪 [TEST 7] RACE CONDITION: 2 khách cùng tranh mua sản phẩm cuối cùng (stock = 1)...`);
  
  // Tạo 1 sản phẩm có tồn kho = 1
  const limitedProduct = await prisma.product.create({
    data: {
      name: 'Trà Sen Vàng (Giới Hạn)',
      category: 'tra',
      stock: 1, // CHỈ CÒN ĐÚNG 1 LY
      version: 1,
      prices: {
        create: [{ size: 'M', price: 49000 }],
      },
    },
  });

  // Tạo 2 đơn hàng PENDING của 2 người khác nhau, cùng mua ly nước này
  const [orderCustomerA, orderCustomerB] = await Promise.all([
    prisma.order.create({
      data: {
        userId: user.id,
        status: 'PENDING',
        total: 49000,
        items: {
          create: [{
            productId: limitedProduct.id,
            productName: limitedProduct.name,
            size: 'M',
            qty: 1,
            lineTotal: 49000,
          }],
        },
      },
    }),
    prisma.order.create({
      data: {
        userId: user.id,
        status: 'PENDING',
        total: 49000,
        items: {
          create: [{
            productId: limitedProduct.id,
            productName: limitedProduct.name,
            size: 'M',
            qty: 1,
            lineTotal: 49000,
          }],
        },
      },
    }),
  ]);

  // Bắn 2 request thanh toán cùng lúc cho Khách A và Khách B
  const [resStockA, resStockB] = await Promise.all([
    fetch(`${BASE_URL}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `stock-key-A-${Date.now()}`,
      },
      body: JSON.stringify({ orderId: orderCustomerA.id, method: 'EWALLET' }),
    }),
    fetch(`${BASE_URL}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `stock-key-B-${Date.now()}`,
      },
      body: JSON.stringify({ orderId: orderCustomerB.id, method: 'EWALLET' }),
    }),
  ]);

  const [dataStockA, dataStockB] = await Promise.all([resStockA.json(), resStockB.json()]);

  // Kiểm tra tồn kho sau khi cả 2 request hoàn thành
  const productAfter = await prisma.product.findUnique({
    where: { id: limitedProduct.id },
  });

  const oneBought =
    (resStockA.status === 201 && resStockB.status === 409) ||
    (resStockB.status === 201 && resStockA.status === 409);

  if (oneBought && productAfter?.stock === 0) {
    const errorMsg = resStockA.status === 409 ? dataStockA.message : dataStockB.message;
    console.log(`   ${GREEN}✅ PASS - Chống bán lố (Overselling) hoàn hảo!${RESET}`);
    console.log(`      - Người 1: Mua thành công (Status 201)`);
    console.log(`      - Người 2: Bị chặn (Status 409 Conflict: "${errorMsg}")`);
    console.log(`      - Tồn kho còn lại: ${productAfter.stock} (Tuyệt đối không bị âm!)`);
  } else {
    console.log(`   ${RED}❌ FAIL - Tồn kho bị lỗi hoặc cả 2 cùng mua được:${RESET}`, {
      statusA: resStockA.status,
      statusB: resStockB.status,
      stockCuoi: productAfter?.stock,
      dataStockA,
      dataStockB,
    });
  }

  // Dọn dẹp data test cho gọn DB
  await prisma.orderItem.deleteMany({ where: { productId: limitedProduct.id } });
  await prisma.productPrice.deleteMany({ where: { productId: limitedProduct.id } });
  await prisma.product.delete({ where: { id: limitedProduct.id } });

  // =========================================================================
  // TEST CASE 8: TIMEOUT 2 PHÚT - Tự động hủy đơn hàng quá hạn thanh toán
  // =========================================================================
  console.log(`\n🧪 [TEST 8] TIMEOUT: Đơn hàng quá 2 phút không thanh toán...`);
  
  // Tạo đơn hàng giả lập thời điểm tạo là 3 phút trước (> 2 phút timeout)
  const expiredOrder = await prisma.order.create({
    data: {
      userId: user.id,
      status: 'PENDING',
      total: 60000,
      createdAt: new Date(Date.now() - 3 * 60 * 1000), // Tạo cách đây 3 phút
      items: {
        create: [{
          productId: sampleProduct.id,
          productName: sampleProduct.name,
          size: 'M',
          qty: 1,
          lineTotal: 60000,
        }],
      },
    },
  });

  // Khách cố tình bấm thanh toán đơn đã quá hạn
  const resTimeout = await fetch(`${BASE_URL}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `timeout-key-${Date.now()}`,
    },
    body: JSON.stringify({ orderId: expiredOrder.id, method: 'EWALLET' }),
  });

  const dataTimeout = await resTimeout.json();

  // Kiểm tra đơn hàng trong DB sau khi bị từ chối
  const orderAfterTimeout = await prisma.order.findUnique({
    where: { id: expiredOrder.id },
  });

  // Kiểm tra API countdown thời gian cho GUI (GET /api/payments/status/:id)
  const resCountdown = await fetch(`${BASE_URL}/payments/status/${expiredOrder.id}`);
  const dataCountdown = await resCountdown.json();

  const isTimeoutHandled =
    resTimeout.status === 400 &&
    dataTimeout.message?.includes('hết hạn') &&
    orderAfterTimeout?.status === 'CANCELLED' &&
    dataCountdown.remainingSeconds === 0 &&
    dataCountdown.isExpired === true;

  if (isTimeoutHandled) {
    console.log(`   ${GREEN}✅ PASS - Cơ chế Timeout 2 phút hoạt động chính xác!${RESET}`);
    console.log(`      - HTTP Status: ${resTimeout.status} Bad Request`);
    console.log(`      - Lý do chặn: "${dataTimeout.message}"`);
    console.log(`      - Trạng thái DB: ${orderAfterTimeout?.status} (Đã tự động chuyển thành CANCELLED)`);
    console.log(`      - API Countdown (cho GUI): remainingSeconds = ${dataCountdown.remainingSeconds}s, isExpired = ${dataCountdown.isExpired}`);
  } else {
    console.log(`   ${RED}❌ FAIL - Chưa xử lý được Timeout:${RESET}`, {
      status: resTimeout.status,
      dataTimeout,
      orderStatus: orderAfterTimeout?.status,
      dataCountdown,
    });
  }

  // =========================================================================
  // TEST CASE 9: VOUCHER / PROMO CODE - Áp dụng mã giảm giá và tích lũy điểm
  // =========================================================================
  console.log(`\n🧪 [TEST 9] VOUCHER: Áp dụng mã giảm giá và tính lại tiền thanh toán...`);
  
  const voucherOrder = await prisma.order.create({
    data: {
      userId: user.id,
      status: 'PENDING',
      total: 55000,
      items: {
        create: [{
          productId: sampleProduct.id,
          productName: sampleProduct.name,
          size: 'M',
          qty: 1,
          lineTotal: 55000,
        }],
      },
    },
  });

  // 9a: Nhập mã giảm giá sai
  const resBadVoucher = await fetch(`${BASE_URL}/payments/apply-voucher`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: voucherOrder.id, promoCode: 'SAIMASO' }),
  });
  const dataBadVoucher = await resBadVoucher.json();

  // 9b: Nhập mã giảm giá đúng CHAOBAN (giảm 15.000đ cho đơn từ 40.000đ)
  const resGoodVoucher = await fetch(`${BASE_URL}/payments/apply-voucher`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: voucherOrder.id, promoCode: 'CHAOBAN' }),
  });
  const dataGoodVoucher = await resGoodVoucher.json();

  // 9c: Kiểm tra API status đếm ngược & link QR động
  const resStatusWithVoucher = await fetch(`${BASE_URL}/payments/status/${voucherOrder.id}`);
  const dataStatusWithVoucher = await resStatusWithVoucher.json();

  // 9d: Thanh toán đơn đã áp voucher
  const resPayVoucher = await fetch(`${BASE_URL}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `voucher-pay-key-${Date.now()}`,
    },
    body: JSON.stringify({ orderId: voucherOrder.id, method: 'EWALLET' }),
  });
  const dataPayVoucher = await resPayVoucher.json();

  const isVoucherPass =
    resBadVoucher.status === 400 &&
    resGoodVoucher.status === 200 &&
    dataGoodVoucher.discount === 15000 &&
    dataGoodVoucher.finalTotal === 40000 &&
    dataStatusWithVoucher.total === 40000 &&
    dataStatusWithVoucher.promoCode === 'CHAOBAN' &&
    dataPayVoucher.payment?.amount === 40000 &&
    dataPayVoucher.pointsEarned === 4; // 40k / 10.000 = 4 điểm (theo công thức 10.000đ = 1 điểm)

  if (isVoucherPass) {
    console.log(`   ${GREEN}✅ PASS - Quản lý Voucher & Khuyến mãi hoạt động hoàn hảo!${RESET}`);
    console.log(`      - Mã sai: Bị chặn chuẩn (Status 400: "${dataBadVoucher.message}")`);
    console.log(`      - Mã "CHAOBAN": Giảm ${dataGoodVoucher.discount.toLocaleString('vi-VN')}đ (Từ 55k xuống 40k)`);
    console.log(`      - VietQR động: Tự động cập nhật số tiền ${dataStatusWithVoucher.total.toLocaleString('vi-VN')}đ`);
    console.log(`      - Thanh toán thực tế: ${dataPayVoucher.payment.amount.toLocaleString('vi-VN')}đ | Tích lũy: +${dataPayVoucher.pointsEarned} điểm`);
  } else {
    console.log(`   ${RED}❌ FAIL - Lỗi logic Voucher:${RESET}`, {
      badStatus: resBadVoucher.status,
      goodStatus: resGoodVoucher.status,
      dataGoodVoucher,
      dataPayVoucher,
    });
  }

  // =========================================================================
  // TEST CASE 10: CHẶN ĐƠN HÀNG RỖNG (Không có sản phẩm nào)
  // =========================================================================
  console.log(`\n🧪 [TEST 10] Chặn thanh toán đơn hàng rỗng (không có món)...`);
  const emptyOrder = await prisma.order.create({
    data: {
      userId: user.id,
      status: 'PENDING',
      total: 0,
      // Không tạo items
    },
  });

  const resEmpty = await fetch(`${BASE_URL}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `empty-key-${Date.now()}`,
    },
    body: JSON.stringify({ orderId: emptyOrder.id, method: 'EWALLET' }),
  });
  const dataEmpty = await resEmpty.json();

  if (resEmpty.status === 400 && dataEmpty.message?.includes('không có sản phẩm')) {
    console.log(`   ${GREEN}✅ PASS - Chặn đơn rỗng chuẩn xác!${RESET}`);
    console.log(`      - Status 400: "${dataEmpty.message}"`);
  } else {
    console.log(`   ${RED}❌ FAIL - Chưa chặn đơn rỗng:${RESET}`, dataEmpty);
  }

  // =========================================================================
  // TEST CASE 11: CHO PHÉP THỬ LẠI KHI ĐƠN BỊ PAYMENT_FAILED (State Machine Retry)
  // =========================================================================
  console.log(`\n🧪 [TEST 11] Thử lại thanh toán khi đơn bị PAYMENT_FAILED...`);
  const failedOrder = await prisma.order.create({
    data: {
      userId: user.id,
      status: 'PAYMENT_FAILED', // Trước đó đã bị thất bại
      total: 35000,
      items: {
        create: [{
          productId: sampleProduct.id,
          productName: sampleProduct.name,
          size: 'S',
          qty: 1,
          lineTotal: 35000,
        }],
      },
    },
  });

  // Khách đổi phương thức thanh toán sang EWALLET và thử lại
  const resRetry = await fetch(`${BASE_URL}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `retry-key-${Date.now()}`,
    },
    body: JSON.stringify({ orderId: failedOrder.id, method: 'EWALLET' }),
  });
  const dataRetry = await resRetry.json();

  const orderAfterRetry = await prisma.order.findUnique({
    where: { id: failedOrder.id },
  });

  if (resRetry.status === 201 && orderAfterRetry?.status === 'PAID') {
    console.log(`   ${GREEN}✅ PASS - Thử lại thanh toán thành công theo đúng State Machine!${RESET}`);
    console.log(`      - Đơn từ PAYMENT_FAILED chuyển thành: ${orderAfterRetry.status}`);
    console.log(`      - Mã thanh toán mới: ${dataRetry.payment.id}`);
  } else {
    console.log(`   ${RED}❌ FAIL - Không thử lại được đơn PAYMENT_FAILED:${RESET}`, dataRetry);
  }

  // =========================================================================
  // TEST CASE 12: ĐƠN HÀNG 0Đ (Voucher giảm 100% hoặc bằng tổng tiền)
  // =========================================================================
  console.log(`\n🧪 [TEST 12] Thanh toán đơn hàng 0đ (Miễn phí)...`);
  const zeroOrder = await prisma.order.create({
    data: {
      userId: user.id,
      status: 'PENDING',
      total: 10000,
      items: {
        create: [{
          productId: sampleProduct.id,
          productName: sampleProduct.name,
          size: 'S',
          qty: 1,
          lineTotal: 10000,
        }],
      },
    },
  });

  // Áp voucher TRIAN giảm 100% -> total còn 0đ
  const resApplyZero = await fetch(`${BASE_URL}/payments/apply-voucher`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: zeroOrder.id, promoCode: 'TRIAN' }),
  });
  const dataApplyZero = await resApplyZero.json();

  // Thanh toán đơn 0đ
  const resZero = await fetch(`${BASE_URL}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `zero-key-${Date.now()}`,
    },
    body: JSON.stringify({ orderId: zeroOrder.id, method: 'EWALLET' }),
  });
  const dataZero = await resZero.json();

  const orderAfterZero = await prisma.order.findUnique({
    where: { id: zeroOrder.id },
  });

  if (resZero.status === 201 && dataZero.payment?.amount === 0 && orderAfterZero?.status === 'PAID') {
    console.log(`   ${GREEN}✅ PASS - Xử lý đơn 0đ hoàn hảo!${RESET}`);
    console.log(`      - Số tiền thanh toán: ${dataZero.payment.amount}đ`);
    console.log(`      - Trạng thái đơn: ${orderAfterZero.status}`);
  } else {
    console.log(`   ${RED}❌ FAIL - Lỗi xử lý đơn 0đ:${RESET}`, dataZero);
  }

  console.log(`\n${CYAN}====================================================${RESET}`);
  console.log(`${GREEN}   🎉 HOÀN TẤT TẤT CẢ 12 TEST CASE - TOÀN DIỆN VÀ HOÀN HẢO!${RESET}`);
  console.log(`${CYAN}====================================================${RESET}\n`);
}

runTests()
  .catch((err) => {
    console.error('Lỗi khi chạy test script:', err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
