import { describe, expect, it } from "vitest";

import { EXPIRY_SKEW_MS, expiryFromResponse, isUsable } from "@/src/lib/shopify/auth";

const NOW = 1_800_000_000_000;

describe("token expiry", () => {
  it("expires a 24h token early, by the safety skew", () => {
    // Shopify's client credentials grant returns expires_in: 86399.
    const expiresAt = expiryFromResponse(86_399, NOW);
    expect(expiresAt).toBe(NOW + 86_399 * 1000 - EXPIRY_SKEW_MS);
    // ~23h55m of usable life, not 24h: a token must not die mid-request.
    expect(Math.round((expiresAt - NOW) / 1000)).toBe(86_099);
  });

  it("assumes a short life when Shopify omits expires_in", () => {
    // Guessing high means using a dead token; guessing low costs one exchange.
    const expiresAt = expiryFromResponse(undefined, NOW);
    expect(expiresAt).toBeGreaterThan(NOW);
    expect(expiresAt).toBeLessThanOrEqual(NOW + 60 * 60 * 1000);
  });

  it("never returns an expiry in the past, however short the lifetime", () => {
    // A lifetime smaller than the skew would otherwise expire on arrival and
    // send every request into a re-exchange loop.
    for (const seconds of [1, 10, 60, 299]) {
      expect(expiryFromResponse(seconds, NOW)).toBeGreaterThan(NOW);
    }
  });

  it("ignores a nonsensical expires_in", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(expiryFromResponse(bad, NOW)).toBeGreaterThan(NOW);
    }
  });
});

describe("cache usability", () => {
  const entry = { token: "irrelevant", expiresAtMs: NOW + 10_000, scope: "read_products" };

  it("uses a token that has not expired", () => {
    expect(isUsable(entry, NOW)).toBe(true);
  });

  it("re-requests once the expiry has passed", () => {
    expect(isUsable(entry, NOW + 10_001)).toBe(false);
  });

  it("treats the exact expiry instant as expired", () => {
    expect(isUsable(entry, NOW + 10_000)).toBe(false);
  });

  it("has nothing to use when the cache is empty", () => {
    expect(isUsable(null, NOW)).toBe(false);
  });
});
