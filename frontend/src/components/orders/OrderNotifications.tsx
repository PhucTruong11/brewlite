'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import Link from 'next/link';
import api from '@/lib/api';
import { formatVND } from '@/lib/utils';
import type { OrderStatus } from '@/types';
import { OrderStatusBadge } from './OrderStatus';

interface NotificationFeed {
  unreadCount: number;
  items: {
    id: string;
    orderId: string;
    status: OrderStatus;
    readAt: string | null;
    createdAt: string;
    order: {
      compensationSourceId?: string | null;
      compensationIssued: {
        amount: number;
        replacements?: { id: string; status: OrderStatus }[];
      } | null;
    };
  }[];
}

export function OrderNotifications({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const client = useQueryClient();
  const key = ['order-notifications', userId];
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: key,
    queryFn: async () => (await api.get<{ data: NotificationFeed }>('/orders/notifications')).data.data,
    refetchInterval: 5000,
  });
  const markRead = useMutation({
    mutationFn: (id?: string) => api.patch('/orders/notifications/' + (id ? id + '/read' : 'read-all')),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  // Lọc và gom nhóm thông báo:
  // - Mỗi đơn hàng chỉ hiển thị 1 thông báo mới nhất.
  // - Đơn thanh toán chỉ cần hiện thông báo "Hoàn tất" (bỏ các bước thanh toán trung gian PENDING/PAID).
  // - Đơn hủy vẫn giữ nguyên trạng thái "Đã hủy" kèm link chọn món thay thế đền bù.
  const displayItems = (() => {
    if (!data?.items) return [];
    const seen = new Set<string>();
    const result: typeof data.items = [];

    for (const item of data.items) {
      if (item.status === 'PENDING' || item.status === 'PAID') continue;
      // Bỏ qua thông báo hủy của các đơn thay thế tạm thời chưa thanh toán (đơn nháp), chỉ giữ lại đơn gốc cần đổi món
      if (item.status === 'CANCELLED' && item.order.compensationSourceId && !item.order.compensationIssued) {
        continue;
      }
      if (!seen.has(item.orderId)) {
        seen.add(item.orderId);
        result.push(item);
      }
    }
    return result;
  })();

  const unread = displayItems.filter((item) => !item.readAt).length;
  return (
    <div ref={container} className="relative">
      <button
        type="button"
        aria-label={unread ? 'Thông báo đơn hàng, ' + unread + ' chưa đọc' : 'Thông báo đơn hàng'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="relative grid size-10 place-items-center rounded-full text-primary hover:bg-primary/10"
      >
        <Bell size={21} aria-hidden />
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-5 rounded-full bg-rose-600 px-1 text-center text-xs font-bold text-white">{unread > 99 ? '99+' : unread}</span>}
      </button>

      {open && (
        <section aria-label="Tiến trình đơn hàng" className="fixed inset-x-4 top-16 z-50 overflow-hidden rounded-2xl border border-primary/15 bg-surface shadow-xl lg:absolute lg:inset-x-auto lg:right-0 lg:top-full lg:w-80">
          <div className="flex items-center justify-between gap-2 border-b border-primary/10 px-4 py-3">
            <h2 className="text-sm font-bold">Thông báo đơn hàng</h2>
            {unread > 0 && (
              <button type="button" disabled={markRead.isPending} onClick={() => markRead.mutate(undefined)} className="text-xs font-semibold text-primary hover:underline">
                Đọc tất cả
              </button>
            )}
          </div>
          {isPending && <p className="p-4 text-sm text-text/70">Đang tải thông báo…</p>}
          {isError && <button type="button" onClick={() => void refetch()} className="p-4 text-sm font-semibold text-primary">Không tải được thông báo. Thử lại</button>}
          {!isPending && displayItems.length === 0 && <p className="p-4 text-sm text-text/70">Bạn chưa có thông báo.</p>}
          <ul className="max-h-[min(65vh,26rem)] overflow-y-auto">
            {displayItems.map((item) => {
              const compensation = item.status === 'CANCELLED' ? item.order.compensationIssued : null;
              const isAlreadyReplaced = Boolean(compensation?.replacements && compensation.replacements.length > 0);
              const activeReplacement = isAlreadyReplaced ? compensation!.replacements![0] : null;
              const href = activeReplacement
                ? '/orders/' + activeReplacement.id
                : '/orders/' + item.orderId + (compensation ? '/replacement' : '');

              return (
                <li key={item.id} className="border-b border-primary/10 last:border-0">
                  <Link
                    href={href}
                    onClick={() => { if (!item.readAt) markRead.mutate(item.id); setOpen(false); }}
                    className={'block space-y-2 px-4 py-3 hover:bg-primary/10 ' + (item.readAt ? '' : 'bg-primary/5')}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-bold">Đơn #{item.orderId.slice(0, 8).toUpperCase()}</span>
                      <OrderStatusBadge status={item.status} />
                    </div>
                    {compensation && !isAlreadyReplaced && (
                      <p className="text-sm font-semibold text-primary">Chọn món thay thế với {formatVND(compensation.amount)}</p>
                    )}
                    {compensation && isAlreadyReplaced && activeReplacement && (
                      <p className="text-xs text-emerald-700 font-medium">✓ Đã đổi sang đơn #{activeReplacement.id.slice(0, 8).toUpperCase()}</p>
                    )}
                    <p className="text-xs text-text/60">{new Date(item.createdAt).toLocaleString('vi-VN')}</p>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
