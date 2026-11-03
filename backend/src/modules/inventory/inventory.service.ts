import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InventoryState, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateOrderItemDto } from '../orders/dto/create-order.dto.js';

type Database = PrismaService | Prisma.TransactionClient;
type SnapshotEntry = { ingredientId: string; quantity: string };
type OrderWithSnapshots = {
  id: string;
  inventoryState: InventoryState;
  items: { recipeSnapshot: Prisma.JsonValue | null }[];
};

export const RESERVATION_DURATION_MS = 2 * 60 * 1000;

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async prepareCart(items: CreateOrderItemDto[], db: Database = this.prisma) {
    if (!items?.length) throw new BadRequestException('Giỏ hàng không được rỗng');

    const productIds = [...new Set(items.map((item) => item.productId))];
    const toppingNames = [...new Set(items.flatMap((item) => item.toppings ?? []))];
    const [products, toppings] = await Promise.all([
      db.product.findMany({
        where: { id: { in: productIds }, isAvailable: true },
        include: { prices: true },
      }),
      db.topping.findMany({
        where: { name: { in: toppingNames }, isAvailable: true },
      }),
    ]);
    if (products.length !== productIds.length) {
      throw new BadRequestException('Một số sản phẩm không tồn tại hoặc đã ngừng kinh doanh');
    }
    const productById = new Map(products.map((product) => [product.id, product]));
    const toppingByName = new Map(toppings.map((topping) => [topping.name, topping]));
    for (const name of toppingNames) {
      if (!toppingByName.has(name)) {
        throw new BadRequestException(`Topping "${name}" không tồn tại hoặc đã ngừng bán`);
      }
    }

    const recipes = await db.recipe.findMany({
      where: {
        OR: [
          { productId: { in: productIds } },
          { toppingId: { in: toppings.map((topping) => topping.id) } },
        ],
      },
      include: { ingredient: true },
    });
    const productRecipes = new Map<string, typeof recipes>();
    const toppingRecipes = new Map<string, typeof recipes>();
    for (const recipe of recipes) {
      if (recipe.productId) {
        const key = `${recipe.productId}:${recipe.size}`;
        productRecipes.set(key, [...(productRecipes.get(key) ?? []), recipe]);
      } else if (recipe.toppingId) {
        toppingRecipes.set(recipe.toppingId, [...(toppingRecipes.get(recipe.toppingId) ?? []), recipe]);
      }
    }

    const required = new Map<string, Prisma.Decimal>();
    const ingredientById = new Map(recipes.map((recipe) => [recipe.ingredientId, recipe.ingredient]));
    let subtotal = 0;
    const orderItems = items.map((item) => {
      if (!Number.isSafeInteger(item.qty) || item.qty < 1) {
        throw new BadRequestException('Số lượng món phải là số nguyên dương');
      }
      const product = productById.get(item.productId)!;
      const price = product.prices.find((entry) => entry.size === item.size);
      if (!price) throw new BadRequestException(`Sản phẩm "${product.name}" không có size ${item.size}`);
      const baseRecipes = productRecipes.get(`${product.id}:${item.size}`);
      if (!baseRecipes?.length) throw new BadRequestException(`Chưa có công thức cho "${product.name}" size ${item.size}`);
      if (item.toppings?.length && !product.allowToppings) {
        throw new BadRequestException(`Sản phẩm "${product.name}" không cho phép topping`);
      }

      const lineIngredients = new Map<string, Prisma.Decimal>();
      const addRecipes = (entries: typeof recipes) => {
        for (const entry of entries) {
          if (!entry.ingredient.isActive) {
            throw new BadRequestException(`Nguyên liệu "${entry.ingredient.name}" đang ngừng sử dụng`);
          }
          const quantity = entry.quantity.mul(item.qty);
          lineIngredients.set(entry.ingredientId, (lineIngredients.get(entry.ingredientId) ?? new Prisma.Decimal(0)).add(quantity));
          required.set(entry.ingredientId, (required.get(entry.ingredientId) ?? new Prisma.Decimal(0)).add(quantity));
        }
      };
      addRecipes(baseRecipes);
      let toppingPrice = 0;
      for (const name of item.toppings ?? []) {
        const topping = toppingByName.get(name)!;
        const entries = toppingRecipes.get(topping.id);
        if (!entries?.length) throw new BadRequestException(`Chưa có công thức cho topping "${name}"`);
        addRecipes(entries);
        toppingPrice += topping.price;
      }
      const lineTotal = (price.price + toppingPrice) * item.qty;
      if (!Number.isSafeInteger(lineTotal) || lineTotal < 0) throw new BadRequestException('Giá trị giỏ hàng không hợp lệ');
      subtotal += lineTotal;
      // Lưu định lượng tại thời điểm đặt để việc sửa công thức sau này không đổi đơn cũ.
      const recipeSnapshot: SnapshotEntry[] = [...lineIngredients.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([ingredientId, quantity]) => ({ ingredientId, quantity: quantity.toFixed(3) }));
      return {
        productId: item.productId,
        productName: product.name,
        productImageUrl: product.imageUrl,
        size: item.size,
        toppings: item.toppings ?? [],
        qty: item.qty,
        lineTotal,
        recipeSnapshot,
      };
    });
    if (!Number.isSafeInteger(subtotal)) throw new BadRequestException('Giá trị giỏ hàng không hợp lệ');

    const shortages = [...required.entries()].flatMap(([ingredientId, quantity]) => {
      const ingredient = ingredientById.get(ingredientId)!;
      if (!ingredient.trackStock) return [];
      const available = (ingredient.onHand ?? new Prisma.Decimal(0)).sub(ingredient.reserved ?? new Prisma.Decimal(0));
      return available.gte(quantity) ? [] : [{
        ingredientId,
        ingredientName: ingredient.name,
        required: quantity.toFixed(3),
        available: Prisma.Decimal.max(available, 0).toFixed(3),
        unit: ingredient.unit,
      }];
    });

    return { subtotal, orderItems, required, ingredientById, shortages };
  }

  async validateCart(items: CreateOrderItemDto[]) {
    const result = await this.prepareCart(items);
    return { available: result.shortages.length === 0, shortages: result.shortages, subtotal: result.subtotal };
  }

  async reserve(db: Prisma.TransactionClient, cart: Awaited<ReturnType<InventoryService['prepareCart']>>) {
    for (const [ingredientId, quantity] of [...cart.required.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!cart.ingredientById.get(ingredientId)?.trackStock) continue;
      const count = await db.$executeRaw`
        UPDATE "ingredients"
        SET "reserved" = "reserved" + ${quantity}, "version" = "version" + 1,
            "updatedAt" = NOW()
        WHERE "id" = ${ingredientId} AND "isActive" = true AND "trackStock" = true
          AND "onHand" - "reserved" >= ${quantity}
      `;
      if (count !== 1) {
        const ingredient = cart.ingredientById.get(ingredientId)!;
        throw new ConflictException(`Không đủ nguyên liệu "${ingredient.name}" để đặt số lượng này`);
      }
    }
  }

  private requirementsFromSnapshots(order: OrderWithSnapshots) {
    const quantities = new Map<string, Prisma.Decimal>();
    for (const item of order.items) {
      if (!Array.isArray(item.recipeSnapshot)) throw new ConflictException('Đơn hàng thiếu bản chụp công thức');
      for (const raw of item.recipeSnapshot) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
            typeof raw.ingredientId !== 'string' || typeof raw.quantity !== 'string') {
          throw new ConflictException('Bản chụp công thức không hợp lệ');
        }
        const quantity = new Prisma.Decimal(raw.quantity);
        if (!quantity.isFinite() || quantity.lte(0)) throw new ConflictException('Lượng nguyên liệu không hợp lệ');
        quantities.set(raw.ingredientId, (quantities.get(raw.ingredientId) ?? new Prisma.Decimal(0)).add(quantity));
      }
    }
    return [...quantities.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  async consume(db: Prisma.TransactionClient, order: OrderWithSnapshots) {
    if (order.inventoryState !== InventoryState.RESERVED) throw new ConflictException('Đơn hàng không còn nguyên liệu đã giữ');
    for (const [id, quantity] of this.requirementsFromSnapshots(order)) {
      const result = await db.ingredient.updateMany({
        where: { id, trackStock: true, reserved: { gte: quantity }, onHand: { gte: quantity } },
        data: { reserved: { decrement: quantity }, onHand: { decrement: quantity }, version: { increment: 1 } },
      });
      if (result.count === 0) {
        const untracked = await db.ingredient.findFirst({ where: { id, trackStock: false }, select: { id: true } });
        if (!untracked) throw new ConflictException('Tồn kho nguyên liệu vừa thay đổi, không thể thanh toán');
      }
    }
    await db.order.update({ where: { id: order.id }, data: { inventoryState: InventoryState.CONSUMED } });
  }

  async release(db: Prisma.TransactionClient, order: OrderWithSnapshots) {
    if (order.inventoryState !== InventoryState.RESERVED) return;
    for (const [id, quantity] of this.requirementsFromSnapshots(order)) {
      const result = await db.ingredient.updateMany({
        where: { id, trackStock: true, reserved: { gte: quantity } },
        data: { reserved: { decrement: quantity }, version: { increment: 1 } },
      });
      if (result.count === 0) {
        const untracked = await db.ingredient.findFirst({ where: { id, trackStock: false }, select: { id: true } });
        if (!untracked) throw new ConflictException('Không thể trả nguyên liệu đã giữ');
      }
    }
    await db.order.update({ where: { id: order.id }, data: { inventoryState: InventoryState.RELEASED } });
  }

  async restore(db: Prisma.TransactionClient, order: OrderWithSnapshots) {
    if (order.inventoryState !== InventoryState.CONSUMED) return;
    for (const [id, quantity] of this.requirementsFromSnapshots(order)) {
      const result = await db.ingredient.updateMany({
        where: { id, trackStock: true },
        data: { onHand: { increment: quantity }, version: { increment: 1 } },
      });
      if (result.count === 0) {
        const untracked = await db.ingredient.findFirst({ where: { id, trackStock: false }, select: { id: true } });
        if (!untracked) throw new ConflictException('Không thể hoàn nguyên liệu của đơn hàng');
      }
    }
    await db.order.update({ where: { id: order.id }, data: { inventoryState: InventoryState.RESTORED } });
  }
}
