'use client';

import React from 'react';

export interface CountdownTimerProps {
  timeLeft?: number; 
  isExpired?: boolean;
  canRenew?: boolean;
  attempt?: number;
  showUI?: boolean;
  detail?: string;
}

/** Hiển thị thời gian thanh toán còn lại theo hạn giữ nguyên liệu của đơn trên máy chủ. */
export function CountdownTimer({
  timeLeft = 0,
  isExpired = false,
  canRenew = false,
  attempt = 1,
  showUI = false,
  detail,
}: CountdownTimerProps) {
  if (!showUI) {
    return null;
  }

  const remaining = isExpired ? 0 : Math.max(0, timeLeft);
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const timeFormatted = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

  return (
    <div className={`flex flex-wrap items-center justify-between gap-4 rounded-2xl border px-5 py-4 shadow-sm ${isExpired ? 'border-red-200 bg-red-50 text-red-800' : remaining <= 30 ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>
      <div>
        <p className="font-bold">{isExpired ? 'Đã hết thời gian thanh toán' : 'Thời gian thanh toán còn lại'}</p>
        <p className="mt-1 text-sm">
          {detail ?? (isExpired
            ? canRenew ? 'Bạn có thể gia hạn thêm 2 phút một lần.' : 'Đã dùng hết lượt gia hạn. Vui lòng quay lại giỏ hàng.'
            : `Lượt ${attempt}/2 · ${canRenew ? 'Có thể gia hạn thêm 1 lần' : 'Lượt gia hạn cuối cùng'}`)}
        </p>
      </div>
      <div role="timer" aria-label={`Thời gian còn lại ${minutes} phút ${seconds} giây`} className="rounded-xl border border-current/20 bg-white px-4 py-2 font-mono text-2xl font-extrabold tabular-nums tracking-wider">
        {timeFormatted}
      </div>
    </div>
  );
}
