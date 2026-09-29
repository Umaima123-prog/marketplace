/**
 * The cart reducer.
 *
 * Two things are being protected here. The obvious one is that add/update/remove
 * behave the way a shopper expects. The important one is that a cart can hold
 * NOTHING but variant ids and quantities -- if a price could survive a round trip
 * through localStorage, the browser would have a say in what things cost.
 */
import { describe, expect, it } from "vitest";

import {
  addLine,
  cartCount,
  clearCart,
  EMPTY_CART,
  MAX_CART_LINES,
  MAX_LINE_QUANTITY,
  parseCart,
  removeLine,
  serializeCart,
  setQuantity,
} from "@/src/lib/cart/cart-state";

describe("addLine", () => {
  it("adds a variant with a default quantity of one", () => {
    expect(addLine(EMPTY_CART, "v1")).toEqual({ lines: [{ variantId: "v1", quantity: 1 }] });
  });

  it("merges a repeat add into the existing line rather than duplicating it", () => {
    // Two lines for one variant would break the unique (orderId, shopifyVariantId)
    // constraint on OrderItem at checkout, so merging is a correctness rule and
    // not a nicety.
    const cart = addLine(addLine(EMPTY_CART, "v1", 2), "v1", 3);
    expect(cart.lines).toEqual([{ variantId: "v1", quantity: 5 }]);
  });

  it("keeps distinct variants as distinct lines, in the order added", () => {
    const cart = addLine(addLine(EMPTY_CART, "v1"), "v2");
    expect(cart.lines.map((line) => line.variantId)).toEqual(["v1", "v2"]);
  });

  it("clamps a merge to the per-line maximum instead of overflowing", () => {
    const cart = addLine(addLine(EMPTY_CART, "v1", 90), "v1", 90);
    expect(cart.lines[0].quantity).toBe(MAX_LINE_QUANTITY);
  });

  it("ignores an empty variant id", () => {
    expect(addLine(EMPTY_CART, "")).toEqual(EMPTY_CART);
  });

  it("refuses to grow past the line limit", () => {
    let cart = EMPTY_CART;
    for (let index = 0; index < MAX_CART_LINES + 5; index += 1) {
      cart = addLine(cart, `v${index}`);
    }
    expect(cart.lines).toHaveLength(MAX_CART_LINES);
  });

  it("does not mutate the cart it was given", () => {
    const before = addLine(EMPTY_CART, "v1");
    addLine(before, "v2");
    expect(before.lines).toHaveLength(1);
  });
});

describe("setQuantity", () => {
  it("replaces the quantity rather than adding to it", () => {
    const cart = setQuantity(addLine(EMPTY_CART, "v1", 2), "v1", 7);
    expect(cart.lines[0].quantity).toBe(7);
  });

  it("removes the line when the quantity drops below one", () => {
    // What a shopper means by typing 0 is "take it out", so that is what happens.
    for (const quantity of [0, -1, -99]) {
      expect(setQuantity(addLine(EMPTY_CART, "v1", 3), "v1", quantity).lines).toEqual([]);
    }
  });

  it("clamps above the maximum and truncates a fractional quantity", () => {
    expect(setQuantity(addLine(EMPTY_CART, "v1"), "v1", 1000).lines[0].quantity).toBe(
      MAX_LINE_QUANTITY,
    );
    expect(setQuantity(addLine(EMPTY_CART, "v1"), "v1", 2.9).lines[0].quantity).toBe(2);
  });

  it("leaves other lines untouched", () => {
    const cart = setQuantity(addLine(addLine(EMPTY_CART, "v1", 1), "v2", 4), "v1", 9);
    expect(cart.lines).toEqual([
      { variantId: "v1", quantity: 9 },
      { variantId: "v2", quantity: 4 },
    ]);
  });

  it("is a no-op for a variant that is not in the cart", () => {
    const cart = addLine(EMPTY_CART, "v1");
    expect(setQuantity(cart, "absent", 5).lines).toEqual(cart.lines);
  });
});

describe("removeLine", () => {
  it("removes only the named variant", () => {
    const cart = removeLine(addLine(addLine(EMPTY_CART, "v1"), "v2"), "v1");
    expect(cart.lines).toEqual([{ variantId: "v2", quantity: 1 }]);
  });

  it("is a no-op for an absent variant", () => {
    expect(removeLine(addLine(EMPTY_CART, "v1"), "nope").lines).toHaveLength(1);
  });
});

describe("clearCart", () => {
  it("empties the cart", () => {
    expect(clearCart().lines).toEqual([]);
  });
});

