/**
 * Checkout input validation.
 *
 * `.strict()` everywhere, which is the security-relevant part: an unknown key is
 * REJECTED rather than ignored. A client that sends `price`, `subtotal` or
 * `total` gets a validation error instead of having the field quietly dropped --
 * the failure is visible rather than silent, and there is no field name a future
 * refactor could accidentally start trusting.
 *
 * Note what is absent from the schema entirely: any money field. The server
 * reads every price from MySQL, so there is nothing for the browser to send.
 */
import { z } from "zod";

import { MAX_CART_LINES, MAX_LINE_QUANTITY } from "@/src/lib/cart/cart-state";

/** Trim, then reject empty -- a string of spaces is not a name. */
const requiredText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional();

export const cartLineSchema = z
  .object({
    variantId: z.string().trim().min(1).max(64),
    quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
  })
  .strict();

export const checkoutSchema = z
  .object({
    // Browser-supplied, and therefore verified against requestFingerprint
    // before it is ever dereferenced (ARCHITECTURE 4.3).
    idempotencyKey: z.string().trim().min(8).max(64),

    // Distinct variants only. OrderItem has UNIQUE (orderId, shopifyVariantId) --
    // one line per variant, forcing quantity merging -- so a payload naming the
    // same variant twice would fail deep inside the transaction on a constraint
    // whose P2002 is indistinguishable from an idempotency race. Rejecting it here
    // keeps that error where it belongs: the request.
    items: z
      .array(cartLineSchema)
      .min(1, "Your cart is empty")
      .max(MAX_CART_LINES)
      .refine(
        (items) => new Set(items.map((item) => item.variantId)).size === items.length,
        "Each item may appear only once",
      ),

    customerName: requiredText(255, "Name"),
    // Deliberately permissive: phone formats vary by country and an over-strict
    // pattern rejects real customers. Length-bounded to fit VARCHAR(32); the
    // courier is the real validator.
    customerPhone: requiredText(32, "Phone number"),
    // Optional: a cash-on-delivery order needs a phone, not an email.
    customerEmail: z
      .union([z.string().trim().max(320).email("Enter a valid email address"), z.literal("")])
      .optional()
      .transform((value) => (value ? value : undefined)),

    addressLine1: requiredText(255, "Address"),
    addressLine2: optionalText(255),
    city: requiredText(128, "City"),
    province: optionalText(128),
    postalCode: optionalText(32),
    // ISO 3166-1 alpha-2, matching the CHAR(2) column.
    countryCode: z
      .string()
      .trim()
      .length(2, "Select a country")
      .regex(/^[A-Za-z]{2}$/, "Country must be a two-letter code")
      .transform((value) => value.toUpperCase()),

    customerNote: optionalText(2000),
  })
  .strict();

export type CheckoutInput = z.infer<typeof checkoutSchema>;

/** Field-level errors for the form, without echoing the submitted values. */
export function formatIssues(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    out[key] ??= issue.message;
  }
  return out;
}
