/**
 * Resolving the payment terms that mean "cash on delivery".
 *
 * `draftOrderComplete(paymentPending: true)` is deprecated on the pinned API
 * version, with the stated replacement: "create a draft with payment terms
 * rather than marking the draft as pending". So the draft carries terms, and
 * Shopify derives an unpaid order with a due date from them.
 *
 * Template ids are PER SHOP, so the right one has to be discovered rather than
 * hard-coded. The preference order is a judgement about what COD means:
 *
 *   FULFILLMENT ("Due on fulfillment") - payment is due when the order ships or
 *                                        is delivered. This IS cash on delivery.
 *   RECEIPT     ("Due on receipt")     - due immediately. Close enough to be a
 *                                        usable fallback: still unpaid.
 *
 * NET and FIXED are deliberately not used: they would tell the merchant the money
 * is due in 30 days, which is a different commercial arrangement.
 *
 * Cached for the process lifetime. Templates are shop configuration and do not
 * change while a worker runs; re-querying per order would spend Shopify's cost
 * budget to learn the same answer.
 */
import { logger, type Logger } from "@/src/lib/logger";
import { shopifyGraphQL } from "@/src/lib/shopify/client";
import {
  PAYMENT_TERMS_TEMPLATES_QUERY,
  type PaymentTermsTemplatesResponse,
} from "@/src/lib/shopify/order-mutations";

export const COD_TEMPLATE_PREFERENCE = ["FULFILLMENT", "RECEIPT"] as const;

export interface CodPaymentTerms {
  templateId: string;
  templateType: string;
  templateName: string | null;
}

/**
 * `undefined` = not looked up yet. `null` = looked up and the shop has none.
 * Distinguishing them stops a shop with no usable template being re-queried on
 * every order.
 */
let cached: CodPaymentTerms | null | undefined;

/** Test seam, and a way for an operator to force a re-read after changing shop settings. */
export function __resetPaymentTermsCache(): void {
  cached = undefined;
}

export async function resolveCodPaymentTerms(log: Logger = logger): Promise<CodPaymentTerms | null> {
  if (cached !== undefined) return cached;

  const { data } = await shopifyGraphQL<PaymentTermsTemplatesResponse>(
    PAYMENT_TERMS_TEMPLATES_QUERY,
    { operation: "PaymentTermsTemplates", log },
  );

  const templates = data.paymentTermsTemplates ?? [];

  for (const wanted of COD_TEMPLATE_PREFERENCE) {
    const match = templates.find((template) => template.paymentTermsType === wanted);
    if (match) {
      cached = { templateId: match.id, templateType: wanted, templateName: match.name };
      log.info(
        {
          event: "cod_payment_terms_resolved",
          templateType: wanted,
          templateName: match.name,
          // The id is shop configuration, not a secret, and it is the one field
          // that makes a wrong-terms bug diagnosable.
          templateId: match.id,
        },
        "resolved the payment terms used for cash on delivery",
      );
      return cached;
    }
  }

  // Not a failure. A draft with no payment terms is still a correct draft; it
  // just does not carry a due date, so the merchant sees an unpaid order without
  // one. Refusing to submit the customer's order over a missing template would be
  // a far worse outcome than a missing due date.
  cached = null;
  log.warn(
    {
      event: "cod_payment_terms_unavailable",
      availableTypes: [...new Set(templates.map((t) => t.paymentTermsType))].filter(Boolean),
    },
    "no 'due on fulfillment' or 'due on receipt' payment terms template on this shop; " +
      "drafts will be created without payment terms",
  );
  return cached;
}