describe("cartCount", () => {
  it("counts items, not lines -- that is what a navbar badge means", () => {
    const cart = addLine(addLine(EMPTY_CART, "v1", 3), "v2", 2);
    expect(cartCount(cart)).toBe(5);
  });

  it("is zero for an empty cart", () => {
    expect(cartCount(EMPTY_CART)).toBe(0);
  });
});

describe("serializeCart", () => {
  it("writes only variantId and quantity", () => {
    // The guarantee the whole design rests on: a price cannot be persisted, so a
    // tampered localStorage has no price to tamper with.
    const cart = { lines: [{ variantId: "v1", quantity: 2, price: "0.01" }] } as never;
    expect(JSON.parse(serializeCart(cart))).toEqual({
      lines: [{ variantId: "v1", quantity: 2 }],
    });
  });

  it("round-trips through parseCart", () => {
    const cart = addLine(addLine(EMPTY_CART, "v1", 3), "v2", 1);
    expect(parseCart(serializeCart(cart))).toEqual(cart);
  });
});

describe("parseCart", () => {
  it("treats missing or empty storage as an empty cart", () => {
    expect(parseCart(null)).toEqual(EMPTY_CART);
    expect(parseCart("")).toEqual(EMPTY_CART);
  });

  it("survives every shape of hostile or stale input", () => {
    // localStorage is user-editable, may hold a previous version's format, and may
    // be truncated. None of that may throw on first paint.
    for (const raw of [
      "not json",
      "{",
      "null",
      "[]",
      '"string"',
      "42",
      "{}",
      '{"lines":null}',
      '{"lines":{}}',
      '{"lines":"nope"}',
      '{"lines":[null]}',
      '{"lines":[1,2,3]}',
      '{"lines":[{"quantity":2}]}',
      '{"lines":[{"variantId":"v1"}]}',
      '{"lines":[{"variantId":123,"quantity":1}]}',
      '{"lines":[{"variantId":"v1","quantity":"2"}]}',
    ]) {
      expect(() => parseCart(raw)).not.toThrow();
      expect(parseCart(raw).lines.every((line) => typeof line.variantId === "string")).toBe(true);
    }
  });

  it("drops an unusable line but keeps the usable ones", () => {
    const cart = parseCart(
      '{"lines":[{"variantId":"v1","quantity":2},{"variantId":"","quantity":1},{"variantId":"v2","quantity":1}]}',
    );
    expect(cart.lines).toEqual([
      { variantId: "v1", quantity: 2 },
      { variantId: "v2", quantity: 1 },
    ]);
  });

  it("ignores any extra field that was stored alongside the two it trusts", () => {
    // The attack this blocks: edit localStorage to add a price, hope something
    // downstream reads it.
    const cart = parseCart(
      '{"lines":[{"variantId":"v1","quantity":1,"price":"0.01","unitPrice":1}],"subtotal":"0.01"}',
    );
    expect(cart.lines).toEqual([{ variantId: "v1", quantity: 1 }]);
    expect(Object.keys(cart.lines[0])).toEqual(["variantId", "quantity"]);
    expect(cart).not.toHaveProperty("subtotal");
  });

  it("clamps a stored quantity into range", () => {
    expect(parseCart('{"lines":[{"variantId":"v1","quantity":100000}]}').lines[0].quantity).toBe(
      MAX_LINE_QUANTITY,
    );
    expect(parseCart('{"lines":[{"variantId":"v1","quantity":-5}]}').lines[0].quantity).toBe(1);
    expect(parseCart('{"lines":[{"variantId":"v1","quantity":2.7}]}').lines[0].quantity).toBe(2);
  });

  it("keeps the first of two stored lines for the same variant", () => {
    const cart = parseCart(
      '{"lines":[{"variantId":"v1","quantity":2},{"variantId":"v1","quantity":9}]}',
    );
    expect(cart.lines).toEqual([{ variantId: "v1", quantity: 2 }]);
  });

  it("truncates a cart stored with more lines than allowed", () => {
    const lines = Array.from({ length: MAX_CART_LINES + 10 }, (_, index) => ({
      variantId: `v${index}`,
      quantity: 1,
    }));
    expect(parseCart(JSON.stringify({ lines })).lines).toHaveLength(MAX_CART_LINES);
  });

  it("rejects an absurdly long variant id", () => {
    const raw = JSON.stringify({ lines: [{ variantId: "x".repeat(200), quantity: 1 }] });
    expect(parseCart(raw).lines).toEqual([]);
  });
});
