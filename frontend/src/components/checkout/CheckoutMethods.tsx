'use client';

import React, { useState } from 'react';
import { formatVND } from '@/lib/utils';

export interface CardFormData {
  cardNumber: string;
  cardHolder: string;
  expiry: string;
  cvv: string;
}

export interface CardFormErrors {
  cardNumber?: string;
  cardHolder?: string;
  expiry?: string;
  cvv?: string;
}

export interface BankInfo {
  bankName: string;
  accountNo: string;
  accountName: string;
  transferContent: string;
}

export interface CheckoutMethodsProps {
  method: 'EWALLET' | 'CARD';
  onMethodChange: (method: 'EWALLET' | 'CARD') => void;
  finalTotal: number;
  qrUrl: string;
  bankInfo?: BankInfo;
  cardInfo: CardFormData;
  onCardInfoChange: (data: CardFormData) => void;
  cardErrors?: CardFormErrors;
  onFillDemoCard?: () => void;
  onClearCard?: () => void;
}

function formatCardNumber(val: string): string {
  const digits = val.replace(/\D/g, '').slice(0, 16);
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
}

function formatExpiry(val: string): string {
  const digits = val.replace(/\D/g, '').slice(0, 4);
  if (digits.length >= 3) {
    return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  }
  return digits;
}

function formatCVV(val: string): string {
  return val.replace(/\D/g, '').slice(0, 4);
}

