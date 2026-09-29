/**
 * Retryable versus permanent.
 *
 * The distinction is the difference between an order that recovers from a blip
 * and an operator finding out 90 seconds late that Shopify refused the request
 * outright. Getting it backwards in either direction is expensive:
 *
 *   a permanent error treated as retryable  -> 5 attempts, ~150s of backoff, the
 *                                              same refusal, and a log nobody reads
 *   a retryable error treated as permanent  -> an order marked FAILED because a
 *                                              socket hiccuped
 */
import { describe, expect, it } from "vitest";

import { ShopifyError } from "@/src/lib/shopify/errors";
import { isPermanent, PermanentSubmissionError } from "@/src/lib/orders/submit-order";

describe("isPermanent: retryable failures", () => {
  it("treats a transport failure as retryable", () => {
    const error = new ShopifyError("socket hang up", { kind: "transport", retryable: true });
    expect(isPermanent(error)).toBe(false);
  });

  it("treats throttling as retryable", () => {
    const error = new ShopifyError("THROTTLED", {
      kind: "throttled",
      retryable: true,
      code: "THROTTLED",
      retryAfterMs: 2000,
    });
    expect(isPermanent(error)).toBe(false);
  });

  it("treats a 5xx as retryable", () => {
    const error = new ShopifyError("Shopify returned HTTP 503", {
      kind: "transport",
      retryable: true,
      status: 503,
    });
    expect(isPermanent(error)).toBe(false);
  });

  it("treats an unknown error as retryable", () => {
    // A MySQL deadlock or a socket reset inside Prisma. The attempt cap is what
    // stops this being infinite, and guessing "permanent" here would fail orders
    // for transient database trouble.
    expect(isPermanent(new Error("Deadlock found when trying to get lock"))).toBe(false);
    expect(isPermanent("a string")).toBe(false);
    expect(isPermanent(undefined)).toBe(false);
  });
});

describe("isPermanent: permanent failures", () => {
  it("treats a mutation userError as permanent", () => {
    // HTTP 200, valid query, Shopify refused. "Variant does not exist" does not
    // become "variant exists" on the third attempt.
    const error = new PermanentSubmissionError(
      "draft_create_user_error",
      "lineItems.0.variantId: Variant does not exist",
    );
    expect(isPermanent(error)).toBe(true);
    expect(error.retryable).toBe(false);
  });

  it("treats a GraphQL-level error as permanent", () => {
    // A malformed query or a missing field: no retry can fix the query that was
    // sent.
    const error = new ShopifyError("Field 'nope' doesn't exist", {
      kind: "graphql",
      retryable: false,
    });
    expect(isPermanent(error)).toBe(true);
  });

  it("treats an auth failure as permanent", () => {
    // The integration is down, not the job. Retrying a revoked token per order
    // turns one broken credential into a flood.
    const error = new ShopifyError("403 missing scope", {
      kind: "auth",
      retryable: false,
      status: 403,
    });
    expect(isPermanent(error)).toBe(true);
  });

  it("carries a stable machine-readable reason for the operator list", () => {
    const error = new PermanentSubmissionError("duplicate_submission_key", "found 2 drafts");
    expect(error.reason).toBe("duplicate_submission_key");
    expect(error.name).toBe("PermanentSubmissionError");
  });
});

describe("PermanentSubmissionError: what it carries", () => {
  it("keeps Shopify's refusal text and nothing of the customer's", () => {
    // The message is Shopify's own description of what it refused. The input that
    // caused it -- which contains an address and a phone number -- is deliberately
    // not attached, because this string is written to `lastError` and logged.
    const error = new PermanentSubmissionError(
      "draft_create_user_error",
      "lineItems.0.variantId: Variant does not exist",
    );
    expect(error.message).toContain("Variant does not exist");
    expect(error.message).not.toMatch(/\+92|Jinnah|Ayesha/);
  });
});
