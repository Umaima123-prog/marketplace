/**
 * The checkout request schema.
 *
 * The headline test is `rejects a browser-supplied price`: the schema is
 * `.strict()`, so a request carrying money fails loudly instead of having the
 * field silently stripped. Stripping would be safe today and a latent
 * vulnerability the first time someone adds a `price` field to the Order create
 * call and wires it to `input`.
 */
import { describe, expect, it } from "vitest";

import { checkoutSchema, formatIssues } from "@/src/server/checkout/checkout.schema";

const VALID = {
  idempotencyKey: "0d9f1c3e-8b7a-4e21-9f0a-2c5d7e8f1a2b",
  items: [{ variantId: "variant-1", quantity: 2 }],
  customerName: "Ayesha Khan",
  customerPhone: "+92 300 1234567",
  addressLine1: "12 Jinnah Road",
  city: "Lahore",
  countryCode: "PK",
};

describe("checkoutSchema: money is unrepresentable", () => {
  it("rejects a browser-supplied line price", () => {
    const result = checkoutSchema.safeParse({
      ...VALID,
      items: [{ variantId: "variant-1", quantity: 2, price: "0.01" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a browser-supplied subtotal, total or currency", () => {
    for (const extra of [
      { subtotal: "0.01" },
      { grandTotal: "0.01" },
      { total: 0.01 },
      { currencyCode: "USD" },
      { shippingTotal: "-100.00" },
    ]) {
      expect(checkoutSchema.safeParse({ ...VALID, ...extra }).success).toBe(false);
    }
  });

  it("has no money field to populate in the first place", () => {
    // The schema's own shape is the evidence: there is nothing named like money
    // for a client to target.
    const keys = Object.keys(checkoutSchema.shape);
    expect(keys).not.toContain("price");
    expect(keys.filter((key) => /price|total|subtotal|amount/i.test(key))).toEqual([]);
  });

  it("rejects an unknown field generally, not just money", () => {
    expect(checkoutSchema.safeParse({ ...VALID, paymentMethod: "CARD" }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...VALID, status: "SYNCED" }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...VALID, shopifyOrderId: "gid://x" }).success).toBe(false);
  });
});

describe("checkoutSchema: items", () => {
  it("accepts a minimal valid order", () => {
    const result = checkoutSchema.safeParse(VALID);
    expect(result.success).toBe(true);
  });

  it("rejects an empty cart", () => {
    expect(checkoutSchema.safeParse({ ...VALID, items: [] }).success).toBe(false);
  });

  it("rejects a non-integer, zero, negative or oversized quantity", () => {
    for (const quantity of [0, -1, 1.5, 100, 10_000]) {
      const result = checkoutSchema.safeParse({
        ...VALID,
        items: [{ variantId: "variant-1", quantity }],
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects a quantity sent as a string", () => {
    const result = checkoutSchema.safeParse({
      ...VALID,
      items: [{ variantId: "variant-1", quantity: "2" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects the same variant listed twice", () => {
    // OrderItem is UNIQUE (orderId, shopifyVariantId): quantities must be merged
    // before they get here, and a duplicate would otherwise surface as a P2002
    // inside the transaction, indistinguishable from an idempotency race.
    const result = checkoutSchema.safeParse({
      ...VALID,
      items: [
        { variantId: "variant-1", quantity: 1 },
        { variantId: "variant-1", quantity: 2 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more lines than a cart may hold", () => {
    const items = Array.from({ length: 51 }, (_, index) => ({
      variantId: `variant-${index}`,
      quantity: 1,
    }));
    expect(checkoutSchema.safeParse({ ...VALID, items }).success).toBe(false);
  });
});

describe("checkoutSchema: customer fields", () => {
  it("requires name, phone, address, city and country", () => {
    for (const field of [
      "customerName",
      "customerPhone",
      "addressLine1",
      "city",
      "countryCode",
    ] as const) {
      const body: Record<string, unknown> = { ...VALID };
      delete body[field];
      const result = checkoutSchema.safeParse(body);
      expect(result.success).toBe(false);
      if (!result.success) expect(Object.keys(formatIssues(result.error))).toContain(field);
    }
  });

  it("treats a whitespace-only required field as missing", () => {
    const result = checkoutSchema.safeParse({ ...VALID, customerName: "   " });
    expect(result.success).toBe(false);
  });

  it("trims the values it keeps", () => {
    const result = checkoutSchema.safeParse({ ...VALID, customerName: "  Ayesha Khan  " });
    expect(result.success && result.data.customerName).toBe("Ayesha Khan");
  });

  it("uppercases the country code and rejects anything that is not two letters", () => {
    const ok = checkoutSchema.safeParse({ ...VALID, countryCode: "pk" });
    expect(ok.success && ok.data.countryCode).toBe("PK");

    for (const code of ["P", "PAK", "12", "P1", ""]) {
      expect(checkoutSchema.safeParse({ ...VALID, countryCode: code }).success).toBe(false);
    }
  });

  it("accepts an order with no email, since cash on delivery needs a phone", () => {
    const result = checkoutSchema.safeParse({ ...VALID, customerEmail: "" });
    expect(result.success && result.data.customerEmail).toBeUndefined();
  });

  it("rejects a malformed email when one is given", () => {
    expect(checkoutSchema.safeParse({ ...VALID, customerEmail: "not-an-email" }).success).toBe(false);
  });

  it("normalises an empty optional field to null rather than an empty string", () => {
    // The columns are nullable; storing "" would make "absent" and "blank" two
    // different states in the database for no reason.
    const result = checkoutSchema.safeParse({
      ...VALID,
      addressLine2: "",
      province: "  ",
      postalCode: "",
      customerNote: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.addressLine2).toBeNull();
      expect(result.data.province).toBeNull();
      expect(result.data.postalCode).toBeNull();
      expect(result.data.customerNote).toBeNull();
    }
  });

  it("enforces the column widths", () => {
    expect(checkoutSchema.safeParse({ ...VALID, customerName: "a".repeat(256) }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...VALID, customerPhone: "9".repeat(33) }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...VALID, city: "a".repeat(129) }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...VALID, customerNote: "a".repeat(2001) }).success).toBe(false);
  });

  it("accepts a phone number in any of the formats a customer might type", () => {
    for (const phone of ["03001234567", "+92 300 1234567", "(042) 111-222-333"]) {
      expect(checkoutSchema.safeParse({ ...VALID, customerPhone: phone }).success).toBe(true);
    }
  });
});

describe("checkoutSchema: idempotency key", () => {
  it("requires a key of plausible length", () => {
    expect(checkoutSchema.safeParse({ ...VALID, idempotencyKey: "short" }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...VALID, idempotencyKey: "k".repeat(65) }).success).toBe(false);
  });

  it("rejects a missing key: an unkeyed checkout cannot be made idempotent", () => {
    const body: Record<string, unknown> = { ...VALID };
    delete body.idempotencyKey;
    expect(checkoutSchema.safeParse(body).success).toBe(false);
  });
});

describe("formatIssues", () => {
  it("reports one message per field and never echoes the submitted value", () => {
    const result = checkoutSchema.safeParse({
      ...VALID,
      customerName: "",
      customerEmail: "bad@",
    });
    expect(result.success).toBe(false);
    if (result.success) return;

    const errors = formatIssues(result.error);
    expect(errors.customerName).toBeTruthy();
    // PII must not travel back out in an error message, and neither should the
      // rejected value.
    expect(JSON.stringify(errors)).not.toContain("bad@");
    expect(JSON.stringify(errors)).not.toContain(VALID.customerPhone);
  });

  it("labels a whole-body failure rather than losing it", () => {
    const result = checkoutSchema.safeParse("not an object");
    expect(result.success).toBe(false);
    if (!result.success) expect(Object.keys(formatIssues(result.error))).toContain("form");
  });
});