export function CheckoutMethods({
  method,
  onMethodChange,
  finalTotal,
  qrUrl,
  bankInfo,
  cardInfo,
  onCardInfoChange,
  cardErrors,
  onFillDemoCard,
  onClearCard,
}: CheckoutMethodsProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyContent = () => {
    if (bankInfo?.transferContent) {
      navigator.clipboard.writeText(bankInfo.transferContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm border border-emerald-900/10">
      <h2 className="text-lg font-bold text-[#1E3932] mb-4">
        Chọn phương thức thanh toán
      </h2>

      {/* Tabs chuyển đổi */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <button
          type="button"
          onClick={() => onMethodChange('EWALLET')}
          className={`flex flex-col items-center justify-center gap-2 rounded-xl p-4 border-2 transition-all ${
            method === 'EWALLET'
              ? 'border-primary bg-emerald-50/50 text-primary font-bold shadow-sm'
              : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
          }`}
        >
          <span className="text-sm">VietQR (SePay) / MoMo</span>
        </button>

        <button
          type="button"
          onClick={() => onMethodChange('CARD')}
          className={`flex flex-col items-center justify-center gap-2 rounded-xl p-4 border-2 transition-all ${
            method === 'CARD'
              ? 'border-primary bg-emerald-50/50 text-primary font-bold shadow-sm'
              : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
          }`}
        >
          <span className="text-sm">Thẻ ngân hàng</span>
        </button>
      </div>

      {/* Chi tiết cho Tab Ví MoMo / VietQR */}
      {method === 'EWALLET' && (
        <div className="flex flex-col items-center rounded-xl bg-emerald-50/40 p-6 border border-emerald-100 text-center">
          <p className="text-xs uppercase tracking-wider font-extrabold text-primary mb-3">
            Quét mã VietQR chuyển khoản tự động
          </p>

          <div className="relative rounded-2xl bg-white p-4 shadow-md border-2 border-primary/20 flex flex-col items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qrUrl}
              alt="Mã QR thanh toán SePay"
              className="h-52 w-52 object-contain rounded-lg"
            />
            <div className="mt-2 text-[12px] font-semibold text-gray-700">
              Số tiền: <strong className="text-primary text-sm">{formatVND(finalTotal)}</strong>
            </div>
          </div>

          {/* Khung chi tiết tài khoản ngân hàng SePay */}
          {bankInfo && (
            <div className="mt-4 w-full max-w-sm rounded-xl bg-white p-3.5 text-left border border-emerald-200/80 shadow-sm text-xs space-y-2">
              <div className="flex justify-between items-center text-gray-600">
                <span className="font-medium">Ngân hàng:</span>
                <strong className="text-gray-900 font-bold">{bankInfo.bankName}</strong>
              </div>
              <div className="flex justify-between items-center text-gray-600">
                <span className="font-medium">Số tài khoản:</span>
                <strong className="font-mono text-primary font-bold text-sm tracking-wide">{bankInfo.accountNo}</strong>
              </div>
              <div className="flex justify-between items-center text-gray-600">
                <span className="font-medium">Chủ tài khoản:</span>
                <strong className="text-gray-900 font-bold">{bankInfo.accountName}</strong>
              </div>
              <div className="flex justify-between items-center pt-2 border-t border-dashed border-gray-200">
                <span className="font-medium text-gray-700">Nội dung CK:</span>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono font-bold text-red-600 bg-red-50 px-2 py-0.5 rounded border border-red-200">
                    {bankInfo.transferContent}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyContent}
                    className="text-[10px] bg-gray-100 hover:bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded border transition-colors font-medium"
                  >
                    {copied ? '✓ Đã chép' : 'Sao chép'}
                  </button>
                </div>
              </div>
            </div>
          )}

          <p className="text-xs text-gray-600 mt-4 max-w-xs">
            Mở bất kỳ <strong>App Ngân Hàng</strong> hoặc <strong>MoMo</strong> quét mã QR trên để chuyển khoản. Hệ thống SePay sẽ tự động ghi nhận tiền về trong 3 - 5 giây!
          </p>
        </div>
      )}

      {/* Chi tiết cho Tab Thẻ ngân hàng */}
      {method === 'CARD' && (
        <div className="flex flex-col gap-4">
          {/* Thẻ ATM/Visa mô phỏng */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-tr from-[#004d33] via-[#006241] to-[#1E5631] p-5 text-white shadow-lg">
            <div className="flex justify-between items-center">
              <span className="text-xs font-bold tracking-widest opacity-80 uppercase">
                BrewLite Platinum Card
              </span>
              <span className="text-xl font-black italic">VISA</span>
            </div>
            <div className="my-5 font-mono text-lg tracking-widest">
              {cardInfo.cardNumber || '•••• •••• •••• ••••'}
            </div>
            <div className="flex justify-between text-xs opacity-90">
              <div>
                <span className="text-[10px] block opacity-70">CHỦ THẺ</span>
                <strong className="tracking-wider">{cardInfo.cardHolder || 'HO VA TEN'}</strong>
              </div>
              <div className="flex gap-4">
                <div>
                  <span className="text-[10px] block opacity-70">HẾT HẠN</span>
                  <strong>{cardInfo.expiry || 'MM/YY'}</strong>
                </div>
                <div>
                  <span className="text-[10px] block opacity-70">CVV</span>
                  <strong>{cardInfo.cvv ? '•••' : '---'}</strong>
                </div>
              </div>
            </div>
          </div>

          {/* Form nhập thẻ */}
          <div className="space-y-3 text-xs text-[#1E3932] mt-1">
            <div className="flex justify-between items-center mb-1">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-gray-700">Thông tin thẻ:</span>
                <span className="text-[10px] font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
                  Thẻ test điền sẵn
                </span>
              </div>
              <div className="flex gap-2">
                {onFillDemoCard && (
                  <button
                    type="button"
                    onClick={onFillDemoCard}
                    className="text-[11px] text-primary hover:underline font-semibold"
                  >
                    Điền thẻ mẫu
                  </button>
                )}
                {onClearCard && (
                  <button
                    type="button"
                    onClick={onClearCard}
                    className="text-[11px] text-gray-500 hover:text-red-500 hover:underline"
                  >
                    Xóa trắng
                  </button>
                )}
              </div>
            </div>

            <div>
              <label className="font-semibold block mb-1">
                Số thẻ (16 chữ số): <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                placeholder="9704 2200 8888 6666"
                maxLength={19}
                value={cardInfo.cardNumber}
                onChange={(e) =>
                  onCardInfoChange({ ...cardInfo, cardNumber: formatCardNumber(e.target.value) })
                }
                className={`w-full rounded-xl border p-2.5 text-sm font-mono outline-none transition-colors ${
                  cardErrors?.cardNumber
                    ? 'border-red-500 bg-red-50/40 focus:border-red-600'
                    : 'border-gray-200 bg-[#FAF6EE] focus:border-primary'
                }`}
              />
              {cardErrors?.cardNumber && (
                <p className="mt-1 text-[11px] text-red-600 font-medium">⚠️ {cardErrors.cardNumber}</p>
              )}
            </div>

            <div>
              <label className="font-semibold block mb-1">
                Họ tên chủ thẻ (Không dấu): <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                placeholder="NGUYEN VAN A"
                value={cardInfo.cardHolder}
                onChange={(e) =>
                  onCardInfoChange({ ...cardInfo, cardHolder: e.target.value.toUpperCase() })
                }
                className={`w-full rounded-xl border p-2.5 text-sm uppercase outline-none transition-colors ${
                  cardErrors?.cardHolder
                    ? 'border-red-500 bg-red-50/40 focus:border-red-600'
                    : 'border-gray-200 bg-[#FAF6EE] focus:border-primary'
                }`}
              />
              {cardErrors?.cardHolder && (
                <p className="mt-1 text-[11px] text-red-600 font-medium">⚠️ {cardErrors.cardHolder}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="font-semibold block mb-1">
                  Ngày hết hạn (MM/YY): <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="12/28"
                  maxLength={5}
                  value={cardInfo.expiry}
                  onChange={(e) =>
                    onCardInfoChange({ ...cardInfo, expiry: formatExpiry(e.target.value) })
                  }
                  className={`w-full rounded-xl border p-2.5 text-sm font-mono outline-none transition-colors ${
                    cardErrors?.expiry
                      ? 'border-red-500 bg-red-50/40 focus:border-red-600'
                      : 'border-gray-200 bg-[#FAF6EE] focus:border-primary'
                  }`}
                />
                {cardErrors?.expiry && (
                  <p className="mt-1 text-[11px] text-red-600 font-medium">⚠️ {cardErrors.expiry}</p>
                )}
              </div>

              <div>
                <label className="font-semibold block mb-1">
                  Mã bảo mật (CVV): <span className="text-red-500">*</span>
                </label>
                <input
                  type="password"
                  placeholder="888"
                  maxLength={4}
                  value={cardInfo.cvv}
                  onChange={(e) =>
                    onCardInfoChange({ ...cardInfo, cvv: formatCVV(e.target.value) })
                  }
                  className={`w-full rounded-xl border p-2.5 text-sm font-mono outline-none transition-colors ${
                    cardErrors?.cvv
                      ? 'border-red-500 bg-red-50/40 focus:border-red-600'
                      : 'border-gray-200 bg-[#FAF6EE] focus:border-primary'
                  }`}
                />
                {cardErrors?.cvv && (
                  <p className="mt-1 text-[11px] text-red-600 font-medium">⚠️ {cardErrors.cvv}</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { CheckoutMethods as PaymentMethods };
