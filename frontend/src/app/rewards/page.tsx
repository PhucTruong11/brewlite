'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Gift, Award, Star, ArrowRight, CheckCircle2, Ticket, Loader2, History, AlertCircle,
} from 'lucide-react';
import api from '@/lib/api';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { useAuth } from '@/hooks/useAuth';
import { useQuery, useQueryClient } from '@tanstack/react-query';

interface RewardOption {
  id: string;
  name: string;
  description: string | null;
  pointsCost: number;
  code: string;
  endDate: string | null;
  redemptionLimit: number | null;
  remainingCount: number | null;
}
interface MyVoucher {
  code: string;
  description: string | null;
  count: number;
  endDate: string | null;
}
interface HistoryItem {
  id: string;
  type: 'EARN' | 'REDEEM' | 'REFUND';
  points: number;
  balanceAfter: number;
  createdAt: string;
}
interface Overview {
  points: number;
  rewards: RewardOption[];
  vouchers: MyVoucher[];
  history: HistoryItem[];
}

const TYPE_LABEL: Record<HistoryItem['type'], string> = {
  EARN: 'Tích điểm từ đơn hàng',
  REDEEM: 'Đổi voucher',
  REFUND: 'Hoàn điểm',
};

function getErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { message?: unknown } } })?.response?.data;
  if (data?.message) {
    return Array.isArray(data.message) ? data.message.join(', ') : String(data.message);
  }
  return fallback;
}

function formatVoucherEndDate(endDate: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(endDate));
}

