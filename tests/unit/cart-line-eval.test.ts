/**
 * The purchasability rule.
 *
 * One function decides whether a line may be ordered, and both the cart page and
 * the checkout call it. These tests pin its answers, because a wrong `null` here
 * is an order for something that cannot be delivered and a wrong problem is a
 * sale refused.
 */
import { describe, expect, it } from "vitest";

import { MAX_LINE_QUANTITY } from "@/src/lib/cart/cart-state";
import { describeProblem, evaluateLine, type PurchasableVariant } from "@/src/lib/cart/cart-view";

function variant(overrides: Partial<PurchasableVariant> = {}): PurchasableVariant {
  return {
    isActive: true,
    inventoryQuantity: 10,
    inventoryTracked: true,
    inventoryPolicy: "DENY",
    product: { isActive: true, status: "ACTIVE" },
    ...overrides,
  };
}

describe("evaluateLine", () => {
  it("permits an active, in-stock variant", () => {
    expect(evaluateLine(variant(), 1)).toBeNull();
    expect(evaluateLine(variant({ inventoryQuantity: 10 }), 10)).toBeNull();
  });

  it("reports a variant that is not in the catalog", () => {
    // A tampered localStorage can name any id it likes; the answer is the same as
    // for a deleted variant.
    expect(evaluateLine(undefined, 1)).toBe("variant_not_found");
  });

  it("blocks an inactive variant", () => {
    expect(evaluateLine(variant({ isActive: false }), 1)).toBe("variant_inactive");
  });

  it("blocks a variant whose product is not sellable", () => {
    expect(evaluateLine(variant({ product: { isActive: false, status: "ACTIVE" } }), 1)).toBe(
      "product_unavailable",
    );
    for (const status of ["ARCHIVED", "DRAFT"]) {
      expect(evaluateLine(variant({ product: { isActive: true, status } }), 1)).toBe(
        "product_unavailable",
      );
    }
  });

  it("checks the variant before the product, so the more specific reason wins", () => {
    expect(
      evaluateLine(variant({ isActive: false, product: { isActive: false, status: "DRAFT" } }), 1),
    ).toBe("variant_inactive");
  });

  it("blocks a tracked variant with no stock", () => {
    expect(evaluateLine(variant({ inventoryQuantity: 0 }), 1)).toBe("out_of_stock");
    // Shopify can report negative inventory; it is still out of stock.
    expect(evaluateLine(variant({ inventoryQuantity: -3 }), 1)).toBe("out_of_stock");
  });

  it("blocks a quantity larger than the stock on hand", () => {
    expect(evaluateLine(variant({ inventoryQuantity: 2 }), 3)).toBe("insufficient_stock");
  });

  it("allows exactly the stock on hand", () => {
    // Off-by-one here either refuses the last unit or oversells it.
    expect(evaluateLine(variant({ inventoryQuantity: 3 }), 3)).toBeNull();
  });

  it("ignores stock for an untracked variant", () => {
    // The stored number is meaningless when Shopify is not tracking it.
    expect(evaluateLine(variant({ inventoryTracked: false, inventoryQuantity: 0 }), 5)).toBeNull();
  });

  it("allows overselling when the policy says continue", () => {
    expect(
      evaluateLine(variant({ inventoryPolicy: "CONTINUE", inventoryQuantity: 0 }), 5),
    ).toBeNull();
  });

  it("still blocks an inactive variant that allows overselling", () => {
    expect(
      evaluateLine(variant({ isActive: false, inventoryPolicy: "CONTINUE" }), 1),
    ).toBe("variant_inactive");
  });

  it("rejects a quantity that is not a whole number in range", () => {
    for (const quantity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_LINE_QUANTITY + 1]) {
      expect(evaluateLine(variant(), quantity)).toBe("invalid_quantity");
    }
  });

  it("allows the maximum quantity when the stock supports it", () => {
    expect(evaluateLine(variant({ inventoryQuantity: 1000 }), MAX_LINE_QUANTITY)).toBeNull();
  });
});

describe("describeProblem", () => {
  it("has a message for every problem", () => {
    const problems = [
      "variant_not_found",
      "variant_inactive",
      "product_unavailable",
      "out_of_stock",
      "insufficient_stock",
      "invalid_quantity",
    ] as const;

    for (const problem of problems) {
      expect(describeProblem(problem).length).toBeGreaterThan(0);
    }
  });
});
