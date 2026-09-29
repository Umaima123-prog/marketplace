/**
 * Resolving the Shopify port for the submit-order processor.
 *
 * This file exists because of a live failure. BullMQ invokes a processor as
 * `(job, token)`, and the processor's second parameter was a dependency with a
 * default value -- so BullMQ's token string was passed in its place and the first
 * real COD order failed with "shopify.findDraftOrdersByQuery is not a function".
 *
 * Nothing was lost (the failure preceded any Shopify write, and the order was
 * released back to PENDING_SYNC for retry), but a mis-registration must degrade to
 * correct behaviour rather than a TypeError in the middle of a submission.
 */
import { describe, expect, it } from "vitest";

import { logger } from "@/src/lib/logger";
import { resolveShopifyPort } from "@/src/worker/processors/submit-order";
import type { ShopifyPort } from "@/src/lib/orders/submit-order";

const log = logger.child({ service: "test" });

function fullPort(): ShopifyPort {
  return {
    createDraftOrder: async () => ({ id: "gid://x", name: null, status: null, order: null }),
    completeDraftOrder: async () => ({ id: "gid://x", name: null, status: null, order: null }),
    getDraftOrder: async () => null,
    findDraftOrdersByQuery: async () => [],
    resolvePaymentTermsTemplateId: async () => undefined,
  };
}

/** Every method the submission calls; a port missing any of them is not a port. */
const REQUIRED = [
  "createDraftOrder",
  "completeDraftOrder",
  "getDraftOrder",
  "findDraftOrdersByQuery",
  "resolvePaymentTermsTemplateId",
] as const;

describe("resolveShopifyPort", () => {
  it("uses an injected port as-is", () => {
    const port = fullPort();
    expect(resolveShopifyPort(port, log)).toBe(port);
  });

  it("falls back to a real port when given BullMQ's token string", () => {
    // The exact shape of the live failure: BullMQ's second argument is a token
    // like "0:1727712345678".
    const resolved = resolveShopifyPort("0:1727712345678", log);
    for (const method of REQUIRED) {
      expect(typeof resolved[method]).toBe("function");
    }
  });

  it("falls back for undefined, null and every other non-port value", () => {
    for (const candidate of [undefined, null, 42, true, "token", Symbol("x"), [], () => {}]) {
      const resolved = resolveShopifyPort(candidate, log);
      for (const method of REQUIRED) {
        expect(typeof resolved[method]).toBe("function");
      }
    }
  });

  it("falls back for an object that is only PARTLY a port", () => {
    // The dangerous middle case: something port-shaped enough to pass a naive
    // truthiness check, then throwing on the one method it lacks -- which is
    // precisely how the live failure surfaced.
    for (const method of REQUIRED) {
      const partial = fullPort() as unknown as Record<string, unknown>;
      delete partial[method];
      const resolved = resolveShopifyPort(partial, log);
      expect(resolved).not.toBe(partial);
      for (const required of REQUIRED) {
        expect(typeof resolved[required]).toBe("function");
      }
    }
  });

  it("returns something with no missing method, whatever it was given", () => {
    // The invariant that matters: the submission can call every method without a
    // TypeError, regardless of what arrived.
    for (const candidate of [fullPort(), "token", undefined, {}]) {
      const resolved = resolveShopifyPort(candidate, log);
      expect(Object.keys(resolved).length === 0 || REQUIRED.every((m) => typeof resolved[m] === "function")).toBe(true);
      for (const method of REQUIRED) expect(typeof resolved[method]).toBe("function");
    }
  });
});
