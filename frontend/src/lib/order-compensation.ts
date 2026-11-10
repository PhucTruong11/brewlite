import api from '@/lib/api';
import type { ApiResponse, OrderStatus } from '@/types';

export type CompensationBankInfo = {
  bankName: string;
  accountNo: string;
  accountName: string;
  transferContent: string;
};

export type Compensation = {
  amount: number;
  bankInfo?: CompensationBankInfo;
  replacement: {
    id: string;
    status: OrderStatus;
    total: number;
    amountDue: number;
    remainingSeconds: number;
    canPay: boolean;
    paymentLink: { qrCodeUrl: string; checkoutUrl?: string } | null;
  } | null;
};

export const replacementPath = (id: string) => '/orders/' + id + '/replacement';
export const replacementCheckoutHref = (orderId: string, sourceId: string) =>
  '/checkout?' + new URLSearchParams({ orderId, replacementFor: sourceId });

export async function getCompensation(sourceId: string) {
  return (await api.get<ApiResponse<Compensation>>(replacementPath(sourceId))).data.data;
}
