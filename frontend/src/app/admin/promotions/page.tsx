'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import api from '@/lib/api';
import { formatVND } from '@/lib/utils';

// Dữ liệu một voucher trả về từ GET /admin/promotions
interface PromotionItem {
    id: string;
    code: string;
    description: string | null;
    discountType: 'PERCENTAGE' | 'FIXED_AMOUNT' | string;
    discountValue: number;
    minOrderValue: number;
    maxDiscount: number | null;
    startDate: string;
    endDate: string | null;
    isActive: boolean;
    isRewardOnly: boolean;
    pointsCost: number | null;
    redemptionLimit: number | null;
    redeemedCount: number;
    remainingCount: number | null;
    appliedCount: number;
}

// Trạng thái ban đầu của form tạo voucher
const EMPTY_FORM = {
    code: '',
    description: '',
    discountType: 'PERCENTAGE' as 'PERCENTAGE' | 'FIXED_AMOUNT',
    discountValue: '',
    minOrderValue: '',
    maxDiscount: '',
    endDate: '', // định dạng yyyy-mm-dd từ <input type="date">
    pointsCost: '',
    redemptionLimit: '',
};

// Lấy thông báo lỗi dễ đọc từ phản hồi của backend (NestJS trả message là chuỗi hoặc mảng)
function getErrorMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
        const msg = error.response?.data?.message;
        if (Array.isArray(msg)) return msg.join('. ');
        if (typeof msg === 'string') return msg;
    }
    return 'Có lỗi xảy ra, vui lòng thử lại';
}

// Voucher đã quá hạn nếu có endDate và endDate < hiện tại
function isExpired(p: PromotionItem): boolean {
    return !!p.endDate && new Date(p.endDate).getTime() <= Date.now();
}

