/**
 * Request fingerprinting for idempotency.
 *
 * `requestFingerprint` is a SECURITY control, not a convenience
 * (ARCHITECTURE 4.3). The idempotency key is browser-supplied, so returning a
 * stored order for a key without proving the caller authored the original
 * request would hand one customer another customer's order -- name, phone and
 * address included. The fingerprint binds a key to the request that created it.
 *
 * Canonicalisation matters: the same order re-submitted must produce the same
 * digest, so lines are sorted, whitespace is normalised, case is folded where it
 * is not significant, and the field order is fixed rather than inherited from JS
 * object key order.
 */
import { createHash } from "node:crypto";

import type { CheckoutInput } from "./checkout.schema";

/** Separator that cannot occur in any of the normalised values. */
const SEP = String.fromCharCode(0);

export function computeRequestFingerprint(input: CheckoutInput): string {
  const lines = input.items
    .map((item) => `${item.variantId}:${item.quantity}`)
    .sort()
    .join(",");

  const canonical = [
    lines,
    norm(input.customerName),
    digits(input.customerPhone),
    norm(input.customerEmail ?? ""),
    norm(input.addressLine1),
    norm(input.addressLine2 ?? ""),
    norm(input.city),
    norm(input.province ?? ""),
    norm(input.postalCode ?? ""),
    input.countryCode.toUpperCase(),
    norm(input.customerNote ?? ""),
  ].join(SEP);

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Lowercased, whitespace-collapsed: "John  Smith " and "john smith" are one person. */
function norm(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Phone numbers compare on digits alone, so "+92 300 1234567" and
 * "+923001234567" are the same number and do not produce a spurious conflict.
 */
function digits(value: string): string {
  return value.replace(/\D+/g, "");
}
