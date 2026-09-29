/**
 * Order + OrderItems -> DraftOrderInput.
 *
 * Pure, and takes plain values rather than Prisma rows, so the mapping can be
 * tested without a database and without Shopify. It is the one place that
 * decides what customer data leaves this system.
 *
 * Every price comes from the OrderItem SNAPSHOT, never from the catalog. The
 * customer was quoted a number, that number is what the courier collects, and a
 * variant whose price changed between checkout and submission must not silently
 * change what Shopify records. `priceOverride` is how that is expressed: without
 * it, Shopify prices the line from the variant's current catalog price.
 */
import { submissionTag } from "@/src/lib/shopify/order-mutations";

export interface DraftOrderItemSource {
  shopifyVariantId: string;
  quantity: number;
  /** Exact decimal string from OrderItem.unitPrice. */
  unitPrice: string;
}

export interface DraftOrderSource {
  reference: string;
  submissionKey: string;
  currencyCode: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  province: string | null;
  postalCode: string | null;
  countryCode: string;
  customerNote: string | null;
  items: DraftOrderItemSource[];
}

export interface MoneyInput {
  amount: string;
  currencyCode: string;
}

export interface DraftOrderInput {
  email?: string;
  phone: string;
  note: string;
  tags: string[];
  customAttributes: Array<{ key: string; value: string }>;
  taxExempt: boolean;
  shippingLine: { title: string; priceWithCurrency: MoneyInput };
  shippingAddress: {
    firstName: string;
    lastName?: string;
    address1: string;
    address2?: string;
    city: string;
    zip?: string;
    countryCode: string;
    phone: string;
  };
  lineItems: Array<{
    variantId: string;
    quantity: number;
    priceOverride: MoneyInput;
  }>;
  paymentTerms?: { paymentTermsTemplateId: string };
}

/** What the merchant sees on the order, and what the courier is being asked to do. */
export const COD_NOTE_PREFIX = "Cash on Delivery";
export const COD_TAG = "COD";
export const COD_SHIPPING_TITLE = "Cash on delivery";

/**
 * Splits a single name field into the two Shopify wants.
 *
 * One field in, two out, and the split is naive on purpose: a delivery label
 * needs the name the customer typed, not a parsed representation of it.
 * Everything after the first token is the last name, so "Ayesha Khan" and
 * "Maria del Carmen Garcia" both come out intact when rejoined.
 */
export function splitName(fullName: string): { firstName: string; lastName?: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "Customer" };
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/**
 * Builds the input for `draftOrderCreate`.
 *
 * `paymentTermsTemplateId` is passed in rather than looked up here, so this
 * function stays pure and the API round trip that discovers it stays in one
 * place. When it is absent the draft is created without payment terms, which is
 * a degraded but honest outcome -- see submit-order.ts for why that is preferred
 * over failing the submission.
 */
export function buildDraftOrderInput(
  order: DraftOrderSource,
  options: { paymentTermsTemplateId?: string } = {},
): DraftOrderInput {
  const { firstName, lastName } = splitName(order.customerName);

  const input: DraftOrderInput = {
    // Optional for COD: a phone is what the courier needs. Omitted entirely
    // rather than sent as an empty string, which Shopify would reject.
    ...(order.customerEmail ? { email: order.customerEmail } : {}),
    phone: order.customerPhone,
    note: buildNote(order),
    // The submission key appears twice, deliberately. The tag is searchable, so
    // it is what a lost-response pre-flight queries; the custom attribute is
    // exact and survives a merchant editing tags in the admin.
    tags: [COD_TAG, submissionTag(order.submissionKey)],
    customAttributes: [
      { key: "submissionKey", value: order.submissionKey },
      { key: "codReference", value: order.reference },
    ],
    // Tax is 0 locally (ARCHITECTURE 4.1), so Shopify must not add its own --
    // otherwise the total it records differs from the total the customer agreed
    // to and the courier collects.
    taxExempt: true,
    shippingLine: {
      title: COD_SHIPPING_TITLE,
      priceWithCurrency: { amount: "0.00", currencyCode: order.currencyCode },
    },
    shippingAddress: {
      firstName,
      ...(lastName ? { lastName } : {}),
      address1: order.addressLine1,
      ...(order.addressLine2 ? { address2: order.addressLine2 } : {}),
      city: order.city,
      ...(order.postalCode ? { zip: order.postalCode } : {}),
      countryCode: order.countryCode,
      phone: order.customerPhone,
    },
    lineItems: order.items.map((item) => ({
      variantId: item.shopifyVariantId,
      quantity: item.quantity,
      priceOverride: { amount: item.unitPrice, currencyCode: order.currencyCode },
    })),
  };

  if (options.paymentTermsTemplateId) {
    input.paymentTerms = { paymentTermsTemplateId: options.paymentTermsTemplateId };
  }

  return input;
}

/**
 * The order note.
 *
 * Carries the province, which is why it exists in this shape:
 * `MailingAddressInput` on 2026-07 accepts `provinceCode` and has no free-text
 * province field. The checkout collects a province as typed ("Punjab"), and
 * sending that as a CODE would be wrong -- either refused or stored as a
 * different place. So the structured address omits it and the note preserves it,
 * which keeps the information in front of whoever packs the parcel instead of
 * discarding it.
 */
function buildNote(order: DraftOrderSource): string {
  const lines = [`${COD_NOTE_PREFIX} — collect ${order.currencyCode} on delivery`];
  lines.push(`Reference: ${order.reference}`);
  if (order.province) lines.push(`Province/state: ${order.province}`);
  if (order.customerNote) lines.push(`Customer note: ${order.customerNote}`);
  return lines.join("\n");
}
