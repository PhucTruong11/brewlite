export interface CartTopping {
  id?: string;
  name: string;
  price?: number;
  quantity?: number;
}

export interface CartItem {
  id?: string;
  productId?: string;
  name: string;
  size: string;
  quantity: number;
  stock?: number;
  unitPrice: number;
  basePrice?: number;
  totalToppingPrice?: number;
  imageUrl?: string | null;
  toppings?: (string | CartTopping)[];
  lineTotal?: number;
}

// Tên topping là duy nhất trong DB. Giỏ cũ dùng chuỗi, giỏ mới dùng object.
function getToppingCounts(toppings: CartItem['toppings']) {
  const counts = new Map<string, number>();

  for (const topping of toppings ?? []) {
    const name = typeof topping === 'string' ? topping : topping.name;
    const quantity = typeof topping === 'string' ? 1 : (topping.quantity ?? 1);
    if (!name || !Number.isSafeInteger(quantity) || quantity <= 0) continue;
    counts.set(name, (counts.get(name) ?? 0) + quantity);
  }

  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function getCartItemKey(item: CartItem): string {
  return JSON.stringify([
    item.productId || item.id || item.name,
    item.size,
    getToppingCounts(item.toppings),
  ]);
}

export function getCartLineTotal(item: CartItem): number {
  return Number.isFinite(item.unitPrice)
    ? item.unitPrice * item.quantity
    : (item.lineTotal ?? 0);
}

export function formatCartToppings(toppings: CartItem['toppings']): string {
  return getToppingCounts(toppings)
    .map(([name, quantity]) => quantity > 1 ? `${name} x${quantity}` : name)
    .join(', ');
}

export function toOrderItem(item: CartItem) {
  return {
    productId: item.productId || item.id,
    size: item.size,
    qty: item.quantity,
    toppings: getToppingCounts(item.toppings).flatMap(([name, quantity]) =>
      Array<string>(quantity).fill(name),
    ),
    lineTotal: getCartLineTotal(item),
  };
}
