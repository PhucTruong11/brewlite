import { getCheckoutSignature, type CartItem } from './cart';

export interface CheckoutPayment {
  id: string;
  method: 'CARD' | 'EWALLET';
  status: string;
  createdAt: string;
}

export function successfulCheckoutPayment(payments: CheckoutPayment[] = []): CheckoutPayment | undefined {
  return payments.filter(payment => payment.status === 'SUCCESS')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
}

export interface PendingOrder {
  id: string;
  status: string;
  reservationExpiresAt: string;
  promoCode: string | null;
  items: Array<{
    productId: string | null;
    productName: string;
    productImageUrl?: string | null;
    size: string;
    qty: number;
    toppings: string[];
    lineTotal: number;
  }>;
}

export function pendingOrderSignature(order: PendingOrder): string {
  return getCheckoutSignature(order.items.map(item => ({
    productId: item.productId ?? undefined,
    name: item.productName,
    size: item.size,
    quantity: item.qty,
    toppings: item.toppings,
    unitPrice: item.lineTotal / item.qty,
  } satisfies CartItem)), order.promoCode);
}