// Ngày nhập trên form luôn tính đến 23:59:59 theo giờ Việt Nam.
function todayInVietnam(): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${value('year')}-${value('month')}-${value('day')}`;
}

function formatDiscount(p: PromotionItem): string {
    return p.discountType === 'PERCENTAGE'
        ? `${p.discountValue}%${p.maxDiscount ? ` (tối đa ${formatVND(p.maxDiscount)})` : ''}`
        : formatVND(p.discountValue);
}

function dateInputValue(value: string | null): string {
    if (!value) return '';
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(value));
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
}

function defaultDescription(form: typeof EMPTY_FORM): string {
    const value = Number(form.discountValue);
    if (!form.discountValue || !Number.isFinite(value) || value <= 0) return '';

    const minOrder = Number(form.minOrderValue) || 0;
    const threshold = minOrder > 0
        ? `cho đơn từ ${formatVND(minOrder)} trở lên`
        : 'cho mọi đơn hàng';

    if (form.discountType === 'PERCENTAGE') {
        const maxDiscount = Number(form.maxDiscount);
        const maximum = form.maxDiscount && maxDiscount > 0
            ? `tối đa ${formatVND(maxDiscount)}`
            : 'không giới hạn mức giảm';
        return `Giảm ${value}% ${threshold}, ${maximum}`;
    }

    return `Giảm ${formatVND(value)} ${threshold}`;
}

export default function AdminPromotionsPage() {
    const queryClient = useQueryClient();
    const [form, setForm] = useState(EMPTY_FORM);
    const [formError, setFormError] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingRewardOnly, setEditingRewardOnly] = useState(false);
    const [editingPromotion, setEditingPromotion] = useState<PromotionItem | null>(null);
    const [descriptionCustomized, setDescriptionCustomized] = useState(false);

    // Lấy danh sách voucher
    const { data: promotions = [], isLoading, isError } = useQuery({
        queryKey: ['admin-promotions'],
        queryFn: async () => {
            const res = await api.get<{ data: PromotionItem[] }>('/admin/promotions');
            return res.data.data;
        },
    });

    // Tạo voucher mới
    const saveMutation = useMutation({
        mutationFn: async () => {
            // Chuyển chuỗi trong form sang đúng kiểu mà DTO backend yêu cầu
            const payload: Record<string, unknown> = {};
            if (!editingId) {
                payload.code = form.code.trim();
                payload.discountType = form.discountType;
                payload.discountValue = Number(form.discountValue);
                payload.isRewardOnly = form.pointsCost.trim() !== '';
                if (form.pointsCost.trim()) {
                    payload.pointsCost = Number(form.pointsCost);
                    payload.redemptionLimit = Number(form.redemptionLimit);
                }
                payload.description = form.description.trim() || null;
                payload.minOrderValue = Number(form.minOrderValue) || 0;
                payload.maxDiscount = form.discountType === 'PERCENTAGE' && form.maxDiscount
                    ? Number(form.maxDiscount)
                    : null;
                payload.endDate = form.endDate
                    ? new Date(`${form.endDate}T23:59:59+07:00`).toISOString()
                    : null;
            } else {
                const original = editingPromotion!;
                const minOrderValue = Number(form.minOrderValue) || 0;
                const maxDiscount = form.discountType === 'PERCENTAGE' && form.maxDiscount
                    ? Number(form.maxDiscount)
                    : null;
                if (form.description !== (original.description ?? '')) {
                    payload.description = form.description.trim() || null;
                }
                if (form.discountType !== original.discountType) payload.discountType = form.discountType;
                if (Number(form.discountValue) !== original.discountValue) {
                    payload.discountValue = Number(form.discountValue);
                }
                if (minOrderValue !== original.minOrderValue) payload.minOrderValue = minOrderValue;
                if (maxDiscount !== original.maxDiscount) payload.maxDiscount = maxDiscount;
                if (form.endDate !== dateInputValue(original.endDate)) {
                    payload.endDate = form.endDate
                        ? new Date(`${form.endDate}T23:59:59+07:00`).toISOString()
                        : null;
                }
                if (editingRewardOnly) {
                    if (Number(form.pointsCost) !== original.pointsCost) {
                        payload.pointsCost = Number(form.pointsCost);
                    }
                    if (form.redemptionLimit.trim()) {
                        const limit = Number(form.redemptionLimit);
                        if (limit !== original.redemptionLimit) payload.redemptionLimit = limit;
                    }
                }
            }
            if (editingId) return api.patch(`/admin/promotions/${editingId}`, payload);
            return api.post('/admin/promotions', payload);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['admin-promotions'] });
            setForm(EMPTY_FORM);
            setFormError(null);
            setEditingId(null);
            setEditingRewardOnly(false);
            setEditingPromotion(null);
            setDescriptionCustomized(false);
        },
        onError: (error) => setFormError(getErrorMessage(error)),
    });

    // Bật / tắt voucher
    const toggleMutation = useMutation({
        mutationFn: async (id: string) => api.patch(`/admin/promotions/${id}/active`),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-promotions'] }),
        onError: (error) => alert(getErrorMessage(error)),
    });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        // Kiểm tra nhanh ở client; backend vẫn validate lại
        if (!editingId && !form.code.trim()) return setFormError('Vui lòng nhập mã voucher');
        const value = Number(form.discountValue);
        if (!form.discountValue || Number.isNaN(value) || value <= 0) {
            return setFormError('Giá trị giảm phải lớn hơn 0');
        }
        if (form.discountType === 'PERCENTAGE' && value > 100) {
            return setFormError('Giảm theo % không được vượt quá 100');
        }
        if (!editingId && form.pointsCost.trim() !== '') {
            const pointsCost = Number(form.pointsCost);
            if (!form.pointsCost || !Number.isInteger(pointsCost) || pointsCost <= 0) {
                return setFormError('Điểm cần đổi phải là số nguyên lớn hơn 0');
            }
            const redemptionLimit = Number(form.redemptionLimit);
            if (!form.redemptionLimit || !Number.isInteger(redemptionLimit) || redemptionLimit <= 0) {
                return setFormError('Giới hạn số lượng phải là số nguyên lớn hơn 0');
            }
        }
        if (editingRewardOnly) {
            const pointsCost = Number(form.pointsCost);
            if (!Number.isInteger(pointsCost) || pointsCost <= 0) {
                return setFormError('Điểm đổi phải là số nguyên lớn hơn 0');
            }
            if (form.redemptionLimit.trim()) {
                const redemptionLimit = Number(form.redemptionLimit);
                if (!Number.isInteger(redemptionLimit) || redemptionLimit <= 0) {
                    return setFormError('Giới hạn số lượng phải là số nguyên lớn hơn 0');
                }
            }
        }
        const dateChanged = !editingPromotion
            || form.endDate !== dateInputValue(editingPromotion.endDate);
        if (dateChanged && form.endDate && form.endDate < todayInVietnam()) {
            return setFormError('Hạn dùng voucher không được là ngày đã qua');
        }
        setFormError(null);
        saveMutation.mutate();
    };

    const setField = (key: keyof typeof EMPTY_FORM, value: string) => {
        if (key === 'description') {
            setDescriptionCustomized(value.trim() !== '');
            setForm((current) => ({ ...current, description: value }));
            return;
        }
        setForm((current) => {
            const next = { ...current, [key]: value };
            if (!descriptionCustomized && !editingId) {
                next.description = defaultDescription(next);
            }
            return next;
        });
    };

    const startEditing = (promotion: PromotionItem) => {
        setEditingId(promotion.id);
        setEditingRewardOnly(promotion.isRewardOnly);
        setEditingPromotion(promotion);
        setDescriptionCustomized(true);
        setForm({
            code: promotion.code,
            description: promotion.description ?? '',
            discountType: promotion.discountType === 'FIXED_AMOUNT' ? 'FIXED_AMOUNT' : 'PERCENTAGE',
            discountValue: String(promotion.discountValue),
            minOrderValue: String(promotion.minOrderValue),
            maxDiscount: promotion.maxDiscount === null ? '' : String(promotion.maxDiscount),
            endDate: dateInputValue(promotion.endDate),
            pointsCost: promotion.pointsCost === null ? '' : String(promotion.pointsCost),
            redemptionLimit: promotion.redemptionLimit === null ? '' : String(promotion.redemptionLimit),
        });
        setFormError(null);
    };

    const cancelEditing = () => {
        setEditingId(null);
        setEditingRewardOnly(false);
        setEditingPromotion(null);
        setDescriptionCustomized(false);
        setForm(EMPTY_FORM);
        setFormError(null);
    };

    const inputClass =
        'w-full rounded-lg border border-primary/20 bg-white px-3 py-2 text-sm outline-none focus:border-primary';
    const canEditTerms = !editingPromotion
        || (editingPromotion.redeemedCount === 0 && editingPromotion.appliedCount === 0);

    return (
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 lg:px-8">
            <h1 className="text-2xl font-extrabold tracking-tight text-text">Quản lý voucher</h1>
            <p className="mt-1 text-sm text-text/70">Tạo mã giảm giá và bật/tắt mã đang áp dụng cho khách.</p>

            {/* ===== Form tạo voucher ===== */}
            <form
                onSubmit={handleSubmit}
                className="mt-6 grid gap-4 rounded-2xl bg-surface p-4 shadow-sm md:grid-cols-2 lg:grid-cols-3"
            >
                {!editingId && (
                    <label className="text-sm font-semibold">
                        Mã voucher
                        <input
                            className={`${inputClass} mt-1 uppercase`}
                            value={form.code}
                            onChange={(e) => setField('code', e.target.value)}
                            placeholder="VD: SUMMER10"
                        />
                    </label>
                )}

                {(!editingId || editingRewardOnly) && <div>
                    <label htmlFor="pointsCost" className="block text-sm font-semibold">
                        Điểm đổi thưởng
                    </label>
                    <input
                        id="pointsCost"
                        type="number"
                        min={1}
                        step={1}
                        className={`${inputClass} mt-1`}
                        value={form.pointsCost}
                        onChange={(e) => setField('pointsCost', e.target.value)}
                        placeholder="Ví dụ: 100 điểm"
                    />
                    <p className="mt-1 text-xs font-normal text-text/60">
                        Để trống nếu muốn voucher áp dụng cho tất cả người dùng.
                    </p>
                </div>}
                {((!editingId && form.pointsCost.trim() !== '') || editingRewardOnly) && (
                    <label className="text-sm font-semibold">
                        Tổng số lượng được đổi
                        <input
                            type="number"
                            min={1}
                            step={1}
                            className={`${inputClass} mt-1`}
                            value={form.redemptionLimit}
                            onChange={(e) => setField('redemptionLimit', e.target.value)}
                            placeholder="Ví dụ: 100"
                        />
                    </label>
                )}

                <label className="text-sm font-semibold">
                    Loại giảm giá
                    <select
                        className={`${inputClass} mt-1`}
                        disabled={!canEditTerms}
                        value={form.discountType}
                        onChange={(e) => setField('discountType', e.target.value)}
                    >
                        <option value="PERCENTAGE">Giảm theo %</option>
                        <option value="FIXED_AMOUNT">Giảm số tiền cố định</option>
                    </select>
                </label>

                <label className="text-sm font-semibold">
                    Giá trị giảm {form.discountType === 'PERCENTAGE' ? '(%)' : '(VNĐ)'}
                    <input
                        type="number"
                        min={0}
                        className={`${inputClass} mt-1`}
                        disabled={!canEditTerms}
                        value={form.discountValue}
                        onChange={(e) => setField('discountValue', e.target.value)}
                    />
                </label>

                <label className="text-sm font-semibold">
                    Đơn tối thiểu (VNĐ)
                    <input
                        type="number"
                        min={0}
                        className={`${inputClass} mt-1`}
                        disabled={!canEditTerms}
                        value={form.minOrderValue}
                        onChange={(e) => setField('minOrderValue', e.target.value)}
                        placeholder="0"
                    />
                </label>

                {/* Giảm tối đa chỉ có ý nghĩa với voucher theo % */}
                {form.discountType === 'PERCENTAGE' && (
                    <label className="text-sm font-semibold">
                        Giảm tối đa (VNĐ)
                        <input
                            type="number"
                            min={0}
                            className={`${inputClass} mt-1`}
                            disabled={!canEditTerms}
                            value={form.maxDiscount}
                            onChange={(e) => setField('maxDiscount', e.target.value)}
                            placeholder="Không giới hạn"
                        />
                    </label>
                )}

                <label className="text-sm font-semibold">
                    Hạn dùng (để trống = không hết hạn)
                    <input
                        type="date"
                        min={todayInVietnam()}
                        className={`${inputClass} mt-1`}
                        disabled={!canEditTerms}
                        value={form.endDate}
                        onChange={(e) => setField('endDate', e.target.value)}
                    />
                </label>

                {editingId && !canEditTerms && (
                    <p className="text-xs text-amber-700 md:col-span-2 lg:col-span-3">
                        Voucher đã được phát hành hoặc sử dụng; không thể sửa mức giảm, điều kiện đơn hàng hay hạn dùng.
                    </p>
                )}

                <label className="text-sm font-semibold md:col-span-2 lg:col-span-3">
                    Mô tả (có thể chỉnh sửa)
                    <input
                        className={`${inputClass} mt-1`}
                        value={form.description}
                        onChange={(e) => setField('description', e.target.value)}
                        placeholder="Mô tả sẽ được điền tự động theo mức giảm"
                    />
                </label>

                <div className="flex flex-wrap items-center gap-3 md:col-span-2 lg:col-span-3">
                    <button
                        type="submit"
                        disabled={saveMutation.isPending}
                        className="rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                        {saveMutation.isPending ? 'Đang lưu...' : editingId ? 'Lưu thay đổi' : 'Tạo voucher'}
                    </button>
                    {editingId && (
                        <button
                            type="button"
                            onClick={cancelEditing}
                            className="rounded-lg border border-primary/30 px-5 py-2 text-sm font-semibold"
                        >
                            Hủy sửa
                        </button>
                    )}
                    {formError && <p className="text-sm text-red-600">{formError}</p>}
                </div>
            </form>

            {/* ===== Danh sách voucher ===== */}
            <h2 className="mt-8 text-lg font-bold text-text">Danh sách voucher ({promotions.length})</h2>

            {isLoading && <p className="mt-3 text-sm text-text/70">Đang tải...</p>}
            {isError && <p className="mt-3 text-sm text-red-600">Không tải được danh sách voucher.</p>}
            {!isLoading && !isError && promotions.length === 0 && (
                <p className="mt-3 text-sm text-text/70">Chưa có voucher nào.</p>
            )}

            <div className="mt-3 overflow-x-auto rounded-2xl bg-surface shadow-sm">
                <table className="w-full min-w-[1200px] table-fixed text-left text-sm">
                    <colgroup>
                        <col className="w-[19%]" />
                        <col className="w-[19%]" />
                        <col className="w-[12%]" />
                        <col className="w-[10%]" />
                        <col className="w-[8%]" />
                        <col className="w-[11%]" />
                        <col className="w-[11%]" />
                        <col className="w-[10%]" />
                    </colgroup>
                    <thead className="border-b border-primary/10 text-xs uppercase text-text/60">
                        <tr>
                            <th className="px-2 py-3">Mã</th>
                            <th className="px-2 py-3">Giảm</th>
                            <th className="px-2 py-3">Đơn tối thiểu</th>
                            <th className="px-2 py-3">Số lượng</th>
                            <th className="px-2 py-3">Đã áp dụng</th>
                            <th className="px-2 py-3">Hạn dùng</th>
                            <th className="px-2 py-3">Trạng thái</th>
                            <th className="px-2 py-3 text-right">Thao tác</th>
                        </tr>
                    </thead>
                    <tbody>
                        {promotions.map((p) => {
                            const expired = isExpired(p);
                            return (
                                <tr key={p.id} className="border-b border-primary/5 last:border-0">
                                    <td className="px-2 py-3">
                                        <p className="font-bold">{p.code}</p>
                                        {p.description && <p className="text-xs text-text/60">{p.description}</p>}
                                        <span className="text-xs font-semibold text-primary">
                                            {p.isRewardOnly ? 'Voucher đổi thưởng' : 'Áp dụng cho tất cả'}
                                        </span>
                                    </td>
                                    <td className="px-2 py-3 leading-snug">{formatDiscount(p)}</td>
                                    <td className="px-2 py-3 whitespace-nowrap">{formatVND(p.minOrderValue)}</td>
                                    <td className="whitespace-nowrap px-2 py-3 text-xs">
                                        {p.isRewardOnly
                                            ? p.redemptionLimit === null
                                                ? 'Không giới hạn'
                                                : `Còn ${p.remainingCount ?? 0}/${p.redemptionLimit}`
                                            : '—'}
                                    </td>
                                    <td className="whitespace-nowrap px-2 py-3 text-xs">
                                        {p.appliedCount}
                                    </td>
                                    <td className="px-2 py-3 whitespace-nowrap">
                                        {p.endDate ? new Date(p.endDate).toLocaleDateString('vi-VN') : 'Không giới hạn'}
                                    </td>
                                    <td className="px-2 py-3 whitespace-nowrap">
                                        {expired ? (
                                            <span className="whitespace-nowrap rounded-full bg-gray-200 px-2 py-0.5 text-xs font-semibold">Hết hạn</span>
                                        ) : p.isActive ? (
                                            <span className="whitespace-nowrap rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">Đang bật</span>
                                        ) : (
                                            <span className="whitespace-nowrap rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">Đã tắt</span>
                                        )}
                                    </td>
                                    <td className="whitespace-nowrap px-2 py-3 text-right">
                                        <div className="flex items-center justify-end gap-1">
                                            <button
                                                type="button"
                                                onClick={() => startEditing(p)}
                                                className="rounded-lg border border-primary/30 px-2 py-1 text-xs font-semibold hover:bg-background"
                                            >
                                                Sửa
                                            </button>
                                            <button
                                                type="button"
                                                disabled={toggleMutation.isPending}
                                                onClick={() => toggleMutation.mutate(p.id)}
                                                className="rounded-lg border border-primary/30 px-2 py-1 text-xs font-semibold hover:bg-background disabled:opacity-60"
                                            >
                                                {p.isActive ? 'Tắt' : 'Bật'}
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </main>
    );
}
