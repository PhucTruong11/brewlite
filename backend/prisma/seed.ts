import { PrismaClient, ProductSize } from '@prisma/client';
import * as bcrypt from 'bcrypt';


const prisma = new PrismaClient();

// ==========================================
// Định nghĩa dữ liệu Menu
// ==========================================

interface ProductSeed {
  name: string;
  description?: string;
  category: string;
  allowToppings: boolean;
  imageUrl?: string;
  prices: { size: ProductSize; price: number }[];
}

const PRODUCTS: ProductSeed[] = [
  {
    name: 'Phin Sữa Đá',
    description: 'Iced Coffee with Condensed Milk',
    category: 'phin',
    allowToppings: false,
    imageUrl: '/images/phin-sua-da.jpg',
    prices: [
      { size: 'S', price: 29000 },
      { size: 'M', price: 39000 },
      { size: 'L', price: 45000 },
    ],
  },
  {
    name: 'Phin Đen Đá',
    description: 'Iced Black Coffee',
    category: 'phin',
    allowToppings: false,
    imageUrl: '/images/phin-den-da.jpg',
    prices: [
      { size: 'S', price: 29000 },
      { size: 'M', price: 35000 },
      { size: 'L', price: 39000 },
    ],
  },
  {
    name: 'Bạc Xỉu',
    description: 'Iced White Phin Coffee & Condensed Milk',
    category: 'phin',
    allowToppings: false,
    imageUrl: '/images/bac-xiu.jpg',
    prices: [
      { size: 'S', price: 29000 },
      { size: 'M', price: 39000 },
      { size: 'L', price: 45000 },
    ],
  },
  {
    name: 'Trà Thanh Đào',
    description: 'Peach Tea with Lemongrass',
    category: 'tra',
    allowToppings: true,
    imageUrl: '/images/tra-thanh-dao.jpg',
    prices: [
      { size: 'S', price: 45000 },
      { size: 'M', price: 55000 },
      { size: 'L', price: 65000 },
    ],
  },
  {
    name: 'Americano',
    description: 'Americano',
    category: 'espresso',
    allowToppings: false,
    imageUrl: '/images/americano.jpg',
    prices: [
      { size: 'S', price: 45000 },
      { size: 'M', price: 49000 },
      { size: 'L', price: 55000 },
    ],
  },
  {
    name: 'Caramel Macchiato',
    description: 'Caramel Macchiato / Mocha',
    category: 'espresso',
    allowToppings: false,
    imageUrl: '/images/caramel-macchiato.jpg',
    prices: [
      { size: 'S', price: 69000 },
      { size: 'M', price: 79000 },
      { size: 'L', price: 85000 },
    ],
  },
];

// ──────────────────────────────────────────
// DANH SÁCH TOPPING (Từ menu thực tế)
// ──────────────────────────────────────────
const TOPPINGS = [
  { name: 'Kem Sữa Mặn',      price: 9000,  imageUrl: '/images/toppings/kem-sua-man.jpg' },
  { name: 'Trân Châu Trắng',   price: 9000,  imageUrl: '/images/toppings/tran-chau-trang.jpg' },
  { name: 'Thạch Cà Phê',      price: 9000,  imageUrl: '/images/toppings/thach-ca-phe.jpg' },
];

// ──────────────────────────────────────────
// DANH SÁCH PROMOTIONS / VOUCHERS
// ──────────────────────────────────────────
const PROMOTIONS = [
  {
    code: 'WELCOME10',
    description: 'Giảm 10% cho đơn hàng từ 30k',
    discountType: 'PERCENTAGE',
    discountValue: 10,
    minOrderValue: 30000,
    maxDiscount: 15000,
    isActive: true,
  },
  {
    code: 'COFFEE20K',
    description: 'Giảm ngay 20.000đ cho đơn từ 40k',
    discountType: 'FIXED_AMOUNT',
    discountValue: 20000,
    minOrderValue: 40000,
    isActive: true,
  },
  {
    code: 'BREWLITE50',
    description: 'Giảm 50% tối đa 30.000đ',
    discountType: 'PERCENTAGE',
    discountValue: 50,
    minOrderValue: 50000,
    maxDiscount: 30000,
    isActive: true,
  },
  {
    code: 'CHAOBAN',
    description: 'Giảm 15.000đ cho đơn từ 40.000đ',
    discountType: 'FIXED_AMOUNT',
    discountValue: 15000,
    minOrderValue: 40000,
    isActive: true,
  },
  {
    code: 'BREW10',
    description: 'Giảm 10% (tối đa 25.000đ) cho mọi đơn',
    discountType: 'PERCENTAGE',
    discountValue: 10,
    minOrderValue: 0,
    maxDiscount: 25000,
    isActive: true,
  },
  {
    code: 'FREESHIP',
    description: 'Giảm 10.000đ cho đơn từ 30.000đ',
    discountType: 'FIXED_AMOUNT',
    discountValue: 10000,
    minOrderValue: 30000,
    isActive: true,
  },
  {
    code: 'TRIAN',
    description: 'Tặng 1 ly nước miễn phí (giảm 100%)',
    discountType: 'PERCENTAGE',
    discountValue: 100,
    minOrderValue: 0,
    isActive: true,
  },
];

