import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { OrdersService } from './orders.service.js';

describe('OrdersService - Quản lý và Tạo đơn hàng (Task 6)', () => {
  const item = { productId: 'coffee', size: 'M' as const, qty: 2, lineTotal: 1 };
  const cart = {
    subtotal: 78_000,
    shortages: [],
    orderItems: [{
      productId: 'coffee',
      size: 'M',
      qty: 2,
      toppings: [],
      lineTotal: 78_000,
      recipeSnapshot: [{ ingredientId: 'beans', quantity: '48.000' }],
    }],
  };
  const prisma = {
    order: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(),
  };
  const promotions = { applyPromotion: vi.fn() };
  const rewards = { assertVoucherUsable: vi.fn() };
  const inventory = { prepareCart: vi.fn(), reserve: vi.fn() };
  const service = new OrdersService(prisma as never, promotions as never, rewards as never, inventory as never);

  beforeEach(() => {
    vi.clearAllMocks();
    inventory.prepareCart.mockResolvedValue(cart);
    inventory.reserve.mockResolvedValue(undefined);
    prisma.order.create.mockImplementation(async ({ data }) => ({ id: 'o1', ...data }));
    prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
    rewards.assertVoucherUsable.mockResolvedValue(undefined);
  });

  // 1. Kiểm tra xác thực đầu vào
  it('Bắt buộc đăng nhập và giỏ hàng không được để rỗng', async () => {
    await expect(service.create({ items: [item] }, '')).rejects.toThrow(UnauthorizedException);
    await expect(service.create({ items: [] }, 'u1')).rejects.toThrow(BadRequestException);
    expect(inventory.prepareCart).not.toHaveBeenCalled();
  });

  // 2. Kiểm tra thiếu nguyên liệu (Read-only check)
  it('Từ chối tạo đơn khi thiếu nguyên liệu ngay từ bước tiền kiểm định giỏ hàng', async () => {
    inventory.prepareCart.mockResolvedValueOnce({ ...cart, shortages: [{ ingredientName: 'Hạt cà phê' }] });
    await expect(service.create({ items: [item] }, 'u1')).rejects.toThrow('Không đủ nguyên liệu: Hạt cà phê');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // 3. Quy trình tạo đơn thành công & Giữ nguyên liệu
  it('Khóa giữ nguyên liệu (RESERVED) và lưu ảnh chụp công thức (recipeSnapshot) khi tạo đơn PENDING', async () => {
    const result = await service.create({ items: [item] }, 'u1');
    expect(inventory.prepareCart).toHaveBeenCalledTimes(2);
    expect(inventory.reserve).toHaveBeenCalledWith(prisma, cart);
    expect(prisma.order.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: 'u1',
        total: 78_000,
        status: 'PENDING',
        inventoryState: 'RESERVED',
        reservationExpiresAt: expect.any(Date),
        items: { create: cart.orderItems },
      }),
    }));
    expect(result.id).toBe('o1');
  });

  // 4. Kiểm tra toàn vẹn giá (Price integrity)
  it('Hoàn tác (Rollback) nếu giá món bị thay đổi giữa lúc xem trước và lúc bắt đầu transaction', async () => {
    inventory.prepareCart.mockResolvedValueOnce(cart).mockResolvedValueOnce({ ...cart, subtotal: 80_000 });
    await expect(service.create({ items: [item] }, 'u1')).rejects.toThrow('Giá món vừa thay đổi');
    expect(inventory.reserve).not.toHaveBeenCalled();
  });

  // 5. Kiểm tra tính voucher Zero-trust
  it('Áp dụng mã giảm giá và tính toán lại số tiền từ giá gốc trên server (Zero-trust)', async () => {
    promotions.applyPromotion.mockResolvedValue({ discountAmount: 10_000 });
    await service.create({ items: [item], promoCode: 'BREW10' }, 'u1');
    expect(promotions.applyPromotion).toHaveBeenCalledWith({ code: 'BREW10', subtotal: 78_000 });
    expect(prisma.order.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ total: 68_000, discount: 10_000, promoCode: 'BREW10' }),
    }));
  });

  // 6. Kiểm tra voucher không hợp lệ
  it('Chặn tạo đơn nếu mã giảm giá không hợp lệ hoặc người dùng không có quyền sử dụng', async () => {
    rewards.assertVoucherUsable.mockRejectedValueOnce(new BadRequestException('Mã voucher này bạn đã sử dụng rồi'));
    await expect(service.create({ items: [item], promoCode: 'USED_CODE' }, 'u1'))
      .rejects.toThrow('Mã voucher này bạn đã sử dụng rồi');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // 7. [RACE CONDITION] Xung đột giữ nguyên liệu trong transaction
  it('[Race Condition] Ném ConflictException và hủy tạo đơn khi nguyên liệu vừa bị khách khác giữ mất trong transaction', async () => {
    // Giả lập: Khách khác vừa đặt trước 1 mili-giây khiến reserve ném ConflictException
    inventory.reserve.mockRejectedValueOnce(new ConflictException('Không đủ nguyên liệu "Hạt cà phê" để đặt số lượng này'));

    await expect(service.create({ items: [item] }, 'u2')).rejects.toThrow(ConflictException);
    // Đảm bảo không tạo đơn rác khi giữ kho thất bại
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  // 8. [RACE CONDITION] Hai khách hàng cùng bấm mua 1 ly cuối cùng
  it('[Race Condition] Mô phỏng 2 khách cùng mua 1 ly cuối cùng: 1 khách thành công, 1 khách bị từ chối do hết hàng', async () => {
    // Khách 1 giữ kho thành công (resolve)
    // Khách 2 vào sau bị hết hàng (reject với ConflictException)
    inventory.reserve
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ConflictException('Không đủ nguyên liệu "Hạt cà phê" để đặt số lượng này'));

    const [res1, res2] = await Promise.allSettled([
      service.create({ items: [item] }, 'user-1'),
      service.create({ items: [item] }, 'user-2'),
    ]);

    // Khách 1 thành công
    expect(res1.status).toBe('fulfilled');
    if (res1.status === 'fulfilled') {
      expect(res1.value.id).toBe('o1');
    }

    // Khách 2 thất bại do xung đột tài nguyên
    expect(res2.status).toBe('rejected');
    if (res2.status === 'rejected') {
      expect(res2.reason).toBeInstanceOf(ConflictException);
      expect((res2.reason as ConflictException).message).toContain('Không đủ nguyên liệu "Hạt cà phê"');
    }

    // Chỉ có duy nhất 1 đơn hàng được tạo trong database
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
  });

  // 9. Lấy danh sách đơn hàng của người dùng (findAllByUser)
  it('Lấy danh sách đơn hàng của tôi (findAllByUser): từ chối nếu chưa đăng nhập, trả về danh sách sắp xếp mới nhất', async () => {
    await expect(service.findAllByUser('')).rejects.toThrow(UnauthorizedException);

    const mockOrders = [
      {
        id: 'order-1',
        userId: 'u1',
        createdAt: new Date(),
        items: [{ productId: 'p1', productName: 'Cà phê', productImageUrl: '/p1.jpg', product: { name: 'Cà phê', imageUrl: '/p1.jpg' } }],
      },
    ];
    prisma.order.findMany.mockResolvedValueOnce(mockOrders);

    const result = await service.findAllByUser('u1');
    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'desc' },
    }));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('order-1');
  });

  // 10. Xem chi tiết đơn hàng (findOne)
  it('Xem chi tiết đơn hàng (findOne): ném NotFoundException nếu đơn không tồn tại hoặc không thuộc về người dùng', async () => {
    await expect(service.findOne('order-999', '')).rejects.toThrow(UnauthorizedException);

    prisma.order.findUnique.mockResolvedValueOnce(null);
    await expect(service.findOne('order-999', 'u1')).rejects.toThrow(NotFoundException);
  });

  // 11. Giữ tên và ảnh món cũ (Snapshot fallback)
  it('Xem chi tiết đơn hàng: giữ lại tên và ảnh món cũ khi sản phẩm gốc đã bị xóa khỏi hệ thống', async () => {
    prisma.order.findUnique.mockResolvedValueOnce({
      id: 'old-order',
      items: [{ productId: null, product: null, productName: 'Món nước cổ điển', productImageUrl: '/classic.jpg' }],
      payments: [],
    });
    const result = await service.findOne('old-order', 'u1');
    expect(result.items[0].product).toEqual({ name: 'Món nước cổ điển', imageUrl: '/classic.jpg' });
  });
});
