import { ConflictException } from '@nestjs/common';
import { CheckoutService } from './checkout.service.js';

describe('Hủy đơn chờ và trả nguyên liệu', () => {
  const order = { id: 'order-1', userId: 'user-1', status: 'PENDING', compensationSourceId: null, inventoryState: 'RESERVED', items: [] };
  let service: CheckoutService;
  const db = { order: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() }, $queryRaw: vi.fn(), $transaction: vi.fn() };
  const inventory = { release: vi.fn() };
  const rewards = { restoreVoucher: vi.fn() };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('PAYOS_CLIENT_ID', '');
    vi.stubEnv('PAYOS_API_KEY', '');
    vi.stubEnv('PAYOS_CHECKSUM_KEY', '');
    db.order.findUnique.mockResolvedValue(order);
    db.$transaction.mockImplementation(async (callback) => callback(db));
    service = new CheckoutService(db as never, rewards as never, inventory as never, {} as never);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('hủy đơn chờ trả kho và voucher, hủy lại không trả lần thứ hai', async () => {
    expect(await service.cancelPendingOrder(order.id, order.userId)).toEqual({ status: 'CANCELLED' });
    expect(inventory.release).toHaveBeenCalledTimes(1);
    expect(rewards.restoreVoucher).toHaveBeenCalledWith(db, order.id);
    db.order.findUnique.mockResolvedValue({ ...order, status: 'CANCELLED', inventoryState: 'RELEASED' });
    await service.cancelPendingOrder(order.id, order.userId);
    expect(inventory.release).toHaveBeenCalledTimes(1);
  });

  it('đơn đã trả tiền không được hủy để lấy lại nguyên liệu', async () => {
    db.order.findUnique.mockResolvedValue({ ...order, status: 'PAID' });
    await expect(service.cancelPendingOrder(order.id, order.userId)).rejects.toThrow(ConflictException);
    expect(inventory.release).not.toHaveBeenCalled();
  });

  it('gateway đang xử lý hoặc đã nhận tiền phải giữ kho cho đến khi xác nhận', async () => {
    const get = vi.fn().mockResolvedValue({ status: 'PAID', amountPaid: 30000 });
    const cancel = vi.fn();
    Object.assign(service, { payos: { paymentRequests: { get, cancel } } });
    await expect(service.cancelPendingOrder(order.id, order.userId)).rejects.toThrow(ConflictException);
    expect(inventory.release).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('chỉ nhả kho sau khi gateway xác nhận mã thanh toán đã hủy, kể cả sau restart mất cache', async () => {
    const get = vi.fn().mockResolvedValue({ status: 'PENDING', amountPaid: 0 });
    const cancel = vi.fn().mockResolvedValue({ status: 'CANCELLED', amountPaid: 0 });
    Object.assign(service, { payos: { paymentRequests: { get, cancel } } });
    await service.cancelPendingOrder(order.id, order.userId);
    expect(get).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(inventory.release.mock.invocationCallOrder[0]);
  });

  it('một đơn dữ liệu cũ lỗi không ngăn hủy các đơn hết hạn còn lại', async () => {
    db.order.findMany.mockResolvedValue([{ id: 'bad-order' }, { id: 'good-order' }]);
    const expire = vi.spyOn(service as unknown as { cancelExpiredOrder(id: string): Promise<boolean> }, 'cancelExpiredOrder')
      .mockRejectedValueOnce(new Error('Kho cũ bị lệch')).mockResolvedValueOnce(true);
    Object.assign(service, { logger: { error: vi.fn(), log: vi.fn(), warn: vi.fn() } });
    await service.handleExpiredOrders();
    expect(expire.mock.calls).toEqual([['bad-order'], ['good-order']]);
  });
});
