/**
 * Request fingerprinting.
 *
 * The fingerprint is what makes a browser-supplied idempotency key safe to act
 * on. Two properties matter and pull in opposite directions:
 *
 *   - the SAME order resubmitted must produce the SAME digest, or a retry places
 *     a second order;
 *   - a DIFFERENT order must produce a DIFFERENT digest, or a key collision hands
 *     one customer another customer's order, address and phone number included.
 */
import { describe, expect, it } from "vitest";

import { checkoutSchema, type CheckoutInput } from "@/src/server/checkout/checkout.schema";
import { computeRequestFingerprint } from "@/src/server/checkout/fingerprint";

const BASE = {
  idempotencyKey: "0d9f1c3e-8b7a-4e21-9f0a-2c5d7e8f1a2b",
  items: [
    { variantId: "variant-1", quantity: 2 },
    { variantId: "variant-2", quantity: 1 },
  ],
  customerName: "Ayesha Khan",
  customerPhone: "+92 300 1234567",
  customerEmail: "ayesha@example.com",
  addressLine1: "12 Jinnah Road",
  addressLine2: "Flat 4",
  city: "Lahore",
  province: "Punjab",
  postalCode: "54000",
  countryCode: "PK",
  customerNote: "Call on arrival",
};

/** Fingerprints are computed on PARSED input, so the tests parse too. */
function input(overrides: Record<string, unknown> = {}): CheckoutInput {
  const result = checkoutSchema.safeParse({ ...BASE, ...overrides });
  if (!result.success) throw new Error(`fixture is invalid: ${result.error.issues[0]?.message}`);
  return result.data;
}

describe("computeRequestFingerprint: stability", () => {
  it("is a 64-character hex digest", () => {
    expect(computeRequestFingerprint(input())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is identical for the same request computed twice", () => {
    expect(computeRequestFingerprint(input())).toBe(computeRequestFingerprint(input()));
  });

  it("ignores the order of the cart lines", () => {
    // The client may reorder the cart between a submit and its retry; that is not
    // a different order.
    const reversed = input({ items: [...BASE.items].reverse() });
    expect(computeRequestFingerprint(reversed)).toBe(computeRequestFingerprint(input()));
  });

  it("ignores the idempotency key itself", () => {
    // The key identifies the attempt; the fingerprint describes the request. If
    // the key fed the digest, the same order under a new key would look like a
    // different request -- which is true, but it is the caller's job to decide
    // that, not the hash's.
    const other = input({ idempotencyKey: "ffffffff-8b7a-4e21-9f0a-2c5d7e8f1a2b" });
    expect(computeRequestFingerprint(other)).toBe(computeRequestFingerprint(input()));
  });

  it("ignores whitespace and letter case in text fields", () => {
    const messy = input({ customerName: "  ayesha   KHAN ", city: "lahore" });
    expect(computeRequestFingerprint(messy)).toBe(computeRequestFingerprint(input()));
  });

  it("ignores phone formatting, comparing digits only", () => {
    // "+92 300 1234567" and "+923001234567" are one phone number. Treating them
    // as two would turn an autofill difference into a spurious 409.
    for (const phone of ["+923001234567", "+92-300-1234567", "+92 (300) 1234567"]) {
      expect(computeRequestFingerprint(input({ customerPhone: phone }))).toBe(
        computeRequestFingerprint(input()),
      );
    }
  });

  it("ignores country-code case", () => {
    expect(computeRequestFingerprint(input({ countryCode: "pk" }))).toBe(
      computeRequestFingerprint(input()),
    );
  });
});

describe("computeRequestFingerprint: sensitivity", () => {
  it("changes when a quantity changes", () => {
    const changed = input({ items: [{ variantId: "variant-1", quantity: 3 }, BASE.items[1]] });
    expect(computeRequestFingerprint(changed)).not.toBe(computeRequestFingerprint(input()));
  });

  it("changes when a variant changes", () => {
    const changed = input({ items: [{ variantId: "variant-9", quantity: 2 }, BASE.items[1]] });
    expect(computeRequestFingerprint(changed)).not.toBe(computeRequestFingerprint(input()));
  });

  it("changes when a line is added or removed", () => {
    const fewer = input({ items: [BASE.items[0]] });
    expect(computeRequestFingerprint(fewer)).not.toBe(computeRequestFingerprint(input()));
  });

  it("changes for every contact and address field", () => {
    const variations: Array<Record<string, unknown>> = [
      { customerName: "Bilal Ahmed" },
      { customerPhone: "+92 300 7654321" },
      { customerEmail: "someone.else@example.com" },
      { addressLine1: "13 Jinnah Road" },
      { addressLine2: "Flat 5" },
      { city: "Karachi" },
      { province: "Sindh" },
      { postalCode: "75000" },
      { countryCode: "AE" },
      { customerNote: "Leave at the gate" },
    ];

    const baseline = computeRequestFingerprint(input());
    for (const variation of variations) {
      expect(computeRequestFingerprint(input(variation))).not.toBe(baseline);
    }
  });

  it("distinguishes an absent optional field from a present one", () => {
    const withoutEmail = input({ customerEmail: "" });
    expect(computeRequestFingerprint(withoutEmail)).not.toBe(computeRequestFingerprint(input()));
  });

  it("does not let a value moved between fields collide", () => {
    // Without a field separator, {city: "ab", province: "c"} and
    // {city: "a", province: "bc"} would hash identically -- and a shared key
    // between them would return the wrong customer's order.
    const a = computeRequestFingerprint(input({ city: "ab", province: "c" }));
    const b = computeRequestFingerprint(input({ city: "a", province: "bc" }));
    expect(a).not.toBe(b);
  });
});
