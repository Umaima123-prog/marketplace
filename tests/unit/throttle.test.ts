import { describe, expect, it } from "vitest";

import {
  MAX_INLINE_THROTTLE_WAIT_MS,
  backoffMs,
  parseCost,
  throttleRetryDelayMs,
  waitForCostMs,
} from "@/src/lib/shopify/throttle";
import { ShopifyError, shouldRetry } from "@/src/lib/shopify/errors";

const status = (currentlyAvailable: number, restoreRate = 100) => ({
  maximumAvailable: 2000,
  currentlyAvailable,
  restoreRate,
});

describe("parseCost", () => {
  it("reads Shopify's cost extension", () => {
    const cost = parseCost({
      cost: {
        requestedQueryCost: 52,
        actualQueryCost: 48,
        throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1900, restoreRate: 100 },
      },
    });
    expect(cost).toEqual({
      requestedQueryCost: 52,
      actualQueryCost: 48,
      throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1900, restoreRate: 100 },
    });
  });

  it("returns null for anything malformed rather than guessing", () => {
    expect(parseCost(undefined)).toBeNull();
    expect(parseCost({})).toBeNull();
    expect(parseCost({ cost: {} })).toBeNull();
    expect(parseCost({ cost: { requestedQueryCost: "52", throttleStatus: {} } })).toBeNull();
    expect(
      parseCost({ cost: { requestedQueryCost: 52, throttleStatus: { currentlyAvailable: 10 } } }),
    ).toBeNull();
  });
});

describe("waitForCostMs", () => {
  it("does not wait when the bucket already covers the request", () => {
    expect(waitForCostMs(status(1000), 50)).toBe(0);
    expect(waitForCostMs(status(50), 50)).toBe(0);
  });

  it("waits exactly long enough for the deficit to restore", () => {
    // Need 150, have 50, restores 100/s -> 1s.
    expect(waitForCostMs(status(50, 100), 150)).toBe(1000);
    // Need 100, have 0, restores 50/s -> 2s.
    expect(waitForCostMs(status(0, 50), 100)).toBe(2000);
  });

  it("rounds up so the wait is never a fraction short", () => {
    expect(waitForCostMs(status(0, 3), 10)).toBe(3334);
  });

  it("does not divide by a zero restore rate", () => {
    expect(waitForCostMs(status(0, 0), 100)).toBe(0);
  });
});

describe("throttleRetryDelayMs", () => {
  it("caps the inline wait so a worker does not park holding a lock", () => {
    const cost = {
      requestedQueryCost: 1000,
      actualQueryCost: null,
      throttleStatus: status(0, 1),
    };
    // Uncapped this would be 1000 seconds.
    expect(throttleRetryDelayMs(cost, 1000)).toBe(MAX_INLINE_THROTTLE_WAIT_MS);
  });

  it("has a floor, so a retry is never a busy loop", () => {
    const cost = { requestedQueryCost: 1, actualQueryCost: null, throttleStatus: status(1000) };
    expect(throttleRetryDelayMs(cost, 1)).toBe(250);
  });

  it("falls back to a second when Shopify told us nothing", () => {
    expect(throttleRetryDelayMs(null, 0)).toBe(1000);
  });
});

describe("backoffMs", () => {
  it("grows the ceiling exponentially and stays within it", () => {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const ceiling = Math.min(30_000, 500 * 2 ** (attempt - 1));
      for (let i = 0; i < 50; i += 1) {
        const delay = backoffMs(attempt);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("is jittered, so simultaneous failures do not retry in lockstep", () => {
    const samples = new Set(Array.from({ length: 40 }, () => backoffMs(5)));
    expect(samples.size).toBeGreaterThan(1);
  });

  it("respects the cap", () => {
    expect(backoffMs(20, 500, 1_000)).toBeLessThanOrEqual(1_000);
  });
});

describe("retry decisions", () => {
  it("retries transport failures and throttling", () => {
    expect(shouldRetry(new ShopifyError("boom", { kind: "transport", retryable: true }))).toBe(true);
    expect(shouldRetry(new ShopifyError("slow down", { kind: "throttled", retryable: true }))).toBe(
      true,
    );
  });

  it("does not retry auth failures -- the integration is down, not the job", () => {
    expect(
      shouldRetry(new ShopifyError("bad token", { kind: "auth", retryable: false, status: 401 })),
    ).toBe(false);
  });

  it("does not retry a malformed query or a missing scope", () => {
    expect(shouldRetry(new ShopifyError("bad field", { kind: "graphql", retryable: false }))).toBe(
      false,
    );
  });

  it("treats unknown errors as transient, bounded by the attempt cap", () => {
    expect(shouldRetry(new Error("MySQL deadlock"))).toBe(true);
  });

  it("never puts a token in the loggable fields", () => {
    const error = new ShopifyError("Shopify rejected the access token", {
      kind: "auth",
      retryable: false,
      status: 401,
    });
    expect(JSON.stringify(error.toLogFields())).not.toMatch(/shpat_|token=/i);
  });
});
