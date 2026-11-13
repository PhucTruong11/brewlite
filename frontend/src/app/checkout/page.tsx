'use client';

import { Suspense, useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCartStore, useHasCartHydrated } from '@/stores/cart.store';
import api from '@/lib/api';
import { getCartLineTotal, getCheckoutSignature, toOrderItem, type CartItem } from '@/lib/cart';
import { successfulCheckoutPayment, type CheckoutPayment } from '@/lib/checkout';
import { useAuth } from '@/hooks/useAuth';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { CompensationCheckout } from '@/components/checkout/CompensationCheckout';
import {
  ReceiptInvoice,
  CountdownTimer,
  CheckoutMethods,
  OrderSummary,
  EmptyCheckout,
  type ReceiptData,
  type CardFormData,
  type CardFormErrors,
} from '@/components/checkout';
import type { AppliedPromo } from '@/lib/voucher';
// trang thông tin hiển thị để khách quét mã
type CheckoutStatus = {
  payments?: CheckoutPayment[];
  status: string;
  total: number;
  loyaltyPointsEarned: number;
  originalTotal: number;
  discount: number;
  promoCode: string | null;
  qrCodeUrl: string;
  expiresAt: string;
  bankInfo?: {
    bankName: string;
    accountNo: string;
    accountName: string;
    transferContent: string;
  };
};
//dữ liệu danh sách các món ăn đã thêm vào giỏ hàng 
type SavedOrder = {
  status: string;
  promoCode: string | null;
  items: Array<{
    productId: string;
    size: string;
    toppings: string[];
    qty: number;
    lineTotal: number;
    product: { name: string; imageUrl: string | null };
  }>;
};

