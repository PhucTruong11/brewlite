'use client';

import Image from 'next/image';
import { Trash2, Minus, Plus } from 'lucide-react';
import { useCartStore, type CartItem } from '@/stores/cart.store';
import { formatCartToppings, getCartItemKey, getCartLineTotal, toOrderItem } from '@/lib/cart';
import { cartValidationMessage, validateCart } from '@/lib/validate-cart';
import { useState } from 'react';

interface CartItemRowProps {
  item: CartItem;
  index: number;
  disabled?: boolean;
}

export function CartItemRow({ item, index, disabled = false }: CartItemRowProps) {
  const { items, updateQuantity, removeItem } = useCartStore();
  const [checking, setChecking] = useState(false);
  const [stockError, setStockError] = useState<{ message: string; cartSignature: string } | null>(null);
  const cartSignature = JSON.stringify(items.map(toOrderItem));
  const visibleStockError = stockError?.cartSignature === cartSignature ? stockError.message : null;

  const handleDecrease = () => {
    if (disabled) return;
    setStockError(null);
    updateQuantity(index, item.quantity - 1);
  };

  const handleIncrease = async () => {
    if (checking || disabled) return;
    const checkedCartSignature = cartSignature;
    const cartUnchanged = () =>
      JSON.stringify(useCartStore.getState().items.map(toOrderItem)) === checkedCartSignature;
    setChecking(true);
    setStockError(null);
    try {
      const candidate = items.map((row, rowIndex) =>
        rowIndex === index ? { ...row, quantity: row.quantity + 1 } : row);
      const validation = await validateCart(candidate);
      if (!cartUnchanged()) return;
      if (!validation.available) {
        setStockError({
          message: cartValidationMessage(validation) ?? 'Không đủ nguyên liệu.',
          cartSignature: checkedCartSignature,
        });
        return;
      }
      const current = useCartStore.getState().items[index];
      if (!current || getCartItemKey(current) !== getCartItemKey(item) || current.quantity !== item.quantity) return;
      updateQuantity(index, item.quantity + 1);
    } catch {
      if (cartUnchanged()) {
        setStockError({
          message: 'Không kiểm tra được nguyên liệu. Vui lòng thử lại.',
          cartSignature: checkedCartSignature,
        });
      }
    } finally {
      setChecking(false);
    }
  };

  const handleRemove = () => {
    if (disabled) return;
    removeItem(index);
  };

  return (
    <div className="flex items-start justify-between gap-4 py-4 border-b border-gray-100 last:border-0">
      {/* 1. Hình ảnh */}
      <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-gray-100 border border-gray-100 shadow-sm">
        {item.imageUrl ? (
          <Image
            src={item.imageUrl}
            alt={item.name}
            fill
            className="object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-gray-300 font-bold text-xs">
            IMG
          </div>
        )}
      </div>

      {/* 2. Thông tin chi tiết (Tên, Size, Topping) */}
      <div className="flex-1 flex flex-col justify-between h-20">
        <div>
          <h3 className="font-bold text-text text-base leading-tight line-clamp-1">
            {item.name}
          </h3>
          <p className="mt-0.5 text-sm font-medium text-gray-500">Size {item.size}</p>

          {item.toppings && item.toppings.length > 0 && (
            <p className="text-xs text-gray-400 mt-0.5 line-clamp-1" title={formatCartToppings(item.toppings)}>
              + {formatCartToppings(item.toppings)}
            </p>
          )}
        </div>

        {/* 3. Giá tiền của dòng này */}
        <p className="font-bold text-primary text-lg">
          {getCartLineTotal(item).toLocaleString('vi-VN')}đ
        </p>
      </div>

      {/* 4. Nhóm điều khiển: Số lượng & Nút Xóa */}
      <div className="flex min-h-20 flex-col items-end justify-between gap-3">
        <button
          onClick={handleRemove}
          disabled={disabled}
          className="text-gray-300 hover:text-red-500 transition-colors p-1"
          title="Xóa món này"
        >
          <Trash2 size={20} />
        </button>

        <div className="flex items-center gap-3 bg-white rounded-full px-1.5 py-1.5 border border-gray-200 shadow-sm">
          <button
            onClick={handleDecrease}
            disabled={disabled}
            className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-text hover:bg-gray-200 transition-colors"
          >
            <Minus size={14} />
          </button>

          <span className="w-4 text-center text-sm font-bold text-text">
            {item.quantity}
          </span>

          <button
            onClick={handleIncrease}
            disabled={checking || disabled}
            title={checking ? 'Đang kiểm tra nguyên liệu' : 'Thêm một phần'}
            className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-text hover:bg-gray-200 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={14} />
          </button>
        </div>
        {visibleStockError && <p role="alert" className="max-w-48 text-right text-xs text-red-600">{visibleStockError}</p>}
      </div>
    </div>
  );
}
