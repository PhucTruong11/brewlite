'use client';

import { Suspense, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import api from '@/lib/api';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { CartStickyBar } from '@/components/cart/CartStickyBar';
import { OrderStatusBadge, OrderStatusStepper } from '@/components/orders/OrderStatus';
import { formatVND } from '@/lib/utils';
import { replacementCheckoutHref } from '@/lib/order-compensation';

import type { Order } from '@/types';
import { useAuth } from '@/hooks/useAuth';

interface OrderItem {
  id: string;
  productId: string;
  size: 'S' | 'M' | 'L';
  toppings: string[];
  qty: number;
  lineTotal: number;
  product: {
    name: string;
    imageUrl: string | null;
  };
}

type OrderWithItems = Omit<Order, 'items'> & {
  items: OrderItem[];
  compensationIssued?: { amount: number; replacements?: { id: string; status: Order['status'] }[] } | null;
  compensationSourceId?: string | null;
  compensationSource?: { amount: number } | null;
};

const ACTIVE_ORDER_STATUSES: Order['status'][] = [
  'PENDING',
  'PAID',
  'PREPARING',
  'READY',
];

function isOrderStatus(value: unknown): value is Order['status'] {
  return [
    ...ACTIVE_ORDER_STATUSES,
    'COMPLETED',
    'PAYMENT_FAILED',
    'CANCELLED',
  ].includes(value as Order['status']);
}

function formatVietnameseDateTime(iso: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

function OrderItemRow({ item }: { item: OrderItem }) {
  return (
    <div className="flex gap-4 border-b border-primary/10 py-3.5 last:border-b-0">
      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-primary/15 bg-primary/5">
        {item.product.imageUrl ? (
          <Image
            src={item.product.imageUrl}
            alt={item.product.name}
            fill
            className="object-cover"
            sizes="64px"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xl">
            ☕
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col justify-center">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-bold text-text">
            {item.product.name}{' '}
            <span className="text-xs font-semibold text-text/60">
              (Size {item.size}) x{item.qty}
            </span>
          </p>
          <p className="whitespace-nowrap text-sm font-extrabold text-primary">
            {formatVND(item.lineTotal)}
          </p>
        </div>
        {item.toppings.length > 0 && (
          <p className="mt-1 text-xs text-text/60">{item.toppings.join(', ')}</p>
        )}
      </div>
    </div>
  );
}

function OrderDetailContent() {
  const { user } = useAuth();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();

  const orderId = typeof params?.id === 'string' ? params.id : undefined;
  const isConfirmation = searchParams.get('confirmed') === '1';

  const validOrderId = !!orderId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId);
  const { data: order, isPending, error: requestError, refetch } = useQuery({
    queryKey: ['orders', user?.id, 'detail', orderId],
    enabled: validOrderId && !!user,
    queryFn: async ({ signal }) => {
      const res = await api.get<{ data: OrderWithItems }>(`/orders/${orderId}`, { signal });
      const nextOrder = res.data.data;
      if (!nextOrder || nextOrder.id !== orderId || !isOrderStatus(nextOrder.status)) {
        throw new Error('Thông tin đơn hàng không hợp lệ');
      }
      return nextOrder;
    },
    refetchInterval: (query) => {
      const error = query.state.error;
      if (isAxiosError(error) && error.response && error.response.status < 500) return false;
      const status = query.state.data?.status;
      return !status || ACTIVE_ORDER_STATUSES.includes(status) ? 2000 : false;
    },
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    retry: (count, error) => count < 2 && (!isAxiosError(error) || !error.response || error.response.status >= 500),
  });
  const loading = validOrderId && isPending;
  const statusCode = isAxiosError(requestError) ? requestError.response?.status : undefined;
  const error = !validOrderId
    ? 'Mã đơn hàng không hợp lệ'
    : statusCode === 401 || statusCode === 403
      ? 'Bạn không có quyền xem đơn hàng này.'
      : statusCode === 404
        ? 'Không tìm thấy đơn hàng.'
        : 'Không thể tải thông tin đơn hàng. Vui lòng thử lại.';

  const orderCode = useMemo(
    () => order?.id.slice(0, 8).toUpperCase() ?? '',
    [order?.id],
  );

  const [isRecreating, setIsRecreating] = useState(false);
  const handleRecreateFromOrder = async () => {
    if (!order?.compensationSourceId || isRecreating) return;
    setIsRecreating(true);
    try {
      const itemsToSubmit = order.items.map((i) => ({
        productId: i.productId,
        size: i.size,
        toppings: i.toppings,
        quantity: i.qty,
      }));
      const res = await api.post<{ data: { id: string } }>('/orders/' + order.compensationSourceId + '/replacement', {
        items: itemsToSubmit,
      });
      router.push(replacementCheckoutHref(res.data.data.id, order.compensationSourceId));
    } catch (err: any) {
      alert(err?.response?.data?.message || 'Không thể tạo lại đơn thanh toán.');
    } finally {
      setIsRecreating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <p className="text-sm font-medium text-text/60">Đang tải đơn hàng...</p>
      </div>
    );
  }

  if (!order || statusCode === 401 || statusCode === 403 || statusCode === 404) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 px-4 text-center">
        <p className="text-sm font-semibold text-rose-600">
          {error ?? 'Không tìm thấy đơn hàng'}
        </p>
        {validOrderId && (
          <button type="button" onClick={() => void refetch()} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white">
            Thử lại
          </button>
        )}
      </div>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 pb-24 lg:pb-8 lg:px-8">
      {isConfirmation && order.status === 'PAID' && (
        <div className="rounded-2xl border border-primary/20 bg-primary/10 p-4 text-primary">
          <p className="font-bold">Thanh toán thành công</p>
          <p className="mt-1 text-sm text-text/70">
            Đơn hàng đã được xác nhận và đang chờ quầy pha chế.
          </p>
        </div>
      )}
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-text">
          Đơn hàng #{orderCode}
        </h1>
        <p className="mt-1 text-sm text-text/70">
          Đặt lúc: {formatVietnameseDateTime(order.createdAt)}
        </p>
      </div>

      <div className="rounded-2xl border border-primary/15 bg-surface p-5 shadow-sm">
        <OrderStatusStepper status={order.status} />
        <OrderStatusBadge status={order.status} />
      </div>

      {order.compensationIssued && (
        <div className="space-y-2 rounded-2xl border border-primary/20 bg-primary/5 p-5">
          <p className="font-bold">Cửa hàng đã hủy đơn. Giá trị đền bù {formatVND(order.compensationIssued.amount)}.</p>
          {order.compensationIssued.replacements && order.compensationIssued.replacements.length > 0 ? (
            <Link href={'/orders/' + order.compensationIssued.replacements[0].id} className="inline-block text-sm font-bold text-emerald-700 underline">
              ✓ Đã đổi sang đơn #{order.compensationIssued.replacements[0].id.slice(0, 8).toUpperCase()} (Xem chi tiết)
            </Link>
          ) : (
            <Link href={'/orders/' + order.id + '/replacement'} className="inline-block text-sm font-bold text-primary underline">
              Chọn món thay thế
            </Link>
          )}
        </div>
      )}

      {order.compensationSourceId && (
        <Link href={'/orders/' + order.compensationSourceId} className="text-sm font-bold text-primary underline">
          Xem đơn gốc #{order.compensationSourceId.slice(0, 8).toUpperCase()}
        </Link>
      )}

      {order.status === 'CANCELLED' && order.compensationSourceId && !order.compensationIssued && (
        <div className="space-y-3 rounded-2xl border border-primary/20 bg-primary/5 p-5">
          <p className="font-semibold text-text">Lần thanh toán này đã hết hạn. Bạn có thể thanh toán lại các món đã chọn hoặc chọn món khác.</p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handleRecreateFromOrder}
              disabled={isRecreating}
              className="rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-primary-hover active:scale-95 disabled:opacity-50 transition-all"
            >
              {isRecreating ? 'Đang tạo lại...' : 'Thanh toán lại đơn này'}
            </button>
            <Link
              href={'/orders/' + order.compensationSourceId + '/replacement'}
              className="inline-flex items-center rounded-xl border border-primary/20 bg-white px-5 py-2.5 text-sm font-bold text-primary hover:bg-primary/5 transition-all"
            >
              Chọn món khác
            </Link>
          </div>
        </div>
      )}

      {(order.status === 'PENDING' || order.status === 'PAYMENT_FAILED') && (
        <div className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50/80 p-5 shadow-sm">
          <p className="text-sm font-bold text-amber-900">
            {order.status === 'PAYMENT_FAILED'
              ? 'Thanh toán thất bại. Bạn có thể thử lại với đơn hàng này.'
              : '⏳ Đơn hàng đang chờ thanh toán'}
          </p>
          <button
            type="button"
            onClick={() => router.push(order.compensationSourceId
              ? replacementCheckoutHref(order.id, order.compensationSourceId)
              : '/checkout?orderId=' + order.id)}
            className="w-full rounded-full bg-primary py-3 text-sm font-bold text-white shadow-md transition-all hover:bg-primary-hover active:scale-[0.99]"
          >
            Thanh toán ngay
          </button>
        </div>
      )}

      <div className="rounded-2xl border border-primary/15 bg-surface p-5 shadow-sm">
        <h3 className="mb-2 text-sm font-bold text-text">Món đã đặt</h3>
        {order.items.map((item) => (
          <OrderItemRow key={item.id} item={item} />
        ))}
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-primary/15 bg-surface p-5 shadow-sm">
        <div className="flex justify-between items-center text-sm font-medium text-text/75">
          <span>Tạm tính</span>
          <span className="whitespace-nowrap font-bold text-text">{formatVND(order.total + order.discount)}</span>
        </div>
        {order.promoCode && (
          <div className="flex justify-between items-center text-sm">
            <span className="font-medium text-text/75">Mã khuyến mãi</span>
            <span className="min-w-0 break-all text-right font-mono font-bold text-primary">
              {order.promoCode}
            </span>
          </div>
        )}
        {order.discount > 0 && (
          <div className="flex justify-between items-center text-sm">
            <span className="font-medium text-text/75">Giảm giá</span>
            <span className="whitespace-nowrap text-rose-600 font-bold">
              - {formatVND(order.discount)}
            </span>
          </div>
        )}
        {order.compensationSource && (
          <div className="flex justify-between gap-2 text-sm text-emerald-700 font-medium">
            <span>Đền bù từ đơn gốc</span>
            <span className="font-bold">-{formatVND(order.compensationSource.amount)}</span>
          </div>
        )}
        {order.loyaltyPointsEarned > 0 && (
          <div className="flex justify-between items-center text-sm">
            <span className="font-medium text-text/75">
              {order.compensationSource ? 'Điểm thưởng cộng thêm' : 'Điểm thưởng'}
            </span>
            <span className="whitespace-nowrap text-emerald-700 font-bold">
              + {order.loyaltyPointsEarned} điểm
            </span>
          </div>
        )}
        <div className="my-1 border-t border-dashed border-primary/15" />
        <div className="flex justify-between items-center text-sm gap-4">
          <span className="font-extrabold text-base text-text">
            {order.compensationSource ? 'Thực trả thêm' : 'Tổng thanh toán'}
          </span>
          <span className="whitespace-nowrap font-black text-2xl text-primary">
            {formatVND(order.compensationSource ? Math.max(0, order.total - order.compensationSource.amount) : order.total)}
          </span>
        </div>
      </div>
      <CartStickyBar />
    </main>
  );
}

export default function OrderDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center text-text/60">
          Đang tải...
        </div>
      }
    >
      <RequireAuth>
        <OrderDetailContent />
      </RequireAuth>
    </Suspense>
  );
}