function CheckoutContent() {
  const { refetchUser } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { items, completeCheckout, appliedPromo, replacementSourceId, selectReplacement } = useCartStore();
  const currentPromo: AppliedPromo | null = appliedPromo;
  const hasHydrated = useHasCartHydrated();

  const [method, setMethod] = useState<'EWALLET' | 'CARD'>('EWALLET');

   const [cardInfo, setCardInfo] = useState<CardFormData>({
    cardNumber: '9704 2200 8888 6666',
    cardHolder: 'NGUYEN VAN A',
    expiry: '12/28',
    cvv: '888',
  });
  const [cardErrors, setCardErrors] = useState<CardFormErrors>({});

  const CHECKOUT_DURATION_SECONDS = 120;
  const CHECKOUT_RENEW_COUNT_KEY = 'brewlite_checkout_renew_count';
  const MAX_RENEWALS = 1; 

  const [timeLeft, setTimeLeft] = useState(CHECKOUT_DURATION_SECONDS);

  // Số lần đã gia hạn được đọc từ bộ nhớ trình duyệt.
  const [renewCount, setRenewCount] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const savedRenewCount = localStorage.getItem('brewlite_checkout_renew_count');
      return savedRenewCount ? Math.min(MAX_RENEWALS, Math.max(0, parseInt(savedRenewCount, 10) || 0)) : 0;
    }
    return 0;
  });
  const canRenew = renewCount < MAX_RENEWALS;

  // Trạng thái xử lý thanh toán
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCheckingPayment, setIsCheckingPayment] = useState(false);
  const [statusFeedback, setStatusFeedback] = useState<{
    type: 'success' | 'warning' | 'error';
    message: string;
  } | null>(null);

  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);
  const receiptOrderId = receiptData?.orderId;
  useEffect(() => {
    if (receiptOrderId) void refetchUser();
  }, [receiptOrderId, refetchUser]);

  const orderId = searchParams.get('orderId');
  const [checkoutStatus, setCheckoutStatus] = useState<CheckoutStatus | null>(null);
  const [orderItems, setOrderItems] = useState<CartItem[] | null>(null);
  const isExpired = orderId !== null && (timeLeft <= 0 || checkoutStatus?.status === 'CANCELLED');
  const paymentAttemptRef = useRef<string | null>(null);
  const renewalAttemptRef = useRef(false);//chống gia hạn liên tục
  const serverDeadlineRef = useRef<number | null>(null);//luu mốc thời gian hết hạn từ server chống sửa đổi

  // Đồng bộ hạn hai phút và số tiền thật của đơn từ máy chủ, không lấy đồng hồ hay giá giỏ làm chuẩn.
  useEffect(() => {
    if (!orderId) {
      serverDeadlineRef.current = null;
      return;
    }
    let active = true;
    let savedItems: CartItem[] | null = null;
    const syncStatus = async () => {
      if (!savedItems) return;
      try {
        const response = await api.get<CheckoutStatus>(`/checkout/status/${orderId}`);
        if (!active) return;
        setCheckoutStatus(response.data);
        if (response.data.status === 'CANCELLED') useCartStore.getState().forgetCheckout(orderId);
        serverDeadlineRef.current = new Date(response.data.expiresAt).getTime();
        setTimeLeft(response.data.status === 'CANCELLED'
          ? 0
          : Math.max(0, Math.floor((serverDeadlineRef.current - Date.now()) / 1000)));

        // Tự động kích hoạt hóa đơn khi cổng thanh toán VietQR báo đơn đã PAID
        if (response.data.status === 'PAID') {
          const payment = successfulCheckoutPayment(response.data.payments);
          setReceiptData((prev) => {
            if (prev) return prev;
            const now = new Date(payment?.createdAt ?? Date.now());
            const datePrefix = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}`;
            return {
              orderId,
              invoiceNo: `BL-${datePrefix}-${orderId.slice(-6).toUpperCase()}`,
              paymentId: payment?.id ?? `PAY-VIETQR-${orderId.slice(-6).toUpperCase()}`,
              paidAt: now.toLocaleString('vi-VN', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
              }),
              items: [...savedItems!],
              subtotal: response.data.originalTotal,
              discount: response.data.discount,
              promoCode: response.data.promoCode,
              finalTotal: response.data.total,
              pointsEarned: Math.floor(response.data.total / 10_000),
              method: payment?.method ?? 'EWALLET',
            };
          });
          if (orderId) completeCheckout(orderId);
          if (typeof window !== 'undefined') {
            localStorage.removeItem(CHECKOUT_RENEW_COUNT_KEY);
          }
        }
      } catch {
        if (active) setErrorMessage('Không tải được thời hạn thanh toán của đơn hàng.');
      }
    };
    const loadOrderItems = async () => {
      try {
        const response = await api.get<{ data: SavedOrder }>(`/orders/${orderId}`);
        if (!active) return;
        savedItems = response.data.data.items.map((item) => ({
          productId: item.productId,
          name: item.product.name,
          imageUrl: item.product.imageUrl,
          size: item.size,
          quantity: item.qty,
          toppings: item.toppings,
          unitPrice: item.lineTotal / item.qty,
          lineTotal: item.lineTotal,
        }));
        setOrderItems(savedItems);
        const cart = useCartStore.getState();
        const signature = getCheckoutSignature(savedItems, response.data.data.promoCode);
        if (['PENDING', 'PAYMENT_FAILED'].includes(response.data.data.status) && !cart.replacementSourceId &&
            signature === getCheckoutSignature(cart.items, cart.appliedPromo?.code)) {
          cart.rememberCheckout(orderId, signature);
        }
      } catch {
        if (active) setErrorMessage('Không tải được chi tiết đơn hàng. Vui lòng quay lại giỏ hàng.');
      }
    };
    const tick = () => {
      if (serverDeadlineRef.current !== null) {
        setTimeLeft(Math.max(0, Math.floor((serverDeadlineRef.current - Date.now()) / 1000)));
      }
    };
    void loadOrderItems().then(syncStatus);
    const poll = setInterval(syncStatus, 2_000);
    const timer = setInterval(tick, 1000);
    return () => { active = false; clearInterval(poll); clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  useEffect(() => {
    if (orderId && replacementSourceId) selectReplacement(null);
  }, [orderId, replacementSourceId, selectReplacement]);

  // Đơn đã tạo là nguồn dữ liệu cho số tiền và nội dung QR; giỏ chỉ dùng để tạo lượt mới khi hết hạn.
  const displayItems = orderItems ?? items;
  const subtotal = checkoutStatus?.originalTotal ?? displayItems.reduce((sum, item) => sum + getCartLineTotal(item), 0);
  const discountAmount = checkoutStatus?.discount ?? (appliedPromo?.discount ?? 0);
  const finalTotal = checkoutStatus?.total ?? Math.max(0, subtotal - discountAmount);
  const pointsEarned = Math.floor(finalTotal / 10000); 
  const displayedPromo: AppliedPromo | null = checkoutStatus?.promoCode
    ? {
        code: checkoutStatus.promoCode,
        discount: discountAmount,
        description: currentPromo?.code === checkoutStatus.promoCode ? currentPromo.description : 'Ưu đãi của đơn hàng',
        rules: currentPromo?.code === checkoutStatus.promoCode
          ? currentPromo.rules
          : { discountType: 'FIXED_AMOUNT', discountValue: discountAmount, minOrderValue: 0 },
      }
    : null;

  // Kiểm tra thông tin thẻ ngân hàng.
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

  // Sau khi đơn cũ hết hạn, trả nguyên liệu rồi tạo lượt chờ thanh toán mới trước khi khách xác nhận trả.
  const handleRenewOrder = async () => {
    const savedRenewCount = Number(localStorage.getItem(CHECKOUT_RENEW_COUNT_KEY)) || 0;
    if (isSubmitting || renewalAttemptRef.current || !orderId || Math.max(renewCount, savedRenewCount) >= MAX_RENEWALS) {
      setErrorMessage('Đơn hàng đã hết số lần gia hạn cho phép (tối đa 1 lần). Vui lòng tạo lại đơn mới.');
      return;
    }
    renewalAttemptRef.current = true;
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const oldStatus = await api.get<CheckoutStatus>(`/checkout/status/${orderId}`);
      if (oldStatus.data.status !== 'CANCELLED') {
        throw new Error('Đơn cũ chưa được hủy. Vui lòng kiểm tra trạng thái đơn trước khi tạo lại.');
      }
      const currentCart = useCartStore.getState();
      if (currentCart.items.length === 0) throw new Error('Giỏ hàng đã trống. Vui lòng chọn món lại.');
      const response = await api.post<{ data: { id: string; reservationExpiresAt: string } }>('/orders', {
        items: currentCart.items.map(toOrderItem),
        ...(currentCart.appliedPromo?.code ? { promoCode: currentCart.appliedPromo.code } : {}),
      });
      const nextOrder = response.data.data;
      if (!nextOrder?.id) throw new Error('Máy chủ không trả về mã đơn hàng mới.');
      currentCart.rememberCheckout(nextOrder.id, getCheckoutSignature(currentCart.items, currentCart.appliedPromo?.code));
      const nextRenewCount = renewCount + 1;
      setRenewCount(nextRenewCount);
      localStorage.setItem(CHECKOUT_RENEW_COUNT_KEY, nextRenewCount.toString());
      paymentAttemptRef.current = null;
      serverDeadlineRef.current = new Date(nextOrder.reservationExpiresAt).getTime();
      setTimeLeft(Math.max(0, Math.floor((serverDeadlineRef.current - Date.now()) / 1000)));
      setCheckoutStatus(null);
      setOrderItems(null);
      router.replace(`/checkout?orderId=${encodeURIComponent(nextOrder.id)}`);
    } catch (error: unknown) {
      const response = error && typeof error === 'object' && 'response' in error
        ? (error as { response?: { data?: { message?: string | string[] } } }).response
        : null;
      const message = response?.data?.message;
      setErrorMessage(Array.isArray(message) ? message.join(', ') : message ||
        (error instanceof Error ? error.message : 'Không thể tạo lại đơn hàng. Vui lòng thử lại.'));
    } finally {
      renewalAttemptRef.current = false;
      setIsSubmitting(false);
    }
  };

  // Điền thông tin thẻ mẫu.
  const handleFillDemoCard = () => {
    setCardInfo({
      cardNumber: '9704 2200 8888 6666',
      cardHolder: 'NGUYEN VAN A',
      expiry: '12/28',
      cvv: '888',
    });
    setCardErrors({});
    setErrorMessage(null);
  };

  // Xóa trắng form thẻ
  const handleClearCard = () => {
    setCardInfo({
      cardNumber: '',
      cardHolder: '',
      expiry: '',
      cvv: '',
    });
    setCardErrors({});
  };

  // Cập nhật thông tin thẻ
  const handleCardInfoChange = (data: CardFormData) => {
    setCardInfo(data);
    if (Object.keys(cardErrors).length > 0) {
      setCardErrors({});
    }
    if (errorMessage) {
      setErrorMessage(null);
    }
  };

  // Khách bấm kiểm tra thủ công trạng thái giao dịch VietQR
  const handleManualCheckPayment = async () => {
    if (isCheckingPayment || !orderId) return;
    setIsCheckingPayment(true);
    setStatusFeedback(null);
    try {
      const response = await api.get<CheckoutStatus>(`/checkout/status/${orderId}`);
      setCheckoutStatus(response.data);
      if (response.data.status === 'PAID') {
        const payment = successfulCheckoutPayment(response.data.payments);
        setStatusFeedback({
          type: 'success',
          message: 'Hệ thống đã xác nhận thanh toán thành công! Đang xuất hóa đơn...',
        });
        const now = new Date(payment?.createdAt ?? Date.now());
        const datePrefix = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}`;
        setReceiptData({
          orderId,
          invoiceNo: `BL-${datePrefix}-${orderId.slice(-6).toUpperCase()}`,
          paymentId: payment?.id ?? `PAY-VIETQR-${orderId.slice(-6).toUpperCase()}`,
          paidAt: now.toLocaleString('vi-VN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
          }),
          items: orderItems ? [...orderItems] : [...items],
          subtotal: response.data.originalTotal,
          discount: response.data.discount,
          promoCode: response.data.promoCode,
          finalTotal: response.data.total,
          pointsEarned: Math.floor(response.data.total / 10_000),
          method: payment?.method ?? 'EWALLET',
        });
        if (orderId) completeCheckout(orderId);
        if (typeof window !== 'undefined') {
          localStorage.removeItem(CHECKOUT_RENEW_COUNT_KEY);
        }
      } else {
        setStatusFeedback({
          type: 'warning',
          message: 'Chưa nhận được giao dịch. Nếu bạn vừa chuyển khoản, vui lòng đợi vài giây để hệ thống ghi nhận.',
        });
        setTimeout(() => setStatusFeedback(null), 6000);
      }
    } catch {
      setStatusFeedback({
        type: 'error',
        message: 'Không thể kết nối đến máy chủ để kiểm tra. Vui lòng thử lại.',
      });
      setTimeout(() => setStatusFeedback(null), 4000);
    } finally {
      setIsCheckingPayment(false);
    }
  };

  // Đơn đã được tạo ở giỏ; nút xác nhận chỉ thanh toán orderId đang chờ.
  const handleCheckout = async () => {
    if (isSubmitting) return;
    if (isExpired || (serverDeadlineRef.current !== null && serverDeadlineRef.current <= Date.now())) {
      setTimeLeft(0);
      setErrorMessage('Đơn hàng đã quá hạn thanh toán. Vui lòng bấm "Tạo lại đơn hàng" để tiếp tục.');
      return;
    }

    if (!orderId || !checkoutStatus || !orderItems?.length) {
      setErrorMessage('Chưa có đơn hàng để thanh toán. Vui lòng quay lại giỏ hàng.');
      return;
    }
    if (checkoutStatus.status !== 'PENDING' && checkoutStatus.status !== 'PAYMENT_FAILED') {
      setErrorMessage('Đơn hàng này không còn ở trạng thái chờ thanh toán.');
      return;
    }

    // Với phương thức VietQR và đơn có tiền (>0), bắt buộc phải thanh toán qua VietQR Webhook
    if (method === 'EWALLET' && finalTotal > 0) {
      setErrorMessage('Đơn hàng chọn thanh toán qua VietQR cần được quét mã và thanh toán để xác nhận.');
      return;
    }

    // Nếu chọn thanh toán bằng thẻ, kiểm tra thông tin thẻ trước
    if (method === 'CARD') {
      const isValid = validateCardForm();
      if (!isValid) {
        setErrorMessage('Thông tin thẻ chưa hợp lệ. Vui lòng kiểm tra các trường màu đỏ bên dưới.');
        return;
      }
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      // Giữ nguyên mã giao dịch cho cùng một lần thanh toán, kể cả khi yêu cầu hết thời gian chờ.
      if (!paymentAttemptRef.current) {
        paymentAttemptRef.current =
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `checkout-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      }

      // Chỉ gửi mã đơn đã được tạo từ giỏ cho API thanh toán.
      const paymentRes = await api.post(
        '/checkout',
        {
          orderId,
          method,
        },
        {
          headers: {
            'Idempotency-Key': paymentAttemptRef.current,
          },
        },
      );
      //ép kiểu dữ liệu trả về từ server để dễ thao tác 
      const paymentData = paymentRes.data as {
        success?: boolean;
        isDuplicate?: boolean;
        message?: string;
        payment?: {
          id: string;
          createdAt?: string;
          amount?: number;
        };
        pointsEarned?: number;
      };
      const orderRes = await api.get(`/orders/${orderId}`);
      const confirmedOrder = orderRes.data.data;

      // Phản hồi giao dịch trùng không có trường success; kiểm tra trạng thái đơn trên máy chủ.
      if (paymentData.success !== true && confirmedOrder?.status !== 'PAID') {
        // Khi máy chủ xác nhận thất bại, lần thử tiếp theo dùng mã giao dịch mới.
        if (paymentData.success === false || confirmedOrder?.status === 'PAYMENT_FAILED') {
          paymentAttemptRef.current = null;
        }
        throw new Error(paymentData.message || 'Giao dịch thanh toán không thành công.');
      }

      const now = new Date();
      const datePrefix = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}`;

      // Tạo hóa đơn điện tử từ dữ liệu máy chủ trả về.
      setReceiptData({
        orderId,
        invoiceNo: `BL-${datePrefix}-${orderId.slice(-6).toUpperCase()}`,
        paymentId: paymentData.payment?.id || `PAY-${orderId.slice(-6).toUpperCase()}`,
        paidAt: new Date(paymentData.payment?.createdAt || now).toLocaleString('vi-VN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        }),
        items: [...displayItems],
        subtotal,
        discount: discountAmount,
        promoCode: confirmedOrder?.promoCode || checkoutStatus.promoCode,
        finalTotal: paymentData.payment?.amount ?? finalTotal,
        pointsEarned: paymentData.pointsEarned ?? pointsEarned,
        method,
      });

      // Xóa giỏ và lượt làm mới sau khi máy chủ xác nhận đã thanh toán.
      if (typeof window !== 'undefined') {
        localStorage.removeItem(CHECKOUT_RENEW_COUNT_KEY);
      }
      if (orderId) completeCheckout(orderId);
    } catch (err: unknown) {
      let message = 'Có lỗi xảy ra trong quá trình thanh toán đơn hàng. Vui lòng thử lại!';
      if (
        typeof err === 'object' &&
        err !== null &&
        'response' in err &&
        typeof (err as { response?: unknown }).response === 'object'
      ) {
        const resData = (err as { response?: { data?: { message?: unknown } } }).response?.data;
        if (resData?.message) {
          message = Array.isArray(resData.message)
            ? resData.message.join(', ')
            : String(resData.message);
        }
      } else if (err instanceof Error) {
        message = err.message;
      }

      setErrorMessage(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Nút "Test nhanh" bỏ qua quét QR dành cho dev test các module khác
  const handleQuickTestPay = async () => {
    if (isSubmitting || !orderId) return;
    if (!checkoutStatus || !orderItems?.length) {
      setErrorMessage('Đang tải thông tin đơn hàng. Vui lòng thử lại sau.');
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const idempotencyKey =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `test-quick-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      const paymentRes = await api.post(
        '/checkout',
        {
          orderId,
          method: 'EWALLET',
        },
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
          },
        },
      );
      const paymentData = paymentRes.data as {
        success?: boolean;
        message?: string;
        payment?: CheckoutPayment & { amount?: number };
        pointsEarned?: number;
      };
      const confirmed = (await api.get<{ data: { status: string; loyaltyPointsEarned: number; payments: (CheckoutPayment & { amount: number })[] } }>(`/orders/${orderId}`)).data.data;
      const paidPayment = successfulCheckoutPayment(confirmed.payments);
      if (paymentData.success !== true && !paidPayment) {
        throw new Error(paymentData.message || 'Thanh toán thất bại. Vui lòng thử lại.');
      }
      const payment = paidPayment ?? paymentData.payment;

      const now = new Date(payment?.createdAt ?? Date.now());
      const datePrefix = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}`;

      setReceiptData({
        orderId,
        invoiceNo: `BL-${datePrefix}-${orderId.slice(-6).toUpperCase()}`,
        paymentId: payment?.id || `PAY-TEST-${orderId.slice(-6).toUpperCase()}`,
        paidAt: now.toLocaleString('vi-VN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        }),
        items: orderItems ? [...orderItems] : [...items],
        subtotal: checkoutStatus?.originalTotal ?? subtotal,
        discount: checkoutStatus?.discount ?? discountAmount,
        promoCode: checkoutStatus?.promoCode ?? null,
        finalTotal: confirmed.payments.find(p => p.id === payment?.id)?.amount ?? paymentData.payment?.amount ?? finalTotal,
        pointsEarned: paymentData.pointsEarned ?? Math.floor(finalTotal / 10_000),
        method: payment?.method ?? 'EWALLET',
      });

      if (typeof window !== 'undefined') {
        localStorage.removeItem(CHECKOUT_RENEW_COUNT_KEY);
      }
      if (orderId) completeCheckout(orderId);
    } catch (err: unknown) {
      let message = 'Lỗi thanh toán test nhanh.';
      if (
        typeof err === 'object' &&
        err !== null &&
        'response' in err &&
        typeof (err as { response?: unknown }).response === 'object'
      ) {
        const resData = (err as { response?: { data?: { message?: unknown } } }).response?.data;
        if (resData?.message) {
          message = Array.isArray(resData.message)
            ? resData.message.join(', ')
            : String(resData.message);
        }
      } else if (err instanceof Error) {
        message = err.message;
      }
      setErrorMessage(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // QR gắn với đúng mã đơn và số tiền đã được máy chủ chốt khi tạo đơn.
  const vietQrUrl = checkoutStatus?.qrCodeUrl ?? '';

  // Chờ tải giỏ hàng từ bộ nhớ trình duyệt để tránh giao diện hiển thị sai lúc đầu.
  if (!hasHydrated) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 items-center justify-center px-4 py-24">
        <div className="flex flex-col items-center gap-3 text-sm text-gray-500 font-medium">
          <svg className="h-7 w-7 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          Đang tải thông tin đơn hàng...
        </div>
      </main>
    );
  }

  // 1. NẾU ĐÃ THANH TOÁN THÀNH CÔNG → HIỂN THỊ HÓA ĐƠN ĐIỆN TỬ
  if (receiptData) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center px-4 py-8">
        <ReceiptInvoice
          data={receiptData}
          onReset={() => {
            setReceiptData(null);
            if (orderId) completeCheckout(orderId);
          }}
        />
      </main>
    );
  }

  // Chỉ có đơn được tạo từ giỏ mới được mở trang QR và bắt đầu thời hạn thanh toán.
  if (!orderId) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
        <p className="font-semibold text-text">Vui lòng tạo đơn từ giỏ hàng trước khi thanh toán.</p>
        <button type="button" onClick={() => router.push('/cart')} className="rounded-full bg-primary px-6 py-3 font-bold text-white">
          Quay lại giỏ hàng
        </button>
      </main>
    );
  }

  if (!checkoutStatus || !orderItems) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
        <p className="font-semibold text-text">{errorMessage || 'Đang tải đơn hàng và thời hạn thanh toán...'}</p>
        {errorMessage && <button type="button" onClick={() => router.push('/cart')} className="rounded-full bg-primary px-6 py-3 font-bold text-white">Quay lại giỏ hàng</button>}
      </main>
    );
  }

  if (checkoutStatus.status === 'PAID') {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
        <p className="font-semibold text-text">Đơn hàng này đã được thanh toán.</p>
        <button type="button" onClick={() => router.push(`/orders/${orderId}`)} className="rounded-full bg-primary px-6 py-3 font-bold text-white">Xem đơn hàng</button>
      </main>
    );
  }

  if (orderItems.length === 0) {
    return <EmptyCheckout />;
  }

  // 3. GIAO DIỆN THANH TOÁN CHÍNH.
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-6 pb-20 lg:px-8">
      {/* Hai phút bắt đầu khi khách rời giỏ và đơn được tạo; hạn lấy từ máy chủ. */}
      <CountdownTimer
        timeLeft={timeLeft}
        isExpired={isExpired}
        canRenew={canRenew}
        attempt={renewCount + 1}
        showUI
      />

      {errorMessage && (
        <div className="rounded-xl bg-red-50 p-4 text-sm font-medium text-red-700 border border-red-200">
          ⚠️ {errorMessage}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* CỘT TRÁI: Phương thức thanh toán, chiếm bảy phần lưới. */}
        <div className="flex flex-col gap-6 lg:col-span-7">
          <CheckoutMethods
            method={method}
            onMethodChange={setMethod}
            finalTotal={finalTotal}
            qrUrl={vietQrUrl}
            bankInfo={checkoutStatus?.bankInfo}
            cardInfo={cardInfo}
            onCardInfoChange={handleCardInfoChange}
            cardErrors={cardErrors}
            onFillDemoCard={handleFillDemoCard}
            onClearCard={handleClearCard}
          />
        </div>

        {/* CỘT PHẢI: Tóm tắt đơn, tiền và nút thanh toán; chiếm năm phần lưới. */}
        <div className="flex flex-col gap-6 lg:col-span-5">
          <OrderSummary
            items={displayItems}
            subtotal={subtotal}
            finalTotal={finalTotal}
            pointsEarned={pointsEarned}
            isSubmitting={isSubmitting}
            isExpired={isExpired}
            canRenew={canRenew}
            durationSeconds={CHECKOUT_DURATION_SECONDS}
            onPayment={handleCheckout}
            onRenew={handleRenewOrder}
            onReturnToCart={() => router.push('/cart')}
            appliedPromo={displayedPromo}
            method={method}
            onCheckPaymentStatus={handleManualCheckPayment}
            isCheckingStatus={isCheckingPayment}
            statusFeedback={statusFeedback}
            onQuickTest={handleQuickTestPay}
          />
        </div>
      </div>
    </main>
  );
}

function CheckoutForOrder() {
  const params = useSearchParams();
  const orderId = params.get('orderId');
  const replacementFor = params.get('replacementFor');
  if (orderId && replacementFor) {
    return <CompensationCheckout key={orderId} orderId={orderId} sourceId={replacementFor} />;
  }
  // Đổi mã đơn sẽ tạo lại trạng thái trang, tránh hiển thị dữ liệu của đơn cũ trong lúc tải đơn mới.
  return <CheckoutContent key={orderId ?? 'empty'} />;
}

export default function CheckoutPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center text-text/60">
          Đang tải...
        </div>
      }
    >
      <RequireAuth>
        <CheckoutForOrder />
      </RequireAuth>
    </Suspense>
  );
}
