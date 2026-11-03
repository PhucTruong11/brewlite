'use client';

import { create } from 'zustand';
import { getCartItemKey, getCartLineTotal, type CartItem } from '../lib/cart';
import { recalculatePromo, type AppliedPromo } from '../lib/voucher';

export type { CartItem } from '../lib/cart';

interface CartStore {
  items: CartItem[];
  currentUserId: string | null;
  appliedPromo: AppliedPromo | null;

  initUserCart: (userId: string | null) => void;
  addItem: (item: CartItem) => boolean;
  removeItem: (index: number) => void;
  updateQuantity: (index: number, quantity: number) => void;
  clearCart: () => void;
  totalPrice: () => number;
  totalItems: () => number;
  applyPromo: (promo: AppliedPromo) => void;
  removePromo: () => void;
  setProductStocks: (stocks: Record<string, number>) => void;
}

const getCartKey = (userId: string | null) => {
  return userId ? `brewlite_cart_user_${userId}` : `brewlite_cart_guest`;
};

const getPromoKey = (userId: string | null) => `${getCartKey(userId)}_promo`;

const mergeCartItems = (existingItems: CartItem[], guestItems: CartItem[]): CartItem[] => {
  const merged: CartItem[] = [];

  [...existingItems, ...guestItems].forEach((guestItem) => {
    const existingIndex = merged.findIndex(
      (item) => getCartItemKey(item) === getCartItemKey(guestItem)
    );

    if (existingIndex > -1) {
      const quantity = merged[existingIndex].quantity + guestItem.quantity;
      merged[existingIndex] = {
        ...merged[existingIndex],
        stock: guestItem.stock ?? merged[existingIndex].stock,
        quantity,
        lineTotal: getCartLineTotal({ ...merged[existingIndex], quantity }),
      };
    } else {
      merged.push({ ...guestItem, lineTotal: getCartLineTotal(guestItem) });
    }
  });

  return merged;
};

const readCartItems = (key: string): CartItem[] => {
  try {
    const saved = localStorage.getItem(key);
    const parsed: unknown = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(parsed)) return [];

    return mergeCartItems([], parsed.filter((item): item is CartItem =>
      item !== null && typeof item === 'object' &&
      typeof item.name === 'string' && typeof item.size === 'string' &&
      Number.isSafeInteger(item.quantity) && item.quantity > 0 &&
      (item.stock === undefined || (Number.isSafeInteger(item.stock) && item.stock >= 0)) &&
      Number.isFinite(item.unitPrice) && item.unitPrice >= 0 &&
      (item.toppings === undefined || (Array.isArray(item.toppings) &&
        item.toppings.every((topping: unknown) => typeof topping === 'string' ||
          (topping !== null && typeof topping === 'object' &&
            'name' in topping && typeof topping.name === 'string'))))
    ));
  } catch (error) {
    console.error('Lỗi khi đọc giỏ hàng:', error);
    return [];
  }
};

const readSavedPromo = (userId: string | null): AppliedPromo | null => {
  try {
    const saved = localStorage.getItem(getPromoKey(userId));
    const promo = saved ? JSON.parse(saved) as AppliedPromo | null : null;
    const rules = promo?.rules;
    if (!promo || typeof promo.code !== 'string' || !promo.code.trim() ||
      typeof promo.description !== 'string' || !rules ||
      !['PERCENTAGE', 'FIXED_AMOUNT'].includes(rules.discountType) ||
      !Number.isFinite(rules.discountValue) || rules.discountValue < 0 ||
      (rules.discountType === 'PERCENTAGE' && rules.discountValue > 100) ||
      !Number.isFinite(rules.minOrderValue) || rules.minOrderValue < 0 ||
      (rules.maxDiscount != null && (!Number.isFinite(rules.maxDiscount) || rules.maxDiscount < 0))) {
      return null;
    }
    return promo;
  } catch {
    return null;
  }
};

const resetCheckoutTimer = () => {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('brewlite_checkout_deadline');
};

const promoForItems = (promo: AppliedPromo | null, items: CartItem[]) =>
  recalculatePromo(promo, items.reduce((total, item) => total + getCartLineTotal(item), 0));

const saveToStorage = (userId: string | null, items: CartItem[], appliedPromo: AppliedPromo | null) => {
  if (typeof window !== 'undefined') {
    const key = getCartKey(userId);
    localStorage.setItem(key, JSON.stringify(items));
    if (appliedPromo) {
      localStorage.setItem(getPromoKey(userId), JSON.stringify(appliedPromo));
    } else {
      localStorage.removeItem(getPromoKey(userId));
    }
  }
};

