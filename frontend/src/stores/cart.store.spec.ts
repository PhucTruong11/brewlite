import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCartStore } from './cart.store';
import type { CartItem } from '../lib/cart';
import type { AppliedPromo } from '../lib/voucher';
import { getCheckoutSignature } from '../lib/cart';

const drink: CartItem = {
  productId: 'drink-1', name: 'Trà sữa', size: 'M', quantity: 1,
  unitPrice: 30000, stock: 5,
};

const voucher: AppliedPromo = {
  code: 'GIAM10K', description: 'Giảm 10.000đ', discount: 10000,
  rules: { discountType: 'FIXED_AMOUNT', discountValue: 10000, minOrderValue: 50000 },
};

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
  };
}

describe('cart store', () => {
  let storage: ReturnType<typeof createStorage>;

  beforeEach(() => {
    storage = createStorage();
    vi.stubGlobal('window', { localStorage: storage });
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', createStorage());
    useCartStore.setState({ items: [], currentUserId: null, appliedPromo: null, replacementSourceId: null, pendingCheckout: null, hasHydrated: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gộp cùng sản phẩm, size và topping; tách dòng khi topping hoặc size khác', () => {
    const cart = useCartStore.getState();
    expect(cart.addItem({ ...drink, toppings: ['Trân châu', 'Thạch'] })).toBe(true);
    expect(cart.addItem({ ...drink, toppings: ['Thạch', 'Trân châu'] })).toBe(true);
    expect(cart.addItem({ ...drink, toppings: ['Trân châu'] })).toBe(true);
    expect(cart.addItem({ ...drink, size: 'L', unitPrice: 40000 })).toBe(true);

    expect(useCartStore.getState().items.map((item) => item.quantity)).toEqual([2, 1, 1]);
    expect(useCartStore.getState().totalItems()).toBe(4);
    expect(useCartStore.getState().totalPrice()).toBe(130000);
  });

  it('không dùng Product.stock cũ để chặn các dòng size/topping; UI kiểm tra công thức qua API', () => {
    const cart = useCartStore.getState();
    expect(cart.addItem({ ...drink, quantity: 3 })).toBe(true);
    expect(cart.addItem({ ...drink, size: 'L', quantity: 2 })).toBe(true);
    expect(cart.addItem({ ...drink, toppings: ['Trân châu'] })).toBe(true);
    cart.updateQuantity(1, 3);

    expect(useCartStore.getState().items.map((item) => item.quantity)).toEqual([3, 3, 1]);
    cart.updateQuantity(0, 2);
    expect(useCartStore.getState().items.map((item) => item.quantity)).toEqual([2, 3, 1]);
  });

  it('giữ voucher sau khi xóa một trong ba dòng nếu vẫn đủ điều kiện, rồi bỏ khi không đủ', () => {
    const cart = useCartStore.getState();
    cart.addItem(drink);
    cart.addItem({ ...drink, size: 'L' });
    cart.addItem({ ...drink, toppings: ['Trân châu'] });
    cart.applyPromo(voucher);

    cart.removeItem(0);
    expect(useCartStore.getState().appliedPromo?.discount).toBe(10000);
    expect(JSON.parse(storage.getItem('brewlite_cart_guest_promo')!)).toMatchObject({ code: 'GIAM10K' });

    cart.removeItem(0);
    expect(useCartStore.getState().appliedPromo).toBeNull();
    expect(storage.getItem('brewlite_cart_guest_promo')).toBeNull();
  });

  it('khôi phục món và voucher đã chọn từ localStorage khi khởi tạo lại giỏ', () => {
    const cart = useCartStore.getState();
    cart.addItem({ ...drink, quantity: 2 });
    cart.applyPromo(voucher);
    useCartStore.setState({ items: [], appliedPromo: null });

    useCartStore.getState().initUserCart(null);
    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().totalPrice()).toBe(60000);
    expect(useCartStore.getState().appliedPromo).toMatchObject({ code: 'GIAM10K', discount: 10000 });
  });

  it('giữ lượt gia hạn khi sửa giỏ và xóa lượt khi thanh toán xong', () => {
    const cart = useCartStore.getState();
    cart.addItem(drink);
    storage.setItem('brewlite_checkout_renew_count', '1');

    cart.updateQuantity(0, 2);
    expect(storage.getItem('brewlite_checkout_renew_count')).toBe('1');

    cart.clearCart();
    expect(storage.getItem('brewlite_checkout_renew_count')).toBeNull();
  });

  it('chuyển món và voucher hợp lệ từ giỏ khách sang giỏ user lúc đăng nhập', () => {
    const cart = useCartStore.getState();
    cart.addItem({ ...drink, quantity: 2 });
    cart.applyPromo(voucher);
    storage.setItem('brewlite_cart_user_u1', JSON.stringify([{ ...drink, size: 'L' }]));

    cart.initUserCart('u1');
    expect(useCartStore.getState().currentUserId).toBe('u1');
    expect(useCartStore.getState().items).toHaveLength(2);
    expect(useCartStore.getState().appliedPromo?.code).toBe('GIAM10K');
    expect(storage.getItem('brewlite_cart_guest')).toBeNull();
    expect(storage.getItem('brewlite_cart_guest_promo')).toBeNull();
    expect(JSON.parse(storage.getItem('brewlite_cart_user_u1_promo')!)).toMatchObject({ code: 'GIAM10K' });
  });

  it('refresh giữ nguyên 12 ly, topping, voucher và đơn đang chờ theo đúng tài khoản', () => {
    const cart = useCartStore.getState();
    cart.initUserCart('u1');
    cart.addItem({ ...drink, quantity: 12, toppings: [{ name: 'Trân châu', quantity: 2 }] });
    cart.applyPromo(voucher);
    cart.rememberCheckout('order-1', getCheckoutSignature(useCartStore.getState().items, voucher.code));
    useCartStore.setState({ items: [], pendingCheckout: null, appliedPromo: null, hasHydrated: false });
    cart.initUserCart('u1');
    expect(useCartStore.getState().hasHydrated).toBe(true);
    expect(useCartStore.getState().items[0]).toMatchObject({ quantity: 12, toppings: [{ name: 'Trân châu', quantity: 2 }] });
    expect(useCartStore.getState().pendingCheckout?.orderId).toBe('order-1');
    expect(useCartStore.getState().appliedPromo?.code).toBe(voucher.code);
    cart.initUserCart('u2');
    expect(useCartStore.getState().pendingCheckout).toBeNull();
    expect(useCartStore.getState().items).toEqual([]);
  });

  it('hủy đơn chờ vẫn giữ số lượng và voucher; chỉ thanh toán đúng giỏ mới xóa', () => {
    const cart = useCartStore.getState();
    cart.initUserCart('u1');
    cart.addItem({ ...drink, quantity: 3 });
    cart.applyPromo(voucher);
    const signature = getCheckoutSignature(useCartStore.getState().items, voucher.code);
    cart.rememberCheckout('cancelled', signature);
    cart.forgetCheckout('cancelled');
    expect(useCartStore.getState().totalItems()).toBe(3);
    expect(useCartStore.getState().appliedPromo?.code).toBe(voucher.code);
    cart.rememberCheckout('paid', signature);
    cart.completeCheckout('paid');
    expect(useCartStore.getState().items).toEqual([]);
    cart.addItem(drink);
    cart.completeCheckout('paid');
    expect(useCartStore.getState().totalItems()).toBe(1);
  });

  it('mở lại đơn cũ hoặc thanh toán từ tab khác không xóa nhầm giỏ đã thay đổi', () => {
    const cart = useCartStore.getState();
    cart.initUserCart('u1');
    cart.addItem(drink);
    cart.rememberCheckout('order-1', getCheckoutSignature(useCartStore.getState().items));
    cart.updateQuantity(0, 4);
    cart.completeCheckout('another-order');
    expect(useCartStore.getState().pendingCheckout?.orderId).toBe('order-1');
    cart.completeCheckout('order-1');
    expect(useCartStore.getState().totalItems()).toBe(4);
    expect(useCartStore.getState().pendingCheckout).toBeNull();
  });

  it('giỏ đền bù tách riêng, hoàn tất đơn thường không xóa món thay thế đang chọn', () => {
    const cart = useCartStore.getState();
    cart.initUserCart('u1');
    cart.addItem(drink);
    cart.rememberCheckout('normal-order', getCheckoutSignature(useCartStore.getState().items));
    cart.selectReplacement('source-order');
    cart.addItem({ ...drink, quantity: 2 });
    cart.completeCheckout('normal-order');
    expect(useCartStore.getState().replacementSourceId).toBe('source-order');
    expect(useCartStore.getState().totalItems()).toBe(2);
    cart.initUserCart('u1');
    expect(useCartStore.getState().totalItems()).toBe(2);
  });
});