function RewardsContent() {
  const { user, refetchUser } = useAuth();
  const queryClient = useQueryClient();
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const { data: overview, isPending, error } = useQuery({
    queryKey: ['rewards', 'overview', user?.id],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<Overview | { data: Overview }>('/rewards', { signal });
      return 'data' in data ? data.data : data;
    },
    enabled: !!user,
    refetchOnWindowFocus: 'always',
  });
  const feedback = msg ?? (error
    ? { type: 'error', text: getErrorMessage(error, 'Không tải được dữ liệu điểm thưởng') }
    : null);

  const handleRedeem = async (reward: RewardOption) => {
    if (!overview || redeemingId) return;
    if (overview.points < reward.pointsCost) {
      setMsg({ type: 'error', text: 'Số điểm của bạn chưa đủ để đổi voucher này!' });
      return;
    }
    setRedeemingId(reward.id);
    setMsg(null);
    try {
      const res = await api.post('/rewards/redeem', { rewardItemId: reward.id });
      const data = res.data?.data ?? res.data;
      setMsg({ type: 'success', text: data.message });
      await Promise.all([
        refetchUser(),
        queryClient.invalidateQueries({ queryKey: ['rewards'] }),
      ]);
    } catch (err) {
      setMsg({ type: 'error', text: getErrorMessage(err, 'Đổi voucher thất bại, vui lòng thử lại') });
    } finally {
      setRedeemingId(null);
    }
  };

  if (isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500">
        <Loader2 className="animate-spin mr-2" size={20} /> Đang tải...
      </div>
    );
  }

  const points = overview?.points ?? 0;

  return (
    <div className="min-h-screen bg-surface py-8 px-4 md:px-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-text flex items-center gap-2">
              <Award className="text-primary" size={28} />
              Tích Điểm & Đổi Quà
            </h1>
            <p className="text-gray-500 text-sm mt-1">
              Tích điểm khi đơn hàng hoàn tất, mỗi 10.000đ được 1 điểm.
            </p>
          </div>
          <Link
            href="/"
            className="text-sm font-semibold text-primary hover:underline flex items-center gap-1"
          >
            Quay lại Thực đơn <ArrowRight size={16} />
          </Link>
        </div>

        <div className="bg-gradient-to-r from-emerald-800 to-teal-900 rounded-3xl p-6 text-white shadow-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-6 relative overflow-hidden">
          <div className="space-y-2 z-10">
            <div className="flex items-center gap-2 text-emerald-200 text-sm font-medium">
              <Star className="fill-emerald-400 text-emerald-400" size={18} />
              <span>Số điểm hiện có của bạn</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-5xl font-black tracking-tight">{points.toLocaleString('vi-VN')}</span>
              <span className="text-lg text-emerald-200 font-semibold">điểm</span>
            </div>
          </div>

          <div className="bg-white/10 backdrop-blur-md rounded-2xl p-4 border border-white/20 text-xs text-emerald-100 space-y-1 z-10">
            <p className="font-bold text-white text-sm">💡 Thể lệ tích điểm:</p>
            <p>• Điểm được cộng tự động khi đơn chuyển sang trạng thái Hoàn tất.</p>
            <p>• Với đơn thường, điểm tính trên tổng tiền sau giảm giá và làm tròn xuống theo từng đơn.</p>
            <p>• Với đơn thay thế, điểm tính trên tổng giá trị đơn thay thế, gồm cả phần đền bù đã sử dụng.</p>
            <p>• Voucher đã đổi chỉ dùng được khi mã còn hiệu lực.</p>
            <p>• Mỗi đơn hàng dùng được một voucher.</p>
          </div>

          <div className="absolute -right-10 -bottom-10 w-48 h-48 bg-white/5 rounded-full blur-2xl pointer-events-none" />
        </div>

        {feedback && (
          <div
            className={`p-4 rounded-2xl flex items-center gap-2 text-sm font-medium ${
              feedback.type === 'success'
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : 'bg-red-50 text-red-600 border border-red-200'
            }`}
          >
            {feedback.type === 'success' ? (
              <CheckCircle2 size={18} className="shrink-0" />
            ) : (
              <AlertCircle size={18} className="shrink-0" />
            )}
            <span>{feedback.text}</span>
          </div>
        )}

        {/* Voucher của tôi */}
        <div className="space-y-3">
          <h2 className="text-lg font-bold text-text flex items-center gap-2">
            <Ticket className="text-primary" size={20} />
            Voucher của tôi
          </h2>
          {overview && overview.vouchers.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {overview.vouchers.map((v) => (
                <div
                  key={v.code}
                  className="bg-white border border-emerald-200 rounded-2xl p-4 flex items-center justify-between gap-3"
                >
                  <div>
                    <span className="bg-emerald-100 text-primary border border-emerald-200 text-xs font-bold px-2.5 py-0.5 rounded-lg uppercase">
                      {v.code}
                    </span>
                    <p className="text-sm text-text mt-2">{v.description}</p>
                    <p className="text-xs text-gray-400 mt-1">Nhập mã này ở trang thanh toán</p>
                    {v.endDate && (
                      <p className="text-xs text-gray-500 mt-1">
                        Hết hạn: <span className="font-semibold text-gray-700">{formatVoucherEndDate(v.endDate)}</span>
                      </p>
                    )}
                  </div>
                  <span className="text-xl font-black text-primary shrink-0">×{v.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400">Bạn chưa có voucher nào. Hãy đổi điểm bên dưới.</p>
          )}
        </div>

        {/* Kho ưu đãi */}
        <div className="space-y-4">
          <h2 className="text-lg font-bold text-text flex items-center gap-2">
            <Gift className="text-primary" size={20} />
            Kho Ưu Đãi Đổi Điểm
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {overview?.rewards.map((r) => {
              const canRedeem = points >= r.pointsCost;
              const isRedeeming = redeemingId === r.id;
              return (
                <div
                  key={r.id}
                  className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm hover:shadow-md transition-all flex justify-between items-center gap-4"
                >
                  <div className="space-y-2">
                    <span className="bg-emerald-100 text-primary border border-emerald-200 text-xs font-bold px-2.5 py-0.5 rounded-lg uppercase">
                      {r.code}
                    </span>
                    <p className="font-bold text-text text-base">{r.description ?? r.name}</p>
                    <div className="flex items-center gap-1 text-primary text-xs font-bold">
                      <Ticket size={14} />
                      <span>Cần {r.pointsCost} điểm</span>
                    </div>
                    <p className="text-xs text-gray-500">
                      {r.remainingCount === null
                        ? 'Số lượng đổi: Không giới hạn'
                        : `Còn đổi được: ${r.remainingCount}/${r.redemptionLimit}`}
                    </p>
                    {r.endDate && (
                      <p className="text-xs text-gray-500">
                        Hết hạn: {new Date(r.endDate).toLocaleDateString('vi-VN')}
                      </p>
                    )}
                  </div>

                  <button
                    onClick={() => handleRedeem(r)}
                    disabled={!canRedeem || redeemingId !== null}
                    className={`px-4 py-2.5 rounded-xl text-xs font-bold transition-all shrink-0 flex items-center gap-1 ${
                      canRedeem
                        ? 'bg-primary text-white hover:bg-primary-hover shadow-sm active:scale-95 disabled:opacity-60'
                        : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                    }`}
                  >
                    {isRedeeming ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : canRedeem ? (
                      'Đổi ngay'
                    ) : (
                      'Chưa đủ điểm'
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Lịch sử điểm */}
        <div className="space-y-3">
          <h2 className="text-lg font-bold text-text flex items-center gap-2">
            <History className="text-primary" size={20} />
            Lịch sử điểm
          </h2>
          {overview && overview.history.length > 0 ? (
            <div className="bg-white border border-gray-100 rounded-2xl divide-y divide-gray-100">
              {overview.history.map((h) => (
                <div key={h.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <div>
                    <p className="font-semibold text-text">{TYPE_LABEL[h.type]}</p>
                    <p className="text-xs text-gray-400">
                      {new Date(h.createdAt).toLocaleString('vi-VN')} · Số dư {h.balanceAfter}
                    </p>
                  </div>
                  <span className={`font-bold ${h.points > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                    {h.points > 0 ? `+${h.points}` : h.points}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400">Chưa có giao dịch điểm nào.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function RewardsPage() {
  return (
    <RequireAuth>
      <RewardsContent />
    </RequireAuth>
  );
}