// Các thao tác thay đổi trạng thái giỏ hàng.
export const useCartStore = create<CartStore>((set, get) => ({
  items: [],
  currentUserId: null,
  appliedPromo: null,

  initUserCart: (userId: string | null) => {
    if (typeof window === 'undefined') return;

    const guestKey = getCartKey(null);
    const guestItems = readCartItems(guestKey);
    const savedPromo = readSavedPromo(userId);

    if (userId) {
      const userKey = getCartKey(userId);
      let userItems = readCartItems(userKey);

      if (guestItems.length > 0) {
        userItems = mergeCartItems(userItems, guestItems);
      }

      const guestPromo = guestItems.length > 0 ? readSavedPromo(null) : null;
      const appliedPromo = promoForItems(guestPromo, userItems) ?? promoForItems(savedPromo, userItems);
      saveToStorage(userId, userItems, appliedPromo);
      if (guestItems.length > 0) {
        localStorage.removeItem(guestKey);
        localStorage.removeItem(getPromoKey(null));
      }
      set({ currentUserId: userId, items: userItems, appliedPromo });
    } else {
      const appliedPromo = promoForItems(savedPromo, guestItems);
      set({ currentUserId: null, items: guestItems, appliedPromo });
      saveToStorage(null, guestItems, appliedPromo);
    }
  },

  addItem: (newItem) => {
    if (!Number.isSafeInteger(newItem.quantity) || newItem.quantity <= 0) return false;
    const productId = newItem.productId ?? newItem.id;
    resetCheckoutTimer();
    const updatedItems = mergeCartItems(get().items, [newItem]).map((item) =>
      productId && (item.productId ?? item.id) === productId
        ? { ...item, stock: newItem.stock ?? item.stock }
        : item);

    const appliedPromo = promoForItems(get().appliedPromo, updatedItems);
    set({ items: updatedItems, appliedPromo });
    saveToStorage(get().currentUserId, updatedItems, appliedPromo);
    return true;
  },

  removeItem: (index) => {
    if (!get().items[index]) return;
    resetCheckoutTimer();
    const updatedItems = get().items.filter((_, i) => i !== index);
    const appliedPromo = promoForItems(get().appliedPromo, updatedItems);
    set({ items: updatedItems, appliedPromo });
    saveToStorage(get().currentUserId, updatedItems, appliedPromo);
  },

  updateQuantity: (index, quantity) => {
    if (!get().items[index] || !Number.isSafeInteger(quantity)) return;
    if (quantity <= 0) {
      get().removeItem(index);
      return;
    }
    resetCheckoutTimer();
    const updatedItems = get().items.map((item, i) => i === index
      ? { ...item, quantity, lineTotal: getCartLineTotal({ ...item, quantity }) }
      : item);
    const appliedPromo = promoForItems(get().appliedPromo, updatedItems);
    set({ items: updatedItems, appliedPromo });
    saveToStorage(get().currentUserId, updatedItems, appliedPromo);
  },

  clearCart: () => {
    resetCheckoutTimer();
    if (typeof window !== 'undefined') localStorage.removeItem('brewlite_checkout_renew_count');
    set({ items: [], appliedPromo: null });
    if (typeof window !== 'undefined') {
      const key = getCartKey(get().currentUserId);
      localStorage.removeItem(key);
      localStorage.removeItem(getPromoKey(get().currentUserId));
    }
  },

  totalPrice: () => {
    return get().items.reduce((total, item) => total + getCartLineTotal(item), 0);
  },

  totalItems: () => {
    return get().items.reduce((total, item) => total + item.quantity, 0);
  },

  applyPromo: (promo) => {
    const appliedPromo = promoForItems(promo, get().items);
    set({ appliedPromo });
    saveToStorage(get().currentUserId, get().items, appliedPromo);
  },
  removePromo: () => {
    set({ appliedPromo: null });
    saveToStorage(get().currentUserId, get().items, null);
  },
  setProductStocks: (stocks) => {
    const items = get().items.map((item) => {
      const productId = item.productId ?? item.id;
      return productId && Object.hasOwn(stocks, productId)
        ? { ...item, stock: stocks[productId] }
        : item;
    });
    if (items.some((item, index) => item.stock !== get().items[index].stock)) {
      set({ items });
      saveToStorage(get().currentUserId, items, get().appliedPromo);
    }
  },
}));

export const useHasCartHydrated = () => true;
