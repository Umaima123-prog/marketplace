/**
 * Phone validation and E.164 normalisation.
 *
 * The calibration case is at the bottom: the four phone numbers this store has
 * actually seen. Two were accepted by Shopify and two were refused with
 * `phone: Phone is invalid`, and the validator has to agree with Shopify on all
 * four — otherwise it is either still letting the bad ones through or newly
 * rejecting customers who would have been fine.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_PHONE_DIGITS,
  MIN_PHONE_DIGITS,
  isValidPhone,
  normalizePhone,
} from "@/src/lib/phone";

/** The E.164 string, or null when rejected. Keeps the assertions short. */
function e164(raw: string): string | null {
  const result = normalizePhone(raw);
  return result.ok ? result.e164 : null;
}

describe("normalizePhone: valid international numbers", () => {
  it("accepts an already-normalised E.164 number unchanged", () => {
    expect(e164("+923001234567")).toBe("+923001234567");
  });

  it("accepts the separators people actually type", () => {
    // Every one of these is the same number and must normalise identically.
    for (const raw of [
      "+92 300 1234567",
      "+92-300-1234567",
      "+92 (300) 1234567",
      "+92.300.1234567",
      "  +92 300 1234567  ",
      "+92 300 1234567", // non-breaking spaces, as pasted from a web page
      "+92‑300‑1234567", // non-breaking hyphens
      "+92–300–1234567", // en dashes
    ]) {
      expect(e164(raw), raw).toBe("+923001234567");
    }
  });

  it("treats the ITU 00 access prefix as equivalent to +", () => {
    expect(e164("0092 300 1234567")).toBe("+923001234567");
    expect(e164("00923001234567")).toBe("+923001234567");
  });

  it("accepts numbers from other countries", () => {
    expect(e164("+1 (415) 555-0132")).toBe("+14155550132");
    expect(e164("+44 20 7123 4567")).toBe("+442071234567");
    expect(e164("+971 50 123 4567")).toBe("+971501234567");
  });

  it("accepts the shortest and longest real international numbers", () => {
    // 7 digits total: small territories have four-digit subscriber numbers.
    const shortest = `+${"2".repeat(MIN_PHONE_DIGITS)}`;
    // 15 digits is E.164's hard maximum.
    const longest = `+${"2".repeat(MAX_PHONE_DIGITS)}`;
    expect(e164(shortest)).toBe(shortest);
    expect(e164(longest)).toBe(longest);
  });

  it("never returns separators or a leading 00 in the normalised value", () => {
    for (const raw of ["+92 300 1234567", "0092-300-1234567", "+1 (415) 555-0132"]) {
      const value = e164(raw);
      expect(value, raw).toMatch(/^\+[1-9][0-9]{6,14}$/);
    }
  });
});

describe("normalizePhone: rejected values", () => {
  it("rejects an empty or whitespace-only value", () => {
    for (const raw of ["", "   ", "\t\n"]) {
      const result = normalizePhone(raw);
      expect(result.ok, JSON.stringify(raw)).toBe(false);
      if (!result.ok) expect(result.message).toBe("Phone number is required");
    }
  });

  it("rejects a national number with no country code", () => {
    // This is the real failure: a valid Pakistani number locally, meaningless to
    // a courier API, and accepted by the old non-empty check.
    const result = normalizePhone("03001234567");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/country code/i);
  });

  it("rejects a bare digit string, because the country code cannot be guessed", () => {
    // "923001234567" and "03001234567" are indistinguishable as bare digits, and
    // guessing wrong would silently store a different, possibly real, number.
    expect(e164("923001234567")).toBeNull();
    expect(e164("3001234567")).toBeNull();
  });

  it("rejects a country code starting with zero", () => {
    const result = normalizePhone("+03001234567");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/cannot start with 0/i);
  });

  it("rejects letters rather than stripping them", () => {
    // Stripping would turn a typo into a different valid number.
    for (const raw of ["+92 300 ABCDEFG", "+92300123456X", "+92300o234567", "phone"]) {
      expect(e164(raw), raw).toBeNull();
    }
  });

  it("rejects characters that are not separators", () => {
    for (const raw of ["+92#3001234567", "+92*3001234567", "+92/3001234567", "+92,3001234567"]) {
      expect(e164(raw), raw).toBeNull();
    }
  });

  it("rejects too few and too many digits", () => {
    const tooShort = `+${"2".repeat(MIN_PHONE_DIGITS - 1)}`;
    const tooLong = `+${"2".repeat(MAX_PHONE_DIGITS + 1)}`;
    for (const raw of [tooShort, tooLong]) {
      const result = normalizePhone(raw);
      expect(result.ok, raw).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/digits/i);
    }
  });

  it("rejects a lone plus or a plus with only separators", () => {
    for (const raw of ["+", "+ ", "+()-", "++923001234567"]) {
      expect(e164(raw), raw).toBeNull();
    }
  });

  it("gives every rejection a message naming a valid example", () => {
    // A validation error the shopper cannot act on is the gap this fix closes,
    // so "invalid" on its own is not an acceptable message.
    for (const raw of ["03001234567", "+03001234567", "+92", "not a phone"]) {
      const result = normalizePhone(raw);
      expect(result.ok, raw).toBe(false);
      if (!result.ok) expect(result.message, raw).toContain("+923001234567");
    }
  });
});

describe("isValidPhone", () => {
  it("agrees with normalizePhone", () => {
    expect(isValidPhone("+92 300 1234567")).toBe(true);
    expect(isValidPhone("03001234567")).toBe(false);
  });
});

describe("agreement with Shopify on the numbers this store has seen", () => {
  /**
   * Shapes only -- no real customer number appears here or in the repository.
   * Each row reproduces the SHAPE of one order's phone as read from MySQL
   * (digit count, whether it carried a `+`, whether it had separators) together
   * with what Shopify did with it.
   */
  const SEEN: Array<{ shape: string; shopifyAccepted: boolean }> = [
    // Order 1: 12 digits, leading +, separators. Shopify created the draft.
    { shape: "+92 300 1234567", shopifyAccepted: true },
    // Order 2: 12 digits, leading +, no separators. Shopify created the draft.
    { shape: "+923001234567", shopifyAccepted: true },
    // Orders 3 and 4: 12 digits, NO leading +. Shopify answered
    // `phone: Phone is invalid`, after the local order had already committed.
    { shape: "923001234567", shopifyAccepted: false },
    { shape: "923001234567", shopifyAccepted: false },
  ];

  it("accepts exactly what Shopify accepted and rejects exactly what it refused", () => {
    for (const { shape, shopifyAccepted } of SEEN) {
      expect(isValidPhone(shape), shape).toBe(shopifyAccepted);
    }
  });
});
