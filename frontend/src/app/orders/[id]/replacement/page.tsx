'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';
import { getCompensation, replacementCheckoutHref } from '@/lib/order-compensation';
import { useCartStore } from '@/stores/cart.store';

function ReplacementEntry() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const resetRequested = searchParams.get('reset') === '1';
  const { user } = useAuth();
  const selectReplacement = useCartStore((state) => state.selectReplacement);
  const clearCart = useCartStore((state) => state.clearCart);
  const { data, isError, refetch } = useQuery({
    queryKey: ['replacement', user?.id, id],
    queryFn: () => getCompensation(id),
    retry: false,
  });

  useEffect(() => {
    if (!data || !user) return;
    const order = data.replacement;
    if (resetRequested && order?.status === 'PENDING') {
      api.post('/orders/' + id + '/replacement/cancel', { orderId: order.id })
        .then(() => {
          if (useCartStore.getState().replacementSourceId === id) clearCart();
          selectReplacement(id);
          router.replace('/');
        })
        .catch(() => router.replace(replacementCheckoutHref(order.id, id)));
      return;
    }
    if (!order) {
      selectReplacement(id);
      router.replace('/');
    } else if (order.status === 'PENDING') {
      router.replace(replacementCheckoutHref(order.id, id));
    } else {
      const cart = useCartStore.getState();
      if (cart.replacementSourceId === id) cart.clearCart();
      router.replace('/orders/' + order.id);
    }
  }, [data, id, user, resetRequested, selectReplacement, clearCart, router]);

  return (
    <main className="mx-auto max-w-xl space-y-3 px-4 py-16 text-center">
      {isError ? (
        <>
          <p>Không tải được lượt đền bù.</p>
          <button type="button" onClick={() => void refetch()} className="font-bold text-primary underline">Thử lại</button>
        </>
      ) : <p>Đang mở đơn thay thế…</p>}
    </main>
  );
}

export default function ReplacementPage() {
  return <RequireAuth><ReplacementEntry /></RequireAuth>;
}
