'use client';

import React from 'react';
import Link from 'next/link';
import { formatVND } from '@/lib/utils';
import { formatCartToppings, getCartLineTotal } from '@/lib/cart';
import type { CartItem } from '@/types';

export interface ReceiptData {
  orderId: string;
  invoiceNo: string;
  paymentId: string;
  paidAt: string;
  items: CartItem[];
  subtotal: number;
  discount: number;
  promoCode: string | null;
  finalTotal: number;
  pointsEarned: number;
  method: 'EWALLET' | 'CARD';
}

interface ReceiptInvoiceProps {
  data: ReceiptData;
  onReset?: () => void;
}

export function ReceiptInvoice({ data, onReset }: ReceiptInvoiceProps) {
  return (
    <div className="flex w-full flex-col items-center">
      {/* Banner thông báo thành công */}
      <div className="mb-6 flex w-full items-center justify-center gap-3 rounded-2xl bg-emerald-50 p-4 border border-emerald-200 text-emerald-800">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-white font-bold text-xl">
          ✓
        </span>
        <div>
          <h2 className="text-lg font-bold text-[#1E3932]">Thanh toán thành công!</h2>
          <p className="text-sm text-emerald-700">
            Đơn hàng đã được xác nhận và chuyển đến quầy pha chế. Dưới đây là hóa đơn điện tử của bạn.
          </p>
        </div>
      </div>

      {/* TỜ HÓA ĐƠN ĐIỆN TỬ (E-RECEIPT) */}
      <div
        id="brewlite-receipt"
        className="relative w-full rounded-2xl bg-white p-6 sm:p-8 shadow-xl border border-emerald-900/10 text-[#1E3932]"
      >
        {/* Header hóa đơn */}
        <div className="border-b-2 border-dashed border-gray-200 pb-6 text-center">
          <span className="text-xs uppercase tracking-widest font-extrabold text-primary">
            ☕ BrewLite Coffee & Tea
          </span>
          <h1 className="mt-1 text-2xl font-black text-[#1E3932]">HÓA ĐƠN THANH TOÁN</h1>
          <p className="text-xs text-gray-500 mt-1">273 An Dương Vương, P.3, Q.5, TP. Hồ Chí Minh</p>
          <p className="text-xs text-gray-500">Hotline: 1900 6868 | Website: www.brewlite.vn</p>

          <div className="mt-4 flex flex-wrap items-center justify-between text-xs text-gray-600 bg-gray-50 p-2.5 rounded-lg border border-gray-100">
            <div>
              <span>Số HĐ: </span>
              <strong className="text-gray-900">{data.invoiceNo}</strong>
            </div>
            <div>
              <span>Thời gian: </span>
              <span className="text-gray-800">{data.paidAt}</span>
            </div>
          </div>
        </div>

        {/* Danh sách món chi tiết */}
        <div className="py-5">
          <div className="flex text-xs font-bold text-gray-400 uppercase tracking-wider pb-2 border-b border-gray-100">
            <span className="flex-1">Món / Size & Topping</span>
            <span className="w-12 text-center">SL</span>
            <span className="w-24 text-right">Thành tiền</span>
          </div>

          <div className="divide-y divide-gray-100 text-sm">
            {data.items.map((item, idx) => (
              <div key={idx} className="py-3 flex items-start justify-between gap-2">
                <div className="flex-1">
                  <p className="font-semibold text-[#1E3932]">{item.name}</p>
                  <div className="text-xs text-gray-500 mt-0.5">
                    <span className="inline-block rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-800 mr-2">
                      Size {item.size}
                    </span>
                    {item.toppings && item.toppings.length > 0 && (
                      <span>+ {formatCartToppings(item.toppings)}</span>
                    )}
                  </div>
                </div>
                <div className="w-12 text-center text-gray-700 font-medium">x{item.quantity}</div>
                <div className="w-24 text-right font-semibold text-[#1E3932]">
                  {formatVND(getCartLineTotal(item))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Bảng tổng kết tiền */}
        <div className="border-t-2 border-dashed border-gray-200 pt-4 space-y-2 text-sm">
          <div className="flex justify-between text-gray-600">
            <span>Tạm tính:</span>
            <span className="font-medium text-gray-900">{formatVND(data.subtotal)}</span>
          </div>

          {data.discount > 0 && (
            <div className="flex justify-between text-emerald-700">
              <span>Voucher giảm giá ({data.promoCode}):</span>
              <span className="font-bold">-{formatVND(data.discount)}</span>
            </div>
          )}

          <div className="flex items-center justify-between text-base font-extrabold text-[#1E3932] pt-2 border-t border-gray-100">
            <span>TỔNG CỘNG:</span>
            <span className="text-xl text-primary font-black">
              {formatVND(data.finalTotal)}
            </span>
          </div>
        </div>

        {/* Chi tiết giao dịch & Điểm thưởng */}
        <div className="mt-5 rounded-xl bg-[#FAF6EE] p-4 border border-[#006241]/15 space-y-2 text-xs">
          <div className="flex justify-between">
            <span className="text-gray-600">Phương thức thanh toán:</span>
            <strong className="text-primary font-bold">
              {data.method === 'EWALLET' ? 'Ví điện tử MoMo / VietQR' : 'Thẻ ngân hàng (ATM/Visa)'}
            </strong>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Mã giao dịch:</span>
            <code className="text-gray-800 font-mono">{data.paymentId}</code>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Trạng thái giao dịch:</span>
            <span className="font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
              PAID (ĐÃ THANH TOÁN)
            </span>
          </div>
          <div className="flex justify-between items-center pt-2 border-t border-[#006241]/10 text-emerald-900 font-bold">
            <span>Điểm thưởng dự kiến (cộng khi đơn hoàn tất):</span>
            <span className="text-sm bg-primary text-white px-2 py-0.5 rounded-full">
              +{data.pointsEarned} điểm
            </span>
          </div>
        </div>

        {/* Mã vạch Barcode và Lời cảm ơn */}
        <div className="mt-6 text-center border-t border-gray-100 pt-4">
          <div className="inline-block p-2 bg-gray-50 rounded-lg border border-gray-200">
            {/* Giả lập Barcode bằng CSS bars */}
            <div className="flex h-10 items-end justify-center gap-[3px] px-4">
              {[4, 2, 5, 1, 3, 2, 4, 3, 5, 2, 1, 4, 3, 2, 5, 3, 2, 4, 1, 3, 4, 2].map((h, i) => (
                <div
                  key={i}
                  className="w-[3px] bg-gray-800"
                  style={{ height: `${h * 7}px` }}
                />
              ))}
            </div>
            <span className="text-[10px] tracking-widest text-gray-500 font-mono mt-1 block">
              {data.orderId}
            </span>
          </div>
          <p className="mt-3 text-xs italic text-gray-500">
            Vui lòng giữ hóa đơn để nhận nước tại quầy khi đồ uống hoàn thành.
          </p>
          <p className="text-xs font-semibold text-primary mt-1">Cảm ơn và hẹn gặp lại quý khách! ☕</p>
        </div>
      </div>

      {/* Nút hành động */}
      <div className="mt-6 flex w-full max-w-2xl flex-col sm:flex-row gap-3 no-print">
        <Link
          href={`/orders/${data.orderId}`}
          onClick={onReset}
          className="flex-1 flex items-center justify-center gap-2 rounded-full bg-emerald-700 py-3.5 text-center font-bold text-white hover:bg-emerald-800 transition-colors shadow-md"
        >
          Theo Dõi Đơn Hàng
        </Link>

        <button
          type="button"
          onClick={() => window.print()}
          className="flex-1 flex items-center justify-center gap-2 rounded-full border-2 border-primary bg-white py-3.5 text-center font-bold text-primary hover:bg-emerald-50 transition-colors shadow-sm"
        >
          In / Tải hóa đơn (PDF)
        </button>

        <Link
          href="/"
          onClick={onReset}
          className="flex-1 flex items-center justify-center gap-2 rounded-full bg-primary py-3.5 text-center font-bold text-white hover:bg-primary-hover transition-colors shadow-lg"
        >
          Về Trang Chủ Đặt Món
        </Link>
      </div>
    </div>
  );
}
