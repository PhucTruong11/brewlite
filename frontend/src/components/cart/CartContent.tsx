'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';
import { useCartStore, useHasCartHydrated } from '@/stores/cart.store';
import { getCartItemKey, getCheckoutSignature, toOrderItem } from '@/lib/cart';
import { pendingOrderSignature, type PendingOrder } from '@/lib/checkout';
import { cartValidationMessage, validateCart } from '@/lib/validate-cart';
import { getCompensation, replacementCheckoutHref, replacementPath } from '@/lib/order-compensation';
import type { ApiResponse, OrderStatus } from '@/types';
import { CartItemRow } from './CartItemRow';
import Link from 'next/link';
import { ShoppingBag, ArrowRight, LogIn, Loader2, AlertCircle, CheckCircle2, ChevronDown, Tag } from 'lucide-react';

interface CartContentProps {
  onClose?: () => void;
}

interface Promotion {
  id: string;
  code: string;
  description?: string | null;
  discountType: string;
  discountValue: number;
  minOrderValue: number;
  maxDiscount?: number | null;
  endDate?: string | null;
  ownedCount?: number;
}

interface OwnedVoucher {
  code: string;
  description: string | null;
  count: number;
  discountType: string;
  discountValue: number;
  minOrderValue: number;
  maxDiscount: number | null;
  endDate: string | null;
}

function formatVoucherEndDate(endDate: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(endDate));
}

