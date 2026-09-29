/**
 * Draft order mutations, for cash-on-delivery submission.
 *
 * Kept apart from queries.ts because that module is the catalog READ path and
 * this one writes. The field names here were confirmed by introspecting the
 * pinned API version (2026-07) rather than written from memory -- three of them
 * would have been wrong:
 *
 *   - `draftOrderComplete(paymentPending:)` is DEPRECATED ("create a draft with
 *     payment terms rather than marking the draft as pending"), so COD is
 *     expressed as payment terms on the draft instead. See payment-terms.ts.
 *   - a variant line item's explicit price is `priceOverride: MoneyInput`.
 *     `originalUnitPrice` and `originalUnitPriceWithCurrency` are documented as
 *     "ignored when `variantId` is provided" -- they are for custom line items.
 *   - `ShippingLineInput.price` is deprecated in favour of `priceWithCurrency`.
 *
 * The whole input was then validated against the live API with
 * `draftOrderCalculate`, which prices a draft without persisting one. That is
 * also what caught the tag-length bug documented on `submissionTag` below -- a
 * defect that would have failed every order permanently.
 *
 * Selections are deliberately narrow and carry NO customer fields. Nothing is
 * gained by asking Shopify to echo back an address the database already holds,
 * and a narrow selection needs no protected-customer-data access on the read
 * side at all.
 */

/**
 * Phase 1: create the draft.
 *
 * `tags` carries the submission tag (see `submissionTag`), which is what makes a
 * lost response recoverable: the pre-flight below can find a draft this app
 * created even when the response that would have reported its id never arrived.
 */
export const DRAFT_ORDER_CREATE_MUTATION = /* GraphQL */ `
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        status
        order {
          id
          name
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Phase 2: complete it.
 *
 * No `paymentGatewayId`: nothing was charged, and passing a gateway would record a
 * payment that does not exist.
 *
 * `paymentPending` is a VARIABLE rather than a literal because the two ways to say
 * "unpaid" are selected by configuration (see `env.codPaymentMode`): either the
 * draft carries payment terms and this stays null, or it does not and this is
 * true. Passing `true` while the draft also has payment terms would be two
 * mechanisms for one fact.
 */
export const DRAFT_ORDER_COMPLETE_MUTATION = /* GraphQL */ `
  mutation DraftOrderComplete($id: ID!, $paymentPending: Boolean) {
    draftOrderComplete(id: $id, paymentPending: $paymentPending) {
      draftOrder {
        id
        name
        status
        order {
          id
          name
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Did this draft already become an order?
 *
 * An exact lookup by the id this system persisted, which is strictly stronger
 * than a tag search: it answers "is my draft complete" rather than "does a draft
 * matching this description exist". Used before completing, so a lost
 * `draftOrderComplete` response adopts the order it created instead of
 * completing twice.
 */
export const DRAFT_ORDER_BY_ID_QUERY = /* GraphQL */ `
  query DraftOrderById($id: ID!) {
    draftOrder(id: $id) {
      id
      name
      status
      order {
        id
        name
      }
    }
  }
`;

/**
 * The pre-flight for a lost `draftOrderCreate` response.
 *
 * Only reachable when `shopifyDraftOrderId` is null but a draft may exist
 * anyway: the mutation succeeded and the response was lost. Searching by the
 * submission key's tag finds it. `first: 2` rather than 1 so the impossible case
 * -- two drafts sharing one submission key -- is detectable rather than silently
 * resolved to whichever came back first.
 */
export const DRAFT_ORDERS_BY_TAG_QUERY = /* GraphQL */ `
  query DraftOrdersByTag($query: String!) {
    draftOrders(first: 2, query: $query) {
      nodes {
        id
        name
        status
        order {
          id
          name
        }
      }
    }
  }
`;

/**
 * The shop's payment terms templates.
 *
 * Queried once per process to find the template that means "pay when it
 * arrives". Hard-coding the gid would be wrong: template ids are per shop.
 */
export const PAYMENT_TERMS_TEMPLATES_QUERY = /* GraphQL */ `
  query PaymentTermsTemplates {
    paymentTermsTemplates {
      id
      name
      paymentTermsType
      dueInDays
    }
  }
`;

// ---------------------------------------------------------------------------
// response shapes
// ---------------------------------------------------------------------------

export interface ShopifyUserError {
  field: string[] | null;
  message: string;
}

export interface DraftOrderNode {
  id: string;
  name: string | null;
  status: string | null;
  order: { id: string; name: string | null } | null;
}

export interface DraftOrderCreateResponse {
  draftOrderCreate: {
    draftOrder: DraftOrderNode | null;
    userErrors: ShopifyUserError[];
  } | null;
}

export interface DraftOrderCompleteResponse {
  draftOrderComplete: {
    draftOrder: DraftOrderNode | null;
    userErrors: ShopifyUserError[];
  } | null;
}

export interface DraftOrderByIdResponse {
  draftOrder: DraftOrderNode | null;
}

export interface DraftOrdersByTagResponse {
  draftOrders: { nodes: DraftOrderNode[] } | null;
}

export interface PaymentTermsTemplatesResponse {
  paymentTermsTemplates: Array<{
    id: string;
    name: string | null;
    paymentTermsType: string | null;
    dueInDays: number | null;
  }> | null;
}

/**
 * Shopify rejects a tag longer than this, as a `userErrors` entry on
 * `draftOrderCreate` -- which this project classifies as PERMANENT. An
 * over-long tag therefore fails every order, immediately and unretryably.
 */
export const MAX_TAG_LENGTH = 40;

const TAG_PREFIX = "cod-";

/**
 * The tag that ties a draft to one local submission attempt.
 *
 * The compaction is not cosmetic. `cod-` + a 36-character `randomUUID()` is
 * EXACTLY 40 characters: the original `cod-${submissionKey}` sat precisely on
 * Shopify's limit with zero margin, so any later change -- a longer prefix, a
 * different key generator, or any key nearer the `VARCHAR(64)` column width --
 * would have failed every submission permanently. `draftOrderCalculate` caught it
 * with a 44-character probe key: "Title Tag exceeds the maximum length of 40
 * characters".
 *
 * So the key's separators are stripped (a UUID becomes 32 hex characters, giving
 * 4 characters of headroom) and the result is truncated to fit whatever the
 * budget allows. Truncation cannot silently pick the wrong draft: two drafts
 * matching one tag is the `duplicate_submission_key` case, which refuses rather
 * than guessing, and the exact key is also carried as a custom attribute.
 *
 * Both the writer and the tag search call this, so they cannot disagree.
 */
export function submissionTag(submissionKey: string): string {
  const compact = submissionKey.replace(/[^A-Za-z0-9]/g, "");
  return `${TAG_PREFIX}${compact.slice(0, MAX_TAG_LENGTH - TAG_PREFIX.length)}`;
}

/**
 * The `query:` argument for the tag pre-flight.
 *
 * Quoted, because an unquoted hyphen is a negation operator in Shopify's search
 * syntax -- `tag:cod-abc-def` would parse as "tagged cod-abc, not def" and
 * quietly find nothing. The quoting is kept even though `submissionTag` now
 * strips hyphens from the key: the `cod-` prefix still contains one.
 */
export function submissionTagQuery(submissionKey: string): string {
  return `tag:"${submissionTag(submissionKey)}"`;
}
