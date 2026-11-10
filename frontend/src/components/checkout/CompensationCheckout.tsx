'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';
import { toOrderItem } from '@/lib/cart';
import { getCompensation, replacementCheckoutHref, replacementPath } from '@/lib/order-compensation';
import { useCartStore } from '@/stores/cart.store';
import { formatVND } from '@/lib/utils';
import type { ApiResponse, OrderStatus } from '@/types';
import { CheckoutMethods, type CardFormData, type CardFormErrors } from './CheckoutMethods';
import { CountdownTimer } from './CountdownTimer';
import { OrderSummary } from './OrderSummary';

type SavedItem = {
  productId: string;
  size: string;
  toppings: string[];
  qty: number;
  lineTotal: number;
  product: { name: string; imageUrl: string | null };
};

export function CompensationCheckout({ orderId, sourceId }: { orderId: string; sourceId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const draftSourceId = useCartStore((state) => state.replacementSourceId);
  const selectReplacement = useCartStore((state) => state.selectReplacement);
  const clearCart = useCartStore((state) => state.clearCart);

  const [isRecreating, setIsRecreating] = useState(false);
  const [recreateError, setRecreateError] = useState<string | null>(null);

  const [method, setMethod] = useState<'EWALLET' | 'CARD'>('EWALLET');
  const [cardInfo, setCardInfo] = useState<CardFormData>({
    cardNumber: '9704 2200 8888 6666',
    cardHolder: 'NGUYEN VAN A',
    expiry: '12/28',
    cvv: '888',
  });
  const [cardErrors, setCardErrors] = useState<CardFormErrors>({});
  const [isPayingCard, setIsPayingCard] = useState(false);
  const [cardSubmitError, setCardSubmitError] = useState<string | null>(null);

  const handleFillDemoCard = () => {
    setCardInfo({
      cardNumber: '9704 2200 8888 6666',
      cardHolder: 'NGUYEN VAN A',
      expiry: '12/28',
      cvv: '888',
    });
    setCardErrors({});
    setCardSubmitError(null);
  };

  const handleClearCard = () => {
    setCardInfo({
      cardNumber: '',
      cardHolder: '',
      expiry: '',
      cvv: '',
    });
    setCardErrors({});
  };

  const handleCardInfoChange = (data: CardFormData) => {
    setCardInfo(data);
    if (Object.keys(cardErrors).length > 0) setCardErrors({});
    if (cardSubmitError) setCardSubmitError(null);
  };

  const validateCardForm = (): boolean => {
    const errors: CardFormErrors = {};
    const cleanNumber = cardInfo.cardNumber.replace(/\s+/g, '');
    if (!cleanNumber) {
      errors.cardNumber = 'Vui lòng nhập số thẻ ngân hàng.';
    } else if (cleanNumber.length !== 16) {
      errors.cardNumber = 'Số thẻ không hợp lệ (cần đúng 16 chữ số).';
    }
    if (!cardInfo.cardHolder.trim()) {
      errors.cardHolder = 'Vui lòng nhập họ tên chủ thẻ.';
    }
    if (!cardInfo.expiry.trim()) {
      errors.expiry = 'Vui lòng nhập ngày hết hạn.';
    } else if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(cardInfo.expiry.trim())) {
      errors.expiry = 'Định dạng MM/YY không đúng (Ví dụ: 12/28).';
    }
    if (!cardInfo.cvv.trim()) {
      errors.cvv = 'Vui lòng nhập mã bảo mật CVV.';
    } else if (cardInfo.cvv.trim().length < 3) {
      errors.cvv = 'Mã CVV phải có từ 3 đến 4 chữ số.';
    }
    setCardErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handlePayWithCard = async () => {
    if (isPayingCard) return;
    if (!validateCardForm()) return;
    setIsPayingCard(true);
    setCardSubmitError(null);
    try {
      await api.post(`/orders/${sourceId}/replacement/card`, { method: 'CARD' });
      clearCart();
      await queryClient.invalidateQueries({ queryKey: ['replacement', user?.id, sourceId] });
      router.push('/orders/' + orderId + '?confirmed=1');
    } catch (err: unknown) {
      const message = isAxiosError<{ message?: string }>(err) ? err.response?.data?.message : null;
      setCardSubmitError(message || 'Thanh toán thẻ thất bại. Vui lòng thử lại.');
    } finally {
      setIsPayingCard(false);
    }
  };

  const handleQuickTestPay = async () => {
    if (isPayingCard) return;
    setIsPayingCard(true);
    try {
      await api.post(`/orders/${sourceId}/replacement/card`, { method: 'EWALLET' });
      clearCart();
      await queryClient.invalidateQueries({ queryKey: ['replacement', user?.id, sourceId] });
      router.push('/orders/' + orderId + '?confirmed=1');
    } catch (err: unknown) {
      const message = isAxiosError<{ message?: string }>(err) ? err.response?.data?.message : null;
      alert(message || 'Không thể xác nhận thanh toán thử nghiệm.');
    } finally {
      setIsPayingCard(false);
    }
  };

  const handleChooseOtherDrinks = async () => {
    try {
      await api.post(`/orders/${sourceId}/replacement/cancel`);
    } catch {
      // ignore
    }
    clearCart();
    selectReplacement(sourceId);
    await queryClient.invalidateQueries({ queryKey: ['replacement', user?.id, sourceId] });
    router.push('/');
  };

  const state = useQuery({
    queryKey: ['replacement', user?.id, sourceId],
    queryFn: () => getCompensation(sourceId),
    refetchInterval: (query) => query.state.data?.replacement?.status === 'PENDING' ? 2000 : false,
    refetchOnMount: 'always',
    staleTime: 0,
    retry: 1,
  });
  const replacement = state.data?.replacement;
  const matches = replacement?.id === orderId;
  const order = useQuery({
    queryKey: ['replacement-items', user?.id, orderId],
    queryFn: async () => (await api.get<{ data: { items: SavedItem[] } }>('/orders/' + orderId)).data.data,
    enabled: !!orderId,
    staleTime: 0,
  });
  const createLink = useMutation({
    mutationFn: () => api.post(replacementPath(sourceId) + '/payment'),
    onSuccess: () => state.refetch(),
  });

  const handleRecreateOrder = async () => {
    setIsRecreating(true);
    setRecreateError(null);
    try {
      let itemsToSubmit: { productId: string; size: string; toppings: string[]; qty: number; lineTotal: number }[] = [];
      if (order.data?.items && order.data.items.length > 0) {
        itemsToSubmit = order.data.items.map((i) => ({
          productId: i.productId,
          size: i.size,
          toppings: i.toppings,
          qty: i.qty,
          lineTotal: i.lineTotal,
        }));
      } else {
        const cartItems = useCartStore.getState().items;
        if (cartItems.length > 0) {
          itemsToSubmit = cartItems.map(toOrderItem).map((i) => ({
            productId: i.productId ?? '',
            size: i.size,
            toppings: i.toppings,
            qty: i.qty,
            lineTotal: i.lineTotal,
          }));
        }
      }
      if (itemsToSubmit.length === 0) {
        selectReplacement(sourceId);
        router.push('/');
        return;
      }
      const res = await api.post<ApiResponse<{ id: string; status: OrderStatus }>>(replacementPath(sourceId), {
        items: itemsToSubmit,
      });
      const nextOrder = res.data.data;
      await queryClient.invalidateQueries({ queryKey: ['replacement', user?.id, sourceId] });
      router.replace(replacementCheckoutHref(nextOrder.id, sourceId));
    } catch (err: unknown) {
      const message = isAxiosError<{ message?: string }>(err) ? err.response?.data?.message : null;
      setRecreateError(message || 'Không thể tạo lại đơn thanh toán. Vui lòng thử lại.');
    } finally {
      setIsRecreating(false);
    }
  };

  useEffect(() => {
    if (matches && replacement && replacement.amountDue > 0 && !replacement.paymentLink && !createLink.isPending && !createLink.isError) {
      createLink.mutate();
    }
  }, [matches, replacement, createLink]);

  useEffect(() => {
    if (matches && replacement?.status === 'PAID' && replacement.amountDue > 0) {
      clearCart();
      const timer = setTimeout(() => {
        router.push('/orders/' + orderId + '?confirmed=1');
      }, 1200);
      return () => clearTimeout(timer);
    }
  }, [matches, replacement?.status, replacement?.amountDue, orderId, clearCart, router]);

  useEffect(() => {
    if (matches && replacement && replacement.status !== 'PENDING' && draftSourceId === sourceId) clearCart();
  }, [matches, replacement, draftSourceId, sourceId, clearCart]);

  const isInitialLoading = state.isPending || order.isPending;
  const isFetchingMismatch = state.isFetching && !matches;
  const isError = state.isError || order.isError;
  const isMismatch = !isInitialLoading && !isFetchingMismatch && state.data && (!replacement || !matches);

  if (isInitialLoading || isFetchingMismatch) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 px-4 py-24 text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-sm font-medium text-gray-500">Đang tải thông tin đơn thay thế…</p>
      </main>
    );
  }

  if (isError || !state.data || !replacement || !order.data || isMismatch) {
    return (
      <main className="mx-auto flex max-w-xl flex-col items-center gap-4 px-4 py-16 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-amber-100 text-amber-700 text-2xl font-bold">
          ⏳
        </div>
        <h2 className="text-xl font-bold text-text">Lượt thanh toán này đã kết thúc hoặc bị hủy</h2>
        <p className="text-sm text-text/70 max-w-md">
          {recreateError || 'Bạn có thể bấm "Thanh toán lại" để tạo ngay mã VietQR mới cho các món này, hoặc quay lại chọn món khác.'}
        </p>
        <div className="flex flex-col sm:flex-row gap-3 mt-4 w-full max-w-xs">
          <button
            type="button"
            onClick={handleRecreateOrder}
            disabled={isRecreating}
            className="flex-1 rounded-xl bg-primary py-3.5 px-4 font-bold text-white shadow-md hover:bg-primary-hover active:scale-95 disabled:opacity-50 transition-all text-sm"
          >
            {isRecreating ? 'Đang tạo lại…' : 'Thanh toán lại'}
          </button>
          <button
            type="button"
            onClick={handleChooseOtherDrinks}
            className="flex-1 rounded-xl border border-primary/20 bg-white py-3.5 px-4 font-bold text-primary hover:bg-primary/5 active:scale-95 transition-all text-sm flex items-center justify-center"
          >
            Chọn món khác
          </button>
        </div>
      </main>
    );
  }

  const items = order.data.items.map((item) => ({
    productId: item.productId, size: item.size, toppings: item.toppings, quantity: item.qty,
    name: item.product.name, imageUrl: item.product.imageUrl, lineTotal: item.lineTotal, unitPrice: item.lineTotal / item.qty,
  }));
  const expired = !replacement.canPay && replacement.amountDue > 0;
  const error = isAxiosError<{ message?: string }>(createLink.error) ? createLink.error.response?.data?.message : null;

  const handleCompleteZeroDue = () => {
    clearCart();
    router.push('/orders/' + orderId + '?confirmed=1');
  };

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-6 pb-20 lg:px-8">
      {replacement.amountDue > 0 && (
        <CountdownTimer
          timeLeft={replacement.remainingSeconds}
          isExpired={expired}
          detail={expired ? 'Đang đối chiếu kết quả giao dịch.' : 'Thanh toán phần chênh lệch của đơn thay thế.'}
          showUI
        />
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-7">
          {replacement.amountDue > 0 ? (
            <CheckoutMethods
              method={method}
              onMethodChange={setMethod}
              finalTotal={replacement.amountDue}
              qrUrl={replacement.paymentLink?.qrCodeUrl ?? ''}
              bankInfo={state.data.bankInfo}
              cardInfo={cardInfo}
              onCardInfoChange={handleCardInfoChange}
              cardErrors={cardErrors}
              onFillDemoCard={handleFillDemoCard}
              onClearCard={handleClearCard}
              vietQrOnly={false}
              qrAction={!expired && (
                <div className="space-y-2">
                  <button type="button" onClick={() => createLink.mutate()} disabled={createLink.isPending} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">
                    {createLink.isPending ? 'Đang tạo mã…' : 'Tạo mã VietQR'}
                  </button>
                  {createLink.isError && <p role="alert" className="text-sm text-rose-700">{error || 'Chưa tạo được mã VietQR.'}</p>}
                </div>
              )}
            />
          ) : (
            <div className="rounded-2xl border border-primary/20 bg-surface p-6 shadow-sm space-y-4">
              <div className="flex items-center gap-3">
                <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 font-black text-xl">
                  ✓
                </div>
                <div>
                  <h3 className="font-bold text-text text-lg">Khấu trừ toàn bộ từ đơn gốc</h3>
                  <p className="text-sm text-text/70 mt-1">
                    Giá trị từ đơn cũ (<span className="font-bold text-primary">{formatVND(state.data.amount)}</span>) đã bù đủ 100% cho món mới. Bạn không cần thanh toán thêm bất kỳ chi phí nào.
                  </p>
                </div>
              </div>
              <div className="rounded-xl bg-primary/5 p-4 text-xs text-text/80 leading-relaxed border border-primary/10">
                👉 Vui lòng kiểm tra lại món đã chọn ở cột tóm tắt bên phải và nhấn nút <strong className="text-primary font-bold">&quot;Hoàn tất&quot;</strong> để gửi đơn đến quầy pha chế.
              </div>
            </div>
          )}
        </div>
        <div className="lg:col-span-5">
          <OrderSummary
            items={items}
            subtotal={replacement.total}
            compensationAmount={state.data.amount}
            finalTotal={replacement.amountDue}
            pointsEarned={Math.floor(replacement.total / 10_000) - Math.floor(state.data.amount / 10_000)}
            isSubmitting={createLink.isPending || isRecreating || isPayingCard}
            isExpired={expired}
            canRenew={expired}
            onRenew={handleRecreateOrder}
            method={method}
            isCheckingStatus={state.isFetching}
            onPayment={replacement.amountDue === 0 ? handleCompleteZeroDue : (method === 'CARD' ? handlePayWithCard : undefined)}
            onCheckPaymentStatus={replacement.paymentLink ? () => void state.refetch() : undefined}
            onQuickTest={handleQuickTestPay}
            statusFeedback={cardSubmitError ? { type: 'error', message: cardSubmitError } : undefined}
          />
          <div className="mt-3 text-center">
            <button
              type="button"
              onClick={handleChooseOtherDrinks}
              className="text-xs text-primary/80 hover:text-primary hover:underline font-semibold transition-colors"
            >
              ← Bạn muốn đổi ý? Bấm vào đây để chọn lại món khác
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

