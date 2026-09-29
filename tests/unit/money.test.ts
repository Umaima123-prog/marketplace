import { describe, expect, it } from "vitest";

import {
  compareMoney,
  formatMoney,
  isMoneyString,
  minMoney,
  normalizeMoney,
  roundMoney,
} from "@/src/lib/money";

describe("compareMoney", () => {
  it("compares by magnitude, not lexically", () => {
    // "9.99" > "10.00" as strings; this is the bug the function exists to avoid.
    expect(compareMoney("9.99", "10.00")).toBeLessThan(0);
    expect(compareMoney("100.00", "99.99")).toBeGreaterThan(0);
  });

  it("treats trailing zeros as equal value", () => {
    expect(compareMoney("10", "10.00")).toBe(0);
    expect(compareMoney("10.5", "10.5000")).toBe(0);
  });

  it("handles differing fraction widths", () => {
    expect(compareMoney("10.05", "10.5")).toBeLessThan(0);
    expect(compareMoney("0.1", "0.09")).toBeGreaterThan(0);
  });

  it("orders negatives correctly", () => {
    expect(compareMoney("-5.00", "1.00")).toBeLessThan(0);
    expect(compareMoney("-1.00", "-5.00")).toBeGreaterThan(0);
  });

  it("ignores leading zeros", () => {
    expect(compareMoney("007.50", "7.5")).toBe(0);
  });
});

describe("minMoney", () => {
  it("picks the lowest of a set without arithmetic", () => {
    const prices = ["19.99", "9.99", "129.00", "9.95"];
    expect(prices.reduce(minMoney)).toBe("9.95");
  });
});

describe("roundMoney", () => {
  it("pads to two places", () => {
    expect(roundMoney("10")).toBe("10.00");
    expect(roundMoney("10.5")).toBe("10.50");
  });

  it("rounds half up", () => {
    expect(roundMoney("1.005")).toBe("1.01");
    expect(roundMoney("1.004")).toBe("1.00");
  });

  it("carries across a boundary", () => {
    expect(roundMoney("9.999")).toBe("10.00");
    expect(roundMoney("99.995")).toBe("100.00");
    expect(roundMoney("0.999")).toBe("1.00");
  });

  it("keeps values that binary floating point cannot represent", () => {
    // 0.1 + 0.2 === 0.30000000000000004 as numbers. Here nothing is added, and
    // nothing is a number.
    expect(roundMoney("0.1")).toBe("0.10");
    expect(roundMoney("1234567890123.4567")).toBe("1234567890123.46");
  });

  it("preserves a large DECIMAL(18,4) value exactly", () => {
    // Beyond Number.MAX_SAFE_INTEGER: a float round-trip would corrupt this.
    expect(roundMoney("99999999999999.9999")).toBe("100000000000000.00");
  });

  it("rejects a non-decimal input rather than guessing", () => {
    expect(() => roundMoney("19,99")).toThrow(TypeError);
    expect(() => roundMoney("abc")).toThrow(TypeError);
  });
});

describe("formatMoney", () => {
  it("renders the stored digits, not a float round-trip", () => {
    expect(formatMoney("19.99", "USD")).toBe("$19.99");
    expect(formatMoney("0.10", "USD")).toBe("$0.10");
  });

  it("groups thousands", () => {
    expect(formatMoney("1234567.89", "USD")).toBe("$1,234,567.89");
  });

  it("keeps precision a float would lose", () => {
    expect(formatMoney("1234567890123.45", "USD")).toBe("$1,234,567,890,123.45");
  });

  it("falls back to the code for an unknown currency", () => {
    expect(formatMoney("5.00", "XYZ")).toContain("5.00");
  });

  it("formats negatives without mangling the sign", () => {
    expect(formatMoney("-5.00", "USD")).toContain("5.00");
    expect(formatMoney("-5.00", "USD").startsWith("-")).toBe(true);
  });
});

describe("isMoneyString", () => {
  it("accepts exact decimal strings", () => {
    for (const value of ["0", "0.00", "19.99", "-1.5", "1234567890123.4567"]) {
      expect(isMoneyString(value)).toBe(true);
    }
  });

  it("rejects anything that is not one", () => {
    for (const value of [19.99, "19,99", "", "1e5", null, undefined, "$19.99"]) {
      expect(isMoneyString(value)).toBe(false);
    }
  });
});

describe("normalizeMoney", () => {
  it("pads to a minimum scale, because Decimal.toString() drops trailing zeros", () => {
    // Prisma returns DECIMAL(18,4) 15.0000 as "15"; next to "9.99" in the same
    // response that is inconsistent on the wire.
    expect(normalizeMoney("15")).toBe("15.00");
    expect(normalizeMoney("0.1")).toBe("0.10");
    expect(normalizeMoney("0")).toBe("0.00");
  });

  it("never truncates digits the column genuinely holds", () => {
    // DECIMAL(18,4): a four-decimal price keeps all four.
    expect(normalizeMoney("1234567890123.4567")).toBe("1234567890123.4567");
    expect(normalizeMoney("10.125")).toBe("10.125");
  });

  it("leaves an already-normal value alone", () => {
    expect(normalizeMoney("19.99")).toBe("19.99");
  });

  it("rejects a non-decimal input", () => {
    expect(() => normalizeMoney("19,99")).toThrow(TypeError);
  });
});
