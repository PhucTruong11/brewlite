'use client';

import Link from 'next/link';
import { formatVND } from '@/lib/utils';
import { formatCartToppings, getCartItemKey, getCartLineTotal } from '@/lib/cart';
import type { CartItem } from '@/types';
import type { AppliedPromo } from '@/lib/voucher';

interface OrderSummaryProps {
  items: CartItem[];
  subtotal?: number;
  finalTotal: number;
  pointsEarned: number;
  isSubmitting: boolean;
  isExpired: boolean;
  canRenew?: boolean;
  durationSeconds?: number;
  onCheckout?: () => void;
  onPayment?: () => void;
  onRenew?: () => void;
  onReturnToCart?: () => void;
  appliedPromo?: AppliedPromo | null;
  onRemovePromo?: () => void;
  method?: 'EWALLET' | 'CARD';
  onCheckPaymentStatus?: () => void;
  isCheckingStatus?: boolean;
  statusFeedback?: {
    type: 'success' | 'warning' | 'error';
    message: string;
  } | null;
  onQuickTest?: () => void;
}

export function OrderSummary({
  items,
  subtotal: propSubtotal,
  finalTotal,
  pointsEarned,
  isSubmitting,
  isExpired,
  canRenew = true,
  durationSeconds = 120,
  onCheckout,
  onPayment,
  onRenew,
  onReturnToCart,
  appliedPromo,
  onRemovePromo,
  method = 'EWALLET',
  onCheckPaymentStatus,
  isCheckingStatus = false,
  statusFeedback,
  onQuickTest,
}: OrderSummaryProps) {
  const durationLabel = durationSeconds >= 60 ? `${Math.floor(durationSeconds / 60)} phút` : `${durationSeconds} giây`;
  const triggerCheckout = onCheckout || onPayment;
  const totalItemsCount = items.reduce((s, i) => s + (Number(i.quantity) || 1), 0);
  const itemsSubtotal = propSubtotal ?? items.reduce((sum, item) => sum + getCartLineTotal(item), 0);

  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm border border-emerald-900/10">
      <h2 className="text-lg font-bold text-[#1E3932] mb-4">
        Chi tiết đơn hàng ({totalItemsCount} món)
      </h2>

      {/* Danh sách món tóm tắt */}
      <div className="divide-y divide-gray-100 max-h-60 overflow-y-auto pr-1">
        {items.map((item) => (
          <div key={getCartItemKey(item)} className="py-2.5 flex items-start justify-between text-xs">
            <div>
              <span className="font-bold text-[#1E3932]">
                {item.quantity}x {item.name}
              </span>
              <p className="text-gray-500 mt-0.5">
                Size {item.size} {item.toppings && item.toppings.length > 0 ? `• ${formatCartToppings(item.toppings)}` : ''}
              </p>
            </div>
            <span className="font-semibold text-[#1E3932]">
              {formatVND(getCartLineTotal(item))}
            </span>
          </div>
        ))}
      </div>

      {/* Khối Hiển thị Voucher tại Checkout (Chỉ hiển thị, không cho nhập) */}
      {appliedPromo ? (
        <div className="mt-4 flex items-center justify-between rounded-xl bg-emerald-50/90 border border-emerald-200 px-3.5 py-2.5 text-xs text-emerald-900">
          <div>
            <div className="flex items-center gap-1.5">
              <span>🎟️</span>
              <strong className="font-bold text-primary">{appliedPromo.code}</strong>
              <span className="text-[11px] font-semibold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full ml-1">
                -{formatVND(appliedPromo.discount)}
              </span>
            </div>
            <p className="text-[10px] text-emerald-700 mt-0.5 ml-5 font-medium">
              {appliedPromo.description}
            </p>
          </div>
          {onRemovePromo && (
            <button
              type="button"
              onClick={onRemovePromo}
              className="text-xs text-red-500 hover:text-red-700 hover:underline font-semibold ml-2"
            >
              Bỏ mã
            </button>
          )}
        </div>
      ) : (
        /* Khi chưa có mã: Hiện thông báo và link quay lại giỏ hàng */
        <div className="mt-4 flex items-center justify-between rounded-xl bg-gray-50 border border-dashed border-gray-200 px-3.5 py-2.5 text-xs text-gray-500">
          <div className="flex items-center gap-1.5">
            <span>🎟️</span>
            <span>Chưa áp dụng mã ưu đãi</span>
          </div>
          <Link
            href="/cart"
            className="text-xs text-primary font-semibold hover:underline flex items-center gap-0.5"
          >
            Chọn mã tại giỏ hàng &rarr;
          </Link>
        </div>
      )}

      {/* Bảng tính tiền chi tiết */}
      <div className="mt-5 space-y-2 border-t border-gray-100 pt-4 text-xs">
        <div className="flex justify-between text-gray-600">
          <span>Tạm tính:</span>
          <span className="font-semibold text-gray-900">{formatVND(itemsSubtotal)}</span>
        </div>

        {appliedPromo && (
          <div className="flex justify-between text-emerald-700 font-medium">
            <span>Giảm giá ({appliedPromo.code}):</span>
            <span className="font-bold">-{formatVND(appliedPromo.discount)}</span>
          </div>
        )}

        <div className="flex justify-between text-emerald-900 pt-1">
          <span>Tích lũy điểm (10.000đ = 1 điểm):</span>
          <span className="font-bold">+{pointsEarned} điểm</span>
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 pt-3 text-base font-extrabold text-[#1E3932]">
          <span>TỔNG THANH TOÁN:</span>
          <span className="text-xl text-primary font-black">
            {formatVND(finalTotal)}
          </span>
        </div>
      </div>

      {/* Đơn hết hạn phải được tạo lại trước khi khách xác nhận thanh toán. */}
      {isExpired ? (
        canRenew ? (
          <button
            type="button"
            onClick={onRenew}
            disabled={isSubmitting}
            className="mt-6 w-full rounded-full py-4 text-center font-bold text-white bg-amber-600 hover:bg-amber-700 shadow-lg transition-all active:scale-[0.99] flex items-center justify-center gap-2"
          >
            {isSubmitting ? 'Đang gia hạn...' : `Gia hạn thêm ${durationLabel} (1 lần)`}
          </button>
        ) : (
          <div className="mt-6 flex flex-col gap-2">
            <button
              type="button"
              disabled
              className="w-full rounded-full py-4 text-center font-bold text-gray-500 bg-gray-200 cursor-not-allowed shadow-sm"
            >
              Đã hết hạn thanh toán
            </button>
            <p className="text-center text-xs text-red-600 font-semibold">
              Đơn hàng đã hết 2 cơ hội thanh toán. Mã ưu đãi (nếu có) đã tự động bị thu hồi. Vui lòng quay lại giỏ hàng để tạo đơn mới.
            </p>
            {onReturnToCart && (
              <button
                type="button"
                onClick={onReturnToCart}
                className="w-full rounded-full border border-primary text-primary hover:bg-primary/5 py-2.5 text-center text-xs font-bold transition-all active:scale-[0.99]"
              >
                Quay lại giỏ hàng
              </button>
            )}
          </div>
        )
      ) : method === 'EWALLET' && finalTotal > 0 ? (
        <div className="mt-5 space-y-3">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3.5 text-center">
            <div className="flex items-center justify-center gap-2 text-xs font-bold text-emerald-800">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-600"></span>
              </span>
              <span>Đang chờ chuyển khoản VietQR...</span>
            </div>
            <p className="mt-1.5 text-[11px] text-gray-600 leading-relaxed">
              Mở App Ngân hàng quét mã bên trái và chuyển đúng <strong className="text-emerald-700 font-bold">{formatVND(finalTotal)}</strong>. Hệ thống sẽ tự động xuất hóa đơn khi SePay xác nhận.
            </p>
          </div>

          {statusFeedback && (
            <div
              className={`rounded-xl p-3 text-xs font-medium border animate-fadeIn ${
                statusFeedback.type === 'success'
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                  : statusFeedback.type === 'warning'
                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                  : 'bg-red-50 text-red-800 border-red-200'
              }`}
            >
              {statusFeedback.type === 'warning' && '⏳ '}
              {statusFeedback.type === 'success' && '✅ '}
              {statusFeedback.type === 'error' && '⚠️ '}
              {statusFeedback.message}
            </div>
          )}

          <button
            type="button"
            disabled={isCheckingStatus || isSubmitting}
            onClick={onCheckPaymentStatus}
            className="w-full rounded-full py-3.5 text-center font-bold text-white bg-primary hover:bg-primary-hover shadow-md transition-all active:scale-[0.99] flex items-center justify-center gap-2 text-sm disabled:opacity-75"
          >
            {isCheckingStatus ? (
              <>
                <svg className="h-4 w-4 animate-spin text-white" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                <span>Đang kiểm tra SePay...</span>
              </>
            ) : (
              <>
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <span>Tôi đã chuyển tiền (Kiểm tra lại)</span>
              </>
            )}
          </button>

          {onQuickTest && (
            <div className="pt-1 text-center">
              <button
                type="button"
                onClick={onQuickTest}
                disabled={isSubmitting || isCheckingStatus}
                className="text-xs text-gray-400 hover:text-gray-600 font-medium transition-colors hover:underline"
              >
                Test nhanh
              </button>
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          disabled={isSubmitting}
          onClick={triggerCheckout}
          className={`mt-6 w-full rounded-full py-4 text-center font-bold text-white shadow-lg transition-all ${
            isSubmitting
              ? 'bg-primary/70 cursor-wait'
              : 'bg-primary hover:bg-primary-hover active:scale-[0.99]'
          }`}
        >
          {isSubmitting ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="h-5 w-5 animate-spin text-white" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Đang xử lý thanh toán...
            </span>
          ) : finalTotal === 0 ? (
            'Hoàn tất đơn hàng miễn phí (0đ)'
          ) : (
            `Xác nhận thanh toán Thẻ ${formatVND(finalTotal)}`
          )}
        </button>
      )}
    </div>
  );
}
