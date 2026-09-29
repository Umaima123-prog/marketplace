import "server-only";

/**
 * Cart hydration: variant ids in, current catalog data out.
 *
 * The browser sends `{ variantId, quantity }` and nothing else. Every field a
 * shopper sees -- title, image, price, availability -- is read here from MySQL,
 * so a tampered localStorage can change WHICH products are in a cart but never
 * what they cost or whether they can be bought.
 *
 * The same re-read happens again at checkout (`checkout.service.ts`). This one
 * is for display; that one is authoritative. They are separate on purpose: a
 * cart page is a read, and a checkout is a decision.
 */
import { Prisma } from "@/src/generated/prisma";
import { prisma } from "@/src/lib/prisma";
import { normalizeMoney } from "@/src/lib/money";
import { MAX_CART_LINES, type CartLine } from "@/src/lib/cart/cart-state";
import {
  EMPTY_HYDRATED_CART,
  evaluateLine,
  type HydratedCart,
  type HydratedCartLine,
} from "@/src/lib/cart/cart-view";

// The wire shapes live in src/lib/cart/cart-view.ts, which is not server-only:
// the cart page and the checkout form need them, and a client component that
// imported this file would fail the build. Re-exported so server callers have
// one import.
export {
  EMPTY_HYDRATED_CART,
  describeProblem,
  evaluateLine,
  type HydratedCart,
  type HydratedCartLine,
  type LineProblem,
} from "@/src/lib/cart/cart-view";

/**
 * One query for every variant in the cart, not one per line.
 *
 * `findMany({ where: { id: { in: ids } } })` with the product joined is a single
 * round trip whatever the cart size.
 */
export const CART_VARIANT_SELECT = {
  id: true,
  title: true,
  sku: true,
  price: true,
  currencyCode: true,
  inventoryQuantity: true,
  inventoryTracked: true,
  inventoryPolicy: true,
  isActive: true,
  product: {
    select: {
      title: true,
      handle: true,
      isActive: true,
      status: true,
      images: { select: { url: true }, orderBy: { position: "asc" }, take: 1 },
    },
  },
} satisfies Prisma.ProductVariantSelect;

export type CartVariantRow = Prisma.ProductVariantGetPayload<{ select: typeof CART_VARIANT_SELECT }>;

export async function hydrateCart(requested: CartLine[]): Promise<HydratedCart> {
  const lines = requested.slice(0, MAX_CART_LINES).filter((line) => typeof line.variantId === "string");
  if (lines.length === 0) return EMPTY_HYDRATED_CART;

  const variants = await prisma.productVariant.findMany({
    where: { id: { in: lines.map((line) => line.variantId) } },
    select: CART_VARIANT_SELECT,
  });

  const byId = new Map(variants.map((variant) => [variant.id, variant]));

  // Decimal, not number: a cart of three lines at 699.95 must not drift.
  let subtotal = new Prisma.Decimal(0);
  let itemCount = 0;

  const hydrated: HydratedCartLine[] = lines.map((line) => {
    const variant = byId.get(line.variantId);
    const problem = evaluateLine(variant, line.quantity);

    if (!variant) {
      return {
        variantId: line.variantId,
        quantity: line.quantity,
        productTitle: "Unavailable item",
        productHandle: "",
        variantTitle: "",
        sku: null,
        imageUrl: null,
        unitPrice: "0.00",
        lineTotal: "0.00",
        currencyCode: EMPTY_HYDRATED_CART.currencyCode,
        available: false,
        problem,
        inventoryQuantity: null,
      };
    }

    const lineTotal = variant.price.mul(line.quantity);

    // Only orderable lines count toward the subtotal: a total that includes an
    // out-of-stock line is a number the customer will never be charged.
    if (problem === null) {
      subtotal = subtotal.add(lineTotal);
      itemCount += line.quantity;
    }

    return {
      variantId: variant.id,
      quantity: line.quantity,
      productTitle: variant.product.title,
      productHandle: variant.product.handle,
      variantTitle: variant.title,
      sku: variant.sku,
      imageUrl: variant.product.images[0]?.url ?? null,
      unitPrice: normalizeMoney(variant.price.toString()),
      lineTotal: normalizeMoney(lineTotal.toString()),
      currencyCode: variant.currencyCode,
      available: problem === null,
      problem,
      inventoryQuantity: variant.inventoryTracked ? variant.inventoryQuantity : null,
    };
  });

  return {
    lines: hydrated,
    subtotal: normalizeMoney(subtotal.toString()),
    currencyCode: hydrated.find((line) => line.available)?.currencyCode ?? EMPTY_HYDRATED_CART.currencyCode,
    itemCount,
    checkoutable: hydrated.length > 0 && hydrated.every((line) => line.problem === null),
  };
}