export function CartContent({ onClose }: CartContentProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isAuthenticated, loading: authLoading } = useAuth();
  const { items, totalPrice, totalItems, appliedPromo, applyPromo, removePromo, replacementSourceId, selectReplacement } = useCartStore();

  const [isLoading, setIsLoading] = useState(false);
  const submittingRef = useRef(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const hasHydrated = useHasCartHydrated();
  const pendingCheckout = useQuery({
    queryKey: ['orders', 'pending-checkout', user?.id],
    queryFn: async () => (await api.get<{ data: PendingOrder | null }>('/orders/pending-checkout')).data.data,
    enabled: hasHydrated && isAuthenticated && !authLoading && !replacementSourceId,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: 5_000,
  });
  const pendingOrder = !replacementSourceId ? pendingCheckout.data : null;
  const compensation = useQuery({
    queryKey: ['replacement', user?.id, replacementSourceId],
    queryFn: () => getCompensation(replacementSourceId!),
    enabled: hasHydrated && !!replacementSourceId && !!user,
    refetchOnMount: 'always',
    refetchInterval: query => query.state.data?.replacement?.status === 'PENDING' ? 5_000 : false,
    retry: false,
  });
  const pendingReplacement = replacementSourceId && compensation.data?.replacement?.status === 'PENDING'
    ? compensation.data.replacement : null;
  const hasPendingOrder = !!pendingOrder || !!pendingReplacement;
  const cartLocked = hasPendingOrder || isLoading || (isAuthenticated &&
    (replacementSourceId ? compensation.isPending : pendingCheckout.isPending));

  // Xóa mã giảm giá nếu đang trong chế độ đền bù / đổi món
  useEffect(() => {
    if (replacementSourceId && appliedPromo) {
      removePromo();
    }
  }, [replacementSourceId, appliedPromo, removePromo]);

  // Trạng thái mã giảm giá và danh sách mã có thể chọn.
  const [promoCode, setPromoCode] = useState('');
  const discountAmount = appliedPromo ? appliedPromo.discount : 0;
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoMsg, setPromoMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [availablePromos, setAvailablePromos] = useState<Promotion[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { data: ownedVouchers = [], isError: ownedVouchersError } = useQuery({
    queryKey: ['rewards', 'owned-vouchers', user?.id],
    queryFn: async (): Promise<OwnedVoucher[]> => {
      const response = await api.get<{ vouchers: OwnedVoucher[] } | { data: { vouchers: OwnedVoucher[] } }>('/rewards');
      const overview = 'data' in response.data ? response.data.data : response.data;
      return overview.vouchers;
    },
    enabled: !replacementSourceId && isAuthenticated && !authLoading && items.length > 0,
    refetchOnMount: 'always',
  });
  const selectablePromos: Promotion[] = [
    ...ownedVouchers.map((voucher) => ({
      id: `reward-${voucher.code}`,
      ...voucher,
      ownedCount: voucher.count,
    })),
    ...availablePromos.filter((promo) => !ownedVouchers.some((voucher) => voucher.code === promo.code)),
  ];

  const subtotal = totalPrice();
  const finalTotal = Math.max(0, subtotal - discountAmount);
  const cartSignature = JSON.stringify(items.map(toOrderItem));
  const inventoryCheck = useQuery({
    queryKey: ['cart', 'ingredients', cartSignature],
    queryFn: () => validateCart(items),
    enabled: hasHydrated && items.length > 0 && !hasPendingOrder,
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    refetchInterval: 10_000,
  });
  const isOverStock = !hasPendingOrder && inventoryCheck.data?.available === false;
  const replacementAmount = compensation.data?.amount ?? 0;
  const replacementDifference = (inventoryCheck.data?.subtotal ?? subtotal) - replacementAmount;

  useEffect(() => {
    const fetchPromos = async () => {
      try {
        const backendUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';
        const res = await fetch(`${backendUrl}/promotions`);
        if (res.ok) {
          const data = await res.json();
          setAvailablePromos(data);
        }
      } catch (err) {
        console.error('Không thể tải danh sách mã ưu đãi', err);
      }
    };
    fetchPromos();
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCheckoutClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (submittingRef.current || authLoading || promoLoading) return;
    if (!isAuthenticated) {
      setShowLoginModal(true);
      return;
    }

    submittingRef.current = true;
    setIsLoading(true);
    setErrorMsg(null);
    let navigated = false;
    try {
      if (replacementSourceId) {
        const latest = await compensation.refetch();
        if (latest.isError) throw new Error('Không kiểm tra được đơn thay thế. Vui lòng thử lại.');
        const replacement = latest.data?.replacement;
        if (replacement) {
          const cart = useCartStore.getState();
          if (cart.currentUserId !== user?.id || cart.replacementSourceId !== replacementSourceId) return;
          if (replacement.status !== 'PENDING') cart.clearCart();
          if (onClose) onClose();
          router.push(replacement.status === 'PENDING'
            ? replacementCheckoutHref(replacement.id, replacementSourceId)
            : '/orders/' + replacement.id);
          navigated = true;
          return;
        }
      }
      if (!replacementSourceId) {
        const pending = await pendingCheckout.refetch();
        if (pending.isError) throw new Error('Không kiểm tra được đơn đang chờ. Vui lòng thử lại.');
        if (pending.data) {
          if (useCartStore.getState().currentUserId !== user?.id) return;
          useCartStore.getState().rememberCheckout(pending.data.id, pendingOrderSignature(pending.data));
          if (onClose) onClose();
          router.push(`/checkout?orderId=${encodeURIComponent(pending.data.id)}`);
          navigated = true;
          return;
        }
      }
      const cartBeforeCheck = JSON.stringify(useCartStore.getState().items.map(toOrderItem));
      const latest = await inventoryCheck.refetch();
      if (!latest.data?.available) {
        setErrorMsg(latest.data ? cartValidationMessage(latest.data) : 'Không kiểm tra được nguyên liệu. Vui lòng thử lại.');
        return;
      }
      const currentCart = useCartStore.getState();
      if (currentCart.replacementSourceId !== replacementSourceId ||
          cartBeforeCheck !== JSON.stringify(currentCart.items.map(toOrderItem))) {
        setErrorMsg('Giỏ hàng vừa thay đổi. Vui lòng kiểm tra lại trước khi thanh toán.');
        return;
      }
      if (replacementSourceId) {
        const response = await api.post<ApiResponse<{ id: string; status: OrderStatus }>>(replacementPath(replacementSourceId), {
          items: currentCart.items.map(toOrderItem),
        });
        const order = response.data.data;
        await queryClient.invalidateQueries({ queryKey: ['replacement', user?.id, replacementSourceId] });
        if (onClose) onClose();
        router.push(replacementCheckoutHref(order.id, replacementSourceId));
        navigated = true;
        return;
      }
      const response = await api.post<{ data: { id: string } }>('/orders', {
        items: currentCart.items.map(toOrderItem),
        ...(currentCart.appliedPromo?.code ? { promoCode: currentCart.appliedPromo.code } : {}),
      });
      const orderId = response.data.data?.id;
      if (!orderId) throw new Error('Máy chủ không trả về mã đơn hàng.');
      if (useCartStore.getState().currentUserId !== user?.id) return;
      useCartStore.getState().rememberCheckout(orderId, getCheckoutSignature(currentCart.items, currentCart.appliedPromo?.code));
      localStorage.removeItem('brewlite_checkout_renew_count');
      if (onClose) onClose();
      router.push(`/checkout?orderId=${encodeURIComponent(orderId)}`);
      navigated = true;
    } catch (error) {
      const message = isAxiosError<{ message?: string | string[] }>(error)
        ? error.response?.data?.message
        : error instanceof Error ? error.message : null;
      setErrorMsg(Array.isArray(message) ? message.join(', ') : message || 'Không tạo được đơn hàng. Vui lòng thử lại.');
    } finally {
      if (!navigated) {
        submittingRef.current = false;
        setIsLoading(false);
      }
    }
  };

  const handleCancelPending = async () => {
    if ((!pendingOrder && !pendingReplacement) || submittingRef.current) return;
    submittingRef.current = true;
    setIsLoading(true);
    setErrorMsg(null);
    try {
      if (pendingReplacement && replacementSourceId) {
        await api.post(replacementPath(replacementSourceId) + '/cancel', { orderId: pendingReplacement.id });
        await queryClient.invalidateQueries({ queryKey: ['replacement', user?.id, replacementSourceId] });
      } else if (pendingOrder) {
        await api.post(`/checkout/${pendingOrder.id}/cancel`);
        useCartStore.getState().forgetCheckout(pendingOrder.id);
      }
      await queryClient.invalidateQueries({ queryKey: ['orders', 'pending-checkout', user?.id] });
      await inventoryCheck.refetch();
    } catch (error) {
      const message = isAxiosError<{ message?: string }>(error) ? error.response?.data?.message : null;
      setErrorMsg(message || 'Chưa hủy được đơn chờ. Vui lòng thử lại.');
    } finally {
      submittingRef.current = false;
      setIsLoading(false);
    }
  };

  const confirmLogin = () => {
    setShowLoginModal(false);
    if (onClose) onClose();
    router.push('/auth/login?redirect=/cart');
  };

  const handleApplyPromo = async (codeToApply?: string) => {
    if (cartLocked) return;
    const targetCode = codeToApply || promoCode;
    if (!targetCode.trim()) {
      setPromoMsg({ type: 'error', text: 'Vui lòng nhập mã ưu đãi!' });
      return;
    }

    setPromoLoading(true);
    setPromoMsg(null);

    try {
      const backendUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

      const res = await fetch(`${backendUrl}/promotions/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: targetCode,
          subtotal: subtotal,
        }),
      });

      const json = await res.json();

      if (!res.ok) {
        removePromo();
        setPromoMsg({ type: 'error', text: json.message || 'Mã ưu đãi không hợp lệ' });
        return;
      }

      setPromoCode(json.code);
      applyPromo({
        code: json.code,
        discount: json.discountAmount,
        description: json.message || 'Khuyến mãi',
        rules: {
          discountType: json.discountType,
          discountValue: json.discountValue,
          minOrderValue: json.minOrderValue,
          maxDiscount: json.maxDiscount,
        },
      });
      setPromoMsg({ type: 'success', text: json.message || 'Áp dụng mã ưu đãi thành công!' });
    } catch {
      removePromo();
      setPromoMsg({ type: 'error', text: 'Không thể kết nối đến máy chủ!' });
    } finally {
      setPromoLoading(false);
    }
  };

  const replacementBanner = replacementSourceId && (
    <div className="mb-4 w-full rounded-xl border border-primary/20 bg-primary/5 p-3 text-left text-sm">
      <p className="font-bold text-primary">Giỏ hàng cho đơn thay thế</p>
      {compensation.data && <p>Giá trị đền bù {replacementAmount.toLocaleString('vi-VN')}đ</p>}
      {compensation.isError && <p role="alert" className="text-rose-700">Không tải được lượt đền bù. Mở lại từ thông báo để thử lại.</p>}
      <button type="button" onClick={() => { setErrorMsg(null); selectReplacement(null); }} className="mt-2 font-semibold text-primary underline">
        Quay về giỏ hàng thường
      </button>
    </div>
  );

  const pendingBanner = hasPendingOrder && (
    <div className="mb-4 rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm" role="status">
      <p className="font-bold text-primary">Bạn có đơn đang chờ thanh toán</p>
      <p className="mt-1">Nguyên liệu đang được giữ cho đơn này. Tiếp tục đơn cũ, hoặc hủy đơn chờ để sửa giỏ; các món đã chọn vẫn được giữ lại.</p>
      <div className="mt-2 flex flex-wrap gap-4">
        <button type="button" disabled={isLoading} onClick={handleCheckoutClick} className="font-semibold text-primary underline">Tiếp tục thanh toán</button>
        <button type="button" disabled={isLoading} onClick={handleCancelPending} className="font-semibold text-red-700 underline">Hủy đơn chờ để sửa giỏ</button>
      </div>
    </div>
  );

  if (!hasHydrated || authLoading) return <p className="p-6 text-center text-sm text-text/70">Đang tải giỏ hàng...</p>;

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        {replacementBanner}
        {pendingBanner}
        <div className="bg-gray-100 p-6 rounded-full mb-4">
          <ShoppingBag size={48} className="text-gray-300" />
        </div>
        <h2 className="text-xl font-bold text-gray-800 mb-2">Giỏ hàng trống</h2>
        <p className="text-gray-500 mb-8 max-w-xs">
          Bạn chưa chọn món nào. Hãy xem menu để chọn những thức uống tuyệt ngon nhé!
        </p>
        <Link
          href="/"
          onClick={() => { if (onClose) onClose(); }}
          className="bg-primary hover:bg-primary-hover text-white px-8 py-3 rounded-full font-bold transition-all shadow-md active:scale-95 mb-4 block"
        >
          Khám phá Thực đơn
        </Link>
      </div>
    );
  }

  return (
    <div className="flex w-full md:justify-center transition-all duration-300 items-stretch relative z-20">
      {/* Khung chứa hai cột. */}
      <div ref={dropdownRef} className="flex items-stretch w-full max-w-full md:w-auto">

        {/* 1. CỘT TRÁI: GIỎ HÀNG CHÍNH */}
        <div className="flex flex-col bg-surface md:bg-white h-full md:h-[80vh] md:max-h-[800px] w-full md:w-[650px] md:rounded-3xl md:shadow-xl md:border md:border-gray-100 md:overflow-hidden transition-all duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] shrink-0">

          {/* Danh sách sản phẩm */}
          <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-background/50 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            {replacementBanner}
            {pendingBanner}
            <h2 className="font-bold text-lg text-text mb-4">
              Món đã chọn ({totalItems()})
            </h2>
            <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
              {items.map((item, index) => (
                <CartItemRow key={getCartItemKey(item)} item={item} index={index} disabled={cartLocked} />
              ))}
            </div>
          </div>

          {/* Khối Mã giảm giá & Tóm tắt đơn hàng */}
          <div className="bg-white p-4 md:p-6 border-t border-gray-100 shadow-[0_-4px_20px_-10px_rgba(0,0,0,0.1)]">

            {/* Khung nhập mã */}
            {!replacementSourceId && !pendingOrder && <div className="relative mb-2">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type="text"
                    placeholder="Nhập mã ưu đãi hoặc chọn..."
                    value={promoCode}
                    onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                    onClick={() => setShowDropdown(true)}
                    className="w-full border border-gray-200 rounded-xl pl-4 pr-10 py-2.5 text-sm uppercase focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setShowDropdown(!showDropdown)}
                    className={`absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-transform duration-300 ${showDropdown ? 'rotate-180 md:rotate-90' : ''}`}
                  >
                    <ChevronDown size={18} />
                  </button>
                </div>
                <button
                  onClick={() => handleApplyPromo()}
                  disabled={promoLoading || cartLocked}
                  className="bg-gray-100 hover:bg-gray-200 disabled:opacity-50 text-text font-bold px-5 py-2.5 rounded-xl text-sm transition-colors flex items-center gap-1"
                >
                  {promoLoading ? <Loader2 size={16} className="animate-spin" /> : 'Áp dụng'}
                </button>
              </div>

              {/* Trên màn hình nhỏ, hiển thị danh sách mã ngay trong giỏ. */}
              <div className={`md:hidden overflow-hidden transition-all duration-300 ${showDropdown ? 'max-h-[300px] mt-4 opacity-100' : 'max-h-0 opacity-0'}`}>
                <div className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                  <Tag size={12} /> Mã khả dụng
                </div>
                <div className="overflow-y-auto max-h-[250px] pr-1 space-y-2">
                  {ownedVouchersError && <p className="text-xs text-red-500">Không tải được voucher đã đổi điểm</p>}
                  {selectablePromos.length === 0 ? (
                    <p className="text-sm text-gray-500">Không có mã ưu đãi</p>
                  ) : (
                    selectablePromos.map((promo) => {
                      const isEligible = subtotal >= promo.minOrderValue;
                      return (
                        <div
                          key={promo.id}
                          onClick={() => { if (isEligible) handleApplyPromo(promo.code); }}
                          className={`p-3 rounded-xl border transition-all ${isEligible ? 'bg-white border-gray-200 cursor-pointer active:border-primary' : 'bg-gray-50 border-transparent opacity-60'}`}
                        >
                          <div className="flex justify-between items-center mb-1">
                            <span className="font-bold text-primary">{promo.code}</span>
                            <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-bold">
                              {promo.discountType === 'PERCENTAGE' ? `-${promo.discountValue}%` : `-${promo.discountValue / 1000}k`}
                            </span>
                          </div>
                          {promo.ownedCount && <p className="text-[11px] font-semibold text-primary">Đã đổi điểm · x{promo.ownedCount}</p>}
                          <p className="text-[11px] text-gray-500">Đơn tối thiểu {promo.minOrderValue.toLocaleString()}đ</p>
                          {promo.endDate && <p className="text-[11px] text-gray-500">Hết hạn: {formatVoucherEndDate(promo.endDate)}</p>}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>}

            {/* Thông báo kết quả Áp dụng Mã */}
            {!replacementSourceId && !pendingOrder && promoMsg && (promoMsg.type === 'error' || appliedPromo) && (
              <div
                className={`mb-4 flex items-center gap-1.5 text-xs font-medium ${promoMsg.type === 'success' ? 'text-green-600' : 'text-red-500'
                  }`}
              >
                {promoMsg.type === 'success' ? (
                  <CheckCircle2 size={14} className="flex-shrink-0" />
                ) : (
                  <AlertCircle size={14} className="flex-shrink-0" />
                )}
                <span>{promoMsg.text}</span>
              </div>
            )}

            {/* Bảng tính tiền */}
            <div className="space-y-3 mb-6 text-sm text-text mt-4">
              <div className="flex justify-between">
                <span className="text-gray-500">Tạm tính</span>
                <span className="font-bold">{(inventoryCheck.data?.subtotal ?? subtotal).toLocaleString('vi-VN')}đ</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">{replacementSourceId ? 'Đền bù từ đơn gốc' : 'Giảm giá'}</span>
                <span className="font-bold text-red-500">
                  - {(replacementSourceId ? replacementAmount : discountAmount).toLocaleString('vi-VN')}đ
                </span>
              </div>
              <div className="border-t border-dashed border-gray-200 pt-3 flex justify-between items-end">
                <span className="font-bold text-base">
                  {replacementSourceId ? (replacementDifference < 0 ? 'Còn thiếu:' : 'Cần trả thêm') : 'Tổng cộng'}
                </span>
                <span className={`font-bold text-2xl ${replacementSourceId && replacementDifference < 0 ? 'text-amber-600' : 'text-primary'}`}>
                  {(replacementSourceId ? (replacementDifference < 0 ? -replacementDifference : replacementDifference) : finalTotal).toLocaleString('vi-VN')}đ
                </span>
              </div>
            </div>

            {errorMsg && (
              <div className="mb-4 flex items-start gap-2 rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-600">
                <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            {isOverStock && (
              <p role="alert" className="mb-4 text-sm font-medium text-red-600">
                {inventoryCheck.data ? cartValidationMessage(inventoryCheck.data) : 'Không đủ nguyên liệu'}
              </p>
            )}
            {!hasPendingOrder && inventoryCheck.isError && (
              <p role="alert" className="mb-4 text-sm font-medium text-red-600">Không kiểm tra được nguyên liệu. Vui lòng thử lại.</p>
            )}

            {/* Cảnh báo 1 dòng ngay trên nút tiến hành thanh toán */}
            {replacementSourceId && compensation.data && replacementDifference < 0 && (
              <p className="mb-3 text-center text-xs font-semibold text-amber-800 flex items-center justify-center gap-1.5">
                <AlertCircle size={14} className="text-amber-600 shrink-0" />
                <span>Còn thiếu {(-replacementDifference).toLocaleString('vi-VN')}đ so với ly nước cũ. Vui lòng chọn thêm món hoặc tăng size!</span>
              </p>
            )}

            <button
              onClick={handleCheckoutClick}
              disabled={isLoading || authLoading || promoLoading || (replacementSourceId && !compensation.data)
                || (!hasPendingOrder && (isOverStock || inventoryCheck.isPending || inventoryCheck.isError))
                || (!hasPendingOrder && !!replacementSourceId && replacementDifference < 0)}
              className={`w-full py-4 rounded-2xl font-bold text-lg flex items-center justify-center gap-2 transition-all shadow-md ${
                !!replacementSourceId && replacementDifference < 0
                  ? 'bg-amber-100 text-amber-800 border border-amber-300 cursor-not-allowed opacity-90'
                  : 'bg-primary hover:bg-primary-hover disabled:bg-primary/60 disabled:cursor-not-allowed text-white hover:shadow-lg active:scale-95'
              }`}
            >
              {isLoading ? 'Đang xử lý...' : hasPendingOrder ? 'Tiếp tục thanh toán đơn đang chờ' : authLoading ? 'Đang kiểm tra...'
                : replacementSourceId && replacementDifference < 0
                  ? `Chưa đủ tiền ly nước cũ (Thiếu ${(-replacementDifference).toLocaleString('vi-VN')}đ)`
                  : replacementSourceId && replacementDifference === 0 ? 'Xác nhận đơn thay thế' : 'Tiến hành Thanh toán'} <ArrowRight size={20} />
            </button>
          </div>
        </div>

        {/* Cột phải hiển thị danh sách mã ưu đãi trên màn hình lớn. Không hiển thị khi đổi món đền bù. */}
        {!replacementSourceId && !pendingOrder && (
        <div
          className={`hidden md:flex flex-col bg-white rounded-3xl shadow-xl border border-gray-100 overflow-hidden transition-all duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] shrink-0 md:h-[80vh] md:max-h-[800px] ${showDropdown ? 'w-[340px] opacity-100 translate-x-0 ml-6' : 'w-0 opacity-0 -translate-x-10 pointer-events-none ml-0 border-0'
            }`}
        >
          <div className="bg-white p-5 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-text text-lg whitespace-nowrap">Kho Voucher</h3>
            </div>
            <p className="text-xs text-gray-500 mt-1 whitespace-nowrap">Chọn mã phù hợp để tiết kiệm hơn nhé!</p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 bg-background/50 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            <div className="space-y-3 w-[288px]">
              {ownedVouchersError && <p className="text-xs text-red-500">Không tải được voucher đã đổi điểm</p>}
              {selectablePromos.length === 0 ? (
                <div className="text-center py-10 text-gray-400">
                  <Tag size={40} className="mx-auto mb-2 opacity-50" />
                  <p className="text-sm">Hiện chưa có ưu đãi nào</p>
                </div>
              ) : (
                selectablePromos.map((promo) => {
                  const isEligible = subtotal >= promo.minOrderValue;
                  return (
                    <div
                      key={promo.id}
                      onClick={() => {
                        if (!isEligible) return;
                        if (appliedPromo?.code === promo.code) {
                          removePromo();
                          setPromoCode('');
                          setPromoMsg(null);
                        } else {
                          handleApplyPromo(promo.code);
                        }
                      }}
                      className={`relative overflow-hidden p-4 rounded-2xl border-2 transition-all select-none ${appliedPromo?.code === promo.code
                          ? 'bg-primary/5 border-primary shadow-md'
                          : isEligible
                            ? 'bg-white border-gray-200 hover:border-primary/40 hover:shadow-md cursor-pointer'
                            : 'bg-gray-100 border-gray-100 opacity-60 cursor-not-allowed'
                        }`}
                    >
                      {appliedPromo?.code === promo.code && (
                        <div className="absolute -right-6 -top-6 bg-primary w-12 h-12 rotate-45 flex items-end justify-center pb-1 shadow-sm">
                          <CheckCircle2 size={12} className="text-white -rotate-45 mb-1" />
                        </div>
                      )}

                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <div className="font-black text-lg text-primary uppercase tracking-tight">{promo.code}</div>
                          <div className="text-xs font-medium text-text/80 mt-0.5">{promo.description || 'Ưu đãi đặc biệt'}</div>
                          {promo.ownedCount && <div className="text-xs font-semibold text-primary mt-1">Đã đổi điểm · còn {promo.ownedCount}</div>}
                        </div>
                        <div className="bg-orange-100 text-orange-600 text-xs font-bold px-2 py-1 rounded-lg whitespace-nowrap">
                          {promo.discountType === 'PERCENTAGE' ? `-${promo.discountValue}%` : `-${promo.discountValue / 1000}k`}
                        </div>
                      </div>

                      <div className="mt-3 pt-3 border-t border-dashed border-gray-200">
                        <p className="text-xs text-gray-500">Đơn tối thiểu: <span className="font-semibold text-gray-700">{promo.minOrderValue.toLocaleString('vi-VN')}đ</span></p>
                        {promo.endDate && (
                          <p className="text-xs text-gray-500 mt-0.5">
                            Hết hạn: <span className="font-semibold text-gray-700">{formatVoucherEndDate(promo.endDate)}</span>
                          </p>
                        )}
                        {promo.maxDiscount && (
                          <p className="text-[10px] text-gray-400 mt-0.5">Giảm tối đa {promo.maxDiscount.toLocaleString('vi-VN')}đ</p>
                        )}

                        {!isEligible && (
                          <div className="mt-2 text-[10px] font-bold text-red-500 bg-red-50 px-2 py-1 rounded-md w-max">
                            Mua thêm {(promo.minOrderValue - subtotal).toLocaleString('vi-VN')}đ để dùng
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
        )}
      </div>

      {/* Hộp thoại yêu cầu khách đăng nhập. */}
      {showLoginModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full text-center shadow-2xl border border-gray-100">
            <div className="w-12 h-12 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mx-auto mb-4">
              <LogIn size={24} />
            </div>
            <h3 className="text-lg font-bold text-gray-900 mb-2">Yêu cầu đăng nhập</h3>
            <p className="text-sm text-gray-500 mb-6">Bạn cần đăng nhập để tiếp tục thanh toán. Bạn có muốn đăng nhập ngay không?</p>
            <div className="flex gap-3">
              <button onClick={() => setShowLoginModal(false)} className="flex-1 py-3 border border-gray-200 text-gray-600 rounded-xl font-bold hover:bg-gray-50">Hủy</button>
              <button onClick={confirmLogin} className="flex-1 py-3 bg-primary hover:bg-primary-hover text-white rounded-xl font-bold">Đăng nhập</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