const REWARD_CATALOG = [
  {
    code: 'REWARD10K',
    description: 'Giảm 10.000đ cho đơn hàng bất kỳ',
    discountType: 'FIXED_AMOUNT',
    discountValue: 10000,
    minOrderValue: 0,
    isActive: true,
    isRewardOnly: true,
    pointsCost: 20,
  },
  {
    code: 'REWARD20K',
    description: 'Giảm 20.000đ cho đơn từ 70.000đ',
    discountType: 'FIXED_AMOUNT',
    discountValue: 20000,
    minOrderValue: 70000,
    isActive: true,
    isRewardOnly: true,
    pointsCost: 40,
  },
  {
    code: 'REWARD50K',
    description: 'Giảm 50.000đ cho đơn từ 150.000đ',
    discountType: 'FIXED_AMOUNT',
    discountValue: 50000,
    minOrderValue: 150000,
    isActive: true,
    isRewardOnly: true,
    pointsCost: 90,
  },
];

// ==========================================
// Hàm Seed
// ==========================================

async function main() {
  console.log('🌱 Seeding database...\n');

  // Seed chỉ dành cho DB trống; không đụng vào dữ liệu của thành viên khác.
  const [usersCount, productsCount, toppingsCount, ingredientsCount, ordersCount] = await Promise.all([
    prisma.user.count(), prisma.product.count(), prisma.topping.count(),
    prisma.ingredient.count(), prisma.order.count(),
  ]);
  if (usersCount || productsCount || toppingsCount || ingredientsCount || ordersCount) {
    throw new Error('DB đã có dữ liệu. Không chạy seed; hãy dùng prisma migrate deploy.');
  }

  const selectedProductNames = new Set([
    'Phin Đen Đá', 'Phin Sữa Đá', 'Bạc Xỉu',
    'Americano', 'Caramel Macchiato', 'Trà Thanh Đào',
  ]);
  const selectedToppingNames = new Set(['Kem Sữa Mặn', 'Trân Châu Trắng', 'Thạch Cà Phê']);

  // ── Bước 1: Tạo User mẫu để test Payment ──
  console.log('👤 Đang tạo Users mẫu...');
  const testUser = await prisma.user.create({
    data: {
      email: 'test@brewlite.com',
      passwordHash: '$2b$10$placeholder_hash_for_testing_only',
      loyaltyPoints: 0,
    },
  });
  console.log(`   ✅ Đã tạo user: ${testUser.email} (id: ${testUser.id})`);

  // ── Bước 2: Tạo Toppings ──
  console.log('🍡 Đang tạo Toppings...');
  const toppings = await Promise.all(
    TOPPINGS.filter((t) => selectedToppingNames.has(t.name)).map((t) =>
      prisma.topping.create({ data: t }),
    ),
  );
  console.log(`   ✅ Đã tạo ${toppings.length} toppings`);

  // ── Bước 3: Tạo Products + ProductPrices ──
  console.log('☕ Đang tạo Products...');
  let productCount = 0;
  let priceCount = 0;

  for (const p of PRODUCTS.filter((entry) => selectedProductNames.has(entry.name))) {
    const product = await prisma.product.create({
      data: {
        name: p.name,
        description: p.description,
        imageUrl: p.imageUrl,
        category: p.category,
        allowToppings: p.allowToppings,
        prices: {
          create: p.prices.map((pr) => ({
            size: pr.size,
            price: pr.price,
          })),
        },
      },
      include: { prices: true },
    });

    productCount++;
    priceCount += product.prices.length;
  }

  console.log(`   ✅ Đã tạo ${productCount} sản phẩm với ${priceCount} mức giá`);
  // ── Bước 4: Tạo Order mẫu để test Payment ──
  console.log('🧾 Đang tạo Orders mẫu (PENDING) để test Payment...');

  // Lấy sản phẩm đầu tiên để gắn vào order item
  const firstProduct = await prisma.product.findFirst({
    where: { name: 'Phin Sữa Đá' },
    include: { prices: true },
  });

  const orders = await Promise.all([
    // Order 1: Phin Sữa Đá size M - 39,000đ
    prisma.order.create({
      data: {
        userId: testUser.id,
        status: 'PENDING',
        total: 39000,
        items: {
          create: firstProduct ? [{
            productId: firstProduct.id,
            productName: firstProduct.name,
            productImageUrl: firstProduct.imageUrl,
            size: 'M',
            toppings: [],
            qty: 1,
            lineTotal: 39000,
          }] : [],
        },
      },
    }),
    // Order 2: 2 món - 78,000đ
    prisma.order.create({
      data: {
        userId: testUser.id,
        status: 'PENDING',
        total: 78000,
        items: {
          create: firstProduct ? [{
            productId: firstProduct.id,
            productName: firstProduct.name,
            productImageUrl: firstProduct.imageUrl,
            size: 'M',
            toppings: [],
            qty: 2,
            lineTotal: 78000,
          }] : [],
        },
      },
    }),
    // Order 3: Đã PAID (để test chặn thanh toán lại)
    prisma.order.create({
      data: {
        userId: testUser.id,
        status: 'PAID',
        total: 45000,
        loyaltyPointsEarned: 4,
      },
    }),
  ]);

  console.log(`   ✅ Đã tạo ${orders.length} orders mẫu`);
  console.log(`   📋 Order PENDING 1 (39k): ${orders[0].id}`);
  console.log(`   📋 Order PENDING 2 (78k): ${orders[1].id}`);
  console.log(`   📋 Order PAID     (45k): ${orders[2].id}`);

  // ── Bước 5: Tạo Promotions ──
  console.log('🎟️  Đang tạo Promotions...');
  const promotions = await Promise.all(
    PROMOTIONS.map((p) =>
      prisma.promotion.create({ data: p }),
    ),
  );
  
  console.log(`   ✅ Đã tạo ${promotions.length} mã ưu đãi`);

   // ── Bước 5b: Tạo voucher đổi điểm + danh mục quà ──
  console.log('🎁 Đang tạo danh mục đổi điểm...');
  for (const r of REWARD_CATALOG) {
    const { pointsCost, ...promoData } = r;
    const promo = await prisma.promotion.create({ data: promoData });
    await prisma.rewardItem.create({
      data: {
        name: promo.description ?? promo.code,
        description: promo.description,
        pointsCost,
        promotionId: promo.id,
      },
    });
  }
  console.log(`   ✅ Đã tạo ${REWARD_CATALOG.length} quà đổi điểm`);

  // ── Tổng kết ──
  console.log('\n🎉 Seeding hoàn tất!');
  console.log('────────────────────────────────────────');
  console.log(`   Toppings:       ${toppings.length}`);
  console.log(`   Products:       ${productCount}`);
  console.log(`   Product Prices: ${priceCount}`);
  console.log(`   Users:          1 (test@brewlite.com)`);
  console.log(`   Orders:         ${orders.length} (2 PENDING, 1 PAID)`);
  console.log('────────────────────────────────────────');
  console.log('\n💡 Test Payment API:');
  console.log(`   POST http://localhost:3001/api/payments`);
  console.log(`   Body: { "orderId": "${orders[0].id}", "method": "EWALLET" }`);
  console.log(`   Header: Idempotency-Key: <random-uuid>`);
  console.log('────────────────────────────────────────');
  console.log(`   Promotions:     ${promotions.length}`);

// --- TẠO ADMIN MẶC ĐỊNH ---
  const adminEmail = 'admin@brewlite.com';
  const adminPassword = '@Admin123';

  const existingAdmin = await prisma.user.findUnique({
    where: { email: adminEmail },
  });

  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash(adminPassword, 10);

    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: passwordHash,
        fullName: 'System Administrator',
        role: 'ADMIN' as any, // Dùng 'ADMIN' ép type đơn giản, không bị đụng lỗi import Role
        emailVerifiedAt: new Date(),
      },
    });

    console.log('✅ Đã khởi tạo tài khoản Admin mặc định thành công!');
    console.log(`   Email: ${adminEmail}`);
    console.log(`   Password: ${adminPassword}`);
  } else {
    console.log('ℹ️ Tài khoản Admin đã tồn tại.');
  }
}


main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });