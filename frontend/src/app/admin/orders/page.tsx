'use client';

import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { formatVND } from '@/lib/utils';
import type { OrderStatus } from '@/types';

interface AdminOrder {
    id: string;
    status: OrderStatus;
    total: number;
    discount: number;
    promoCode: string | null;
    createdAt: string;
    user: { email: string };
    items: { id: string; qty: number; size: string; toppings: string[]; product: { name: string } }[];
}

interface OrdersResponse {
    items: AdminOrder[];
    total: number;
    page: number;
    limit: number;
}

type Range = 'today' | '7d' | 'all';

// Định nghĩa các tab: active = tab "đang xử lý" (không lọc ngày, cũ trước)
const TABS = [
    { key: 'todo', label: 'Cần xử lý', statuses: ['PAID'], active: true },
    { key: 'preparing', label: 'Đang pha', statuses: ['PREPARING'], active: true },
    { key: 'ready', label: 'Sẵn sàng', statuses: ['READY'], active: true },
    { key: 'done', label: 'Hoàn tất', statuses: ['COMPLETED'], active: false },
    { key: 'cancelled', label: 'Đã hủy', statuses: ['CANCELLED'], active: false },
    { key: 'all', label: 'Tất cả', statuses: [], active: false },
] as const;

const STATUS_LABEL: Record<OrderStatus, string> = {
    PENDING: 'Chờ thanh toán',
    PAID: 'Đã thanh toán',
    PREPARING: 'Đang pha chế',
    READY: 'Sẵn sàng',
    COMPLETED: 'Hoàn tất',
    CANCELLED: 'Đã hủy',
    PAYMENT_FAILED: 'Thanh toán lỗi',
};

// Màu badge: dùng lại bảng màu ở trang lịch sử đơn của khách
const STATUS_BADGE: Record<OrderStatus, string> = {
    PENDING: 'bg-amber-100 text-amber-800',
    PAID: 'bg-blue-100 text-blue-800',
    PREPARING: 'bg-purple-100 text-purple-800',
    READY: 'bg-green-100 text-green-800',
    COMPLETED: 'bg-gray-100 text-gray-700',
    CANCELLED: 'bg-red-100 text-red-700',
    PAYMENT_FAILED: 'bg-red-100 text-red-700',
};

// Nút chính cho từng trạng thái (khớp state machine ở backend)
const PRIMARY_ACTION: Partial<Record<OrderStatus, { next: OrderStatus; label: string }>> = {
    PAID: { next: 'PREPARING', label: 'Bắt đầu pha chế' },
    PREPARING: { next: 'READY', label: 'Pha xong' },
    READY: { next: 'COMPLETED', label: 'Giao khách' },
};
// Các trạng thái được phép hủy
const CANCELLABLE: OrderStatus[] = ['PAID'];

// "đã chờ 12 phút" + màu cảnh báo khi chờ lâu
function waitInfo(createdAt: string) {
    const minutes = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000);
    const text =
        minutes < 1 ? 'vừa đặt' : minutes < 60 ? `${minutes} phút` : `${Math.floor(minutes / 60)} giờ`;
    const color = minutes >= 10 ? 'text-red-600' : minutes >= 5 ? 'text-amber-600' : 'text-text/60';
    return { text, color };
}

function formatDateTime(iso: string) {
    return new Intl.DateTimeFormat('vi-VN', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));
}

const PAGE_SIZE = 20;

export default function AdminOrdersPage() {
    const queryClient = useQueryClient();

    const [tabKey, setTabKey] = useState<(typeof TABS)[number]['key']>('todo');
    const [range, setRange] = useState<Range>('today');
    const [page, setPage] = useState(1);
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');

    const tab = TABS.find((t) => t.key === tabKey)!;

    // Debounce: chờ 400ms sau khi ngừng gõ mới gọi API, tránh gọi mỗi phím
    useEffect(() => {
        const timer = setTimeout(() => {
            setSearch(searchInput.trim());
            setPage(1);
        }, 400);
        return () => clearTimeout(timer);
    }, [searchInput]);

    // Số đơn trên từng tab
    const { data: summary } = useQuery({
        queryKey: ['admin-counts'],
        queryFn: async () =>
            (await api.get<{ data: { counts: Record<OrderStatus, number> } }>('/admin/orders/counts')).data.data,
        refetchInterval: 2_000,
    });

    // Danh sách đơn theo tab / ngày / tìm kiếm / trang
    const { data, isLoading, isError, isFetching } = useQuery({
        queryKey: ['admin-orders', tabKey, range, search, page],
        queryFn: async () => {
            const res = await api.get<{ data: OrdersResponse }>('/admin/orders', {
                params: {
                    status: tab.statuses.length ? tab.statuses.join(',') : undefined,
                    range: tab.active ? 'all' : range, // tab đang xử lý không giới hạn ngày
                    sort: tab.active ? 'asc' : 'desc', // đang xử lý: cũ trước; lịch sử: mới trước
                    search: search || undefined,
                    page,
                    limit: PAGE_SIZE,
                },
            });
            return res.data.data;
        },
        placeholderData: keepPreviousData, // giữ dữ liệu cũ khi đổi trang, đỡ nhấp nháy
        refetchInterval: 2_000,
    });

    const changeStatus = useMutation({
        mutationFn: ({ id, status }: { id: string; status: OrderStatus }) =>
            api.patch(`/admin/orders/${id}/status`, { status }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin-orders'] });
            queryClient.invalidateQueries({ queryKey: ['admin-counts'] });
        },
        onError: (err: unknown) => {
            const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
            alert(msg || 'Không đổi được trạng thái');
        },
    });

    const handleCancel = (order: AdminOrder) => {
        const warn =
            order.status === 'PAID' ? '\nNguyên liệu sẽ được hoàn kho. Khách sẽ nhận thông báo về quyền lợi sau khi hủy.' : '';
        if (confirm(`Hủy đơn #${order.id.slice(0, 8).toUpperCase()}?${warn}`)) {
            changeStatus.mutate({ id: order.id, status: 'CANCELLED' });
        }
    };

    const switchTab = (key: (typeof TABS)[number]['key']) => {
        setTabKey(key);
        setPage(1);
    };

    const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
    const countOf = (statuses: readonly string[]) =>
        summary ? statuses.reduce((s, st) => s + summary.counts[st as OrderStatus], 0) : null;

    return (
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 lg:px-8">
            <h1 className="text-2xl font-extrabold tracking-tight text-text">Đơn hàng</h1>

            {/* TAB TRẠNG THÁI (cuộn ngang trên mobile) */}
            <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
                {TABS.map((t) => {
                    const n = t.active ? countOf(t.statuses) : null;
                    const selected = t.key === tabKey;
                    return (
                        <button
                            key={t.key}
                            onClick={() => switchTab(t.key)}
                            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors ${selected
                                ? 'border-primary bg-primary text-white'
                                : 'border-primary/20 bg-surface text-text hover:border-primary'
                                }`}
                        >
                            {t.label}
                            {n !== null && n > 0 && (
                                <span
                                    className={`rounded-full px-1.5 text-[11px] font-bold ${selected ? 'bg-white/25' : 'bg-primary/10 text-primary'
                                        }`}
                                >
                                    {n}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            {/* TÌM KIẾM + LỌC NGÀY */}
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                    type="search"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="Tìm theo mã đơn hoặc email khách..."
                    className="flex-1 rounded-full border border-primary/15 bg-surface px-4 py-2 text-sm outline-none focus:border-primary"
                />
                {/* Lọc ngày chỉ áp dụng cho tab lịch sử */}
                {!tab.active && (
                    <select
                        value={range}
                        onChange={(e) => { setRange(e.target.value as Range); setPage(1); }}
                        className="rounded-full border border-primary/15 bg-surface px-4 py-2 text-sm outline-none focus:border-primary"
                    >
                        <option value="today">Hôm nay</option>
                        <option value="7d">7 ngày qua</option>
                        <option value="all">Tất cả ngày</option>
                    </select>
                )}
            </div>

            {/* DANH SÁCH */}
            <div className={`mt-4 flex flex-col gap-3 ${isFetching ? 'opacity-90' : ''}`}>
                {isLoading && <p className="py-8 text-center text-sm text-text/60">Đang tải...</p>}
                {isError && <p className="py-8 text-center text-sm text-red-600">Không tải được danh sách đơn.</p>}
                {data?.items.length === 0 && (
                    <p className="rounded-xl bg-surface p-6 text-center text-sm text-text/60">
                        Không có đơn nào.
                    </p>
                )}

                {data?.items.map((order) => {
                    const primary = PRIMARY_ACTION[order.status];
                    const wait = waitInfo(order.createdAt);
                    return (
                        <div key={order.id} className="rounded-2xl border border-primary/15 bg-surface p-4 shadow-sm">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                                <div>
                                    <p className="text-sm font-bold text-text">#{order.id.slice(0, 8).toUpperCase()}</p>
                                    <p className="text-xs text-text/60">
                                        {order.user.email} • {formatDateTime(order.createdAt)}
                                    </p>
                                </div>
                                <div className="flex flex-col items-end gap-1">
                                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[order.status]}`}>
                                        {STATUS_LABEL[order.status]}
                                    </span>
                                    {/* Chỉ hiện thời gian chờ với đơn chưa xong */}
                                    {primary && <span className={`text-[11px] font-medium ${wait.color}`}>Chờ {wait.text}</span>}
                                </div>
                            </div>

                            {/* Món + topping (barista cần xem rõ) */}
                            <ul className="mt-3 space-y-0.5 text-sm text-text">
                                {order.items.map((it) => (
                                    <li key={it.id}>
                                        <span className="font-semibold">{it.qty}x</span> {it.product.name} ({it.size})
                                        {it.toppings.length > 0 && (
                                            <span className="text-text/60"> + {it.toppings.join(', ')}</span>
                                        )}
                                    </li>
                                ))}
                            </ul>

                            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-primary/10 pt-3">
                                <div>
                                    <span className="text-base font-black text-primary">{formatVND(order.total)}</span>
                                    {order.promoCode && (
                                        <span className="ml-2 text-[11px] text-text/60">({order.promoCode})</span>
                                    )}
                                </div>
                                <div className="flex items-center gap-3">
                                    {CANCELLABLE.includes(order.status) && (
                                        <button
                                            disabled={changeStatus.isPending}
                                            onClick={() => handleCancel(order)}
                                            className="text-xs font-semibold text-red-500 hover:text-red-700 disabled:opacity-50"
                                        >
                                            Hủy đơn
                                        </button>
                                    )}
                                    {primary && (
                                        <button
                                            disabled={changeStatus.isPending}
                                            onClick={() => changeStatus.mutate({ id: order.id, status: primary.next })}
                                            className="rounded-full bg-primary px-5 py-2 text-xs font-bold text-white shadow-sm hover:bg-primary-hover active:scale-95 disabled:opacity-50"
                                        >
                                            {primary.label}
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* PHÂN TRANG */}
            {data && data.total > PAGE_SIZE && (
                <div className="mt-5 flex items-center justify-center gap-3 text-sm">
                    <button
                        disabled={page <= 1}
                        onClick={() => setPage((p) => p - 1)}
                        className="rounded-full border border-primary/20 px-4 py-1.5 font-semibold disabled:opacity-40"
                    >
                        ← Trước
                    </button>
                    <span className="text-text/70">Trang {page}/{totalPages} ({data.total} đơn)</span>
                    <button
                        disabled={page >= totalPages}
                        onClick={() => setPage((p) => p + 1)}
                        className="rounded-full border border-primary/20 px-4 py-1.5 font-semibold disabled:opacity-40"
                    >
                        Sau →
                    </button>
                </div>
            )}
        </main>
    );
}
