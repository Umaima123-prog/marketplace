/**
 * The shapes that cross the network between the server and the cart UI.
 *
 * Separate from `src/server/cart/cart.service.ts` because that module is
 * `server-only`: a client component importing it would fail the build, and the
 * cart page and checkout form both need these types. Keeping them here means the
 * wire contract is stated in one place that both sides may read, and no Prisma
 * type ever appears in a browser bundle.
 *
 * Every money field is an exact decimal STRING. A JSON number would be a float,
 * and the price a courier collects in cash must survive the round trip digit for
 * digit.
 */
import { MAX_LINE_QUANTITY } from "@/src/lib/cart/cart-state";
import type { MoneyString } from "@/src/lib/money";

/** Why a requested line cannot be ordered. Null means it can. */
export type LineProblem =
  | "variant_not_found"
  | "variant_inactive"
  | "product_unavailable"
  | "out_of_stock"
  | "insufficient_stock"
  | "invalid_quantity";

export interface HydratedCartLine {
  variantId: string;
  quantity: number;
  productTitle: string;
  productHandle: string;
  variantTitle: string;
  sku: string | null;
  imageUrl: string | null;
  /** Current price from MySQL, never from the browser. */
  unitPrice: MoneyString;
  lineTotal: MoneyString;
  currencyCode: string;
  available: boolean;
  problem: LineProblem | null;
  /** Shown only for variants whose inventory Shopify tracks. */
  inventoryQuantity: number | null;
}

export interface HydratedCart {
  lines: HydratedCartLine[];
  /** Server-computed, from the prices above. The client never sums money. */
  subtotal: MoneyString;
  currencyCode: string;
  itemCount: number;
  /** True only when every line is orderable. Checkout is blocked otherwise. */
  checkoutable: boolean;
}

export const EMPTY_HYDRATED_CART: HydratedCart = {
  lines: [],
  subtotal: "0.00",
  currencyCode: "USD",
  itemCount: 0,
  checkoutable: false,
};

/** Human-readable reason, shown next to the offending cart line. */
export function describeProblem(problem: LineProblem): string {
  switch (problem) {
    case "variant_not_found":
      return "This item is no longer available.";
    case "variant_inactive":
      return "This option is no longer sold.";
    case "product_unavailable":
      return "This product is no longer available.";
    case "out_of_stock":
      return "Out of stock.";
    case "insufficient_stock":
      return "Not enough stock for the requested quantity.";
    case "invalid_quantity":
      return "Invalid quantity.";
  }
}

/**
 * The minimum a variant row must look like for the rule below to judge it.
 *
 * Structural rather than a Prisma type, so the rule lives here -- in a module
 * with no database dependency -- and can be tested directly. The Prisma row
 * selected by `CART_VARIANT_SELECT` satisfies it.
 */
export interface PurchasableVariant {
  isActive: boolean;
  inventoryQuantity: number;
  inventoryTracked: boolean;
  inventoryPolicy: "DENY" | "CONTINUE";
  product: { isActive: boolean; status: string };
}

/**
 * Decides whether one requested line can be ordered, and why not.
 *
 * The single implementation of "can this be bought", used by the cart page for
 * display AND by the checkout for the decision. Two implementations would
 * eventually disagree, and the one the customer saw would be the wrong one.
 *
 * `undefined` means the id is not in the catalog at all -- a deleted variant, or
 * one a tampered localStorage invented.
 */
export function evaluateLine(
  variant: PurchasableVariant | undefined,
  quantity: number,
): LineProblem | null {
  if (!variant) return "variant_not_found";
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
    return "invalid_quantity";
  }
  if (!variant.isActive) return "variant_inactive";
  if (!variant.product.isActive || variant.product.status !== "ACTIVE") return "product_unavailable";

  // Untracked or oversell-allowed variants are always orderable; that is
  // Shopify's rule, mirrored here.
  if (!variant.inventoryTracked) return null;
  if (variant.inventoryPolicy === "CONTINUE") return null;

  if (variant.inventoryQuantity <= 0) return "out_of_stock";
  if (variant.inventoryQuantity < quantity) return "insufficient_stock";
  return null;
}
