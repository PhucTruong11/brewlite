import { describe, expect, it } from 'vitest';
import { successfulCheckoutPayment } from './checkout';

describe('Hóa đơn sau khi refresh', () => {
  it('giữ mã, thời gian và phương thức giao dịch thành công; không lấy lần thử thất bại', () => {
    const payment = successfulCheckoutPayment([
      { id: 'failed', status: 'FAILED', method: 'EWALLET', createdAt: '2026-11-11T01:05:00Z' },
      { id: 'paid-card', status: 'SUCCESS', method: 'CARD', createdAt: '2026-11-11T01:00:00Z' },
    ]);
    expect(payment).toEqual({ id: 'paid-card', status: 'SUCCESS', method: 'CARD', createdAt: '2026-11-11T01:00:00Z' });
  });

  it('chọn giao dịch thành công mới nhất mà không đổi mảng dữ liệu máy chủ', () => {
    const payments = [
      { id: 'older', status: 'SUCCESS', method: 'EWALLET' as const, createdAt: '2026-11-10T01:00:00Z' },
      { id: 'newer', status: 'SUCCESS', method: 'EWALLET' as const, createdAt: '2026-11-11T01:00:00Z' },
    ];
    expect(successfulCheckoutPayment(payments)?.id).toBe('newer');
    expect(payments[0].id).toBe('older');
  });

  it('không giả lập giao dịch khi chưa có thanh toán thành công', () => {
    expect(successfulCheckoutPayment()).toBeUndefined();
    expect(successfulCheckoutPayment([{ id: 'failed', status: 'FAILED', method: 'CARD', createdAt: '2026-11-11T01:00:00Z' }])).toBeUndefined();
  });
});
