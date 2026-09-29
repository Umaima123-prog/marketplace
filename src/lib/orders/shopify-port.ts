/**
 * The real ShopifyPort: GraphQL calls plus the one classification that matters.
 *
 * `userErrors` are translated into PermanentSubmissionError here, at the
 * boundary, rather than being returned for the caller to inspect. That is the
 * whole reason this layer exists: a mutation that returns HTTP 200 with a
 * populated `userErrors` array is a REFUSAL, and refusals do not become
 * acceptances on the third attempt. Retrying one burns five attempts and 40
 * seconds of backoff to arrive at the same answer, with the operator finding out
 * last.
 *
 * Transport failures, 429s and 5xx never reach this file's judgement -- the
 * GraphQL client already raises them as retryable ShopifyError.
 */
import { env } from "@/src/lib/env";
import { logger, type Logger } from "@/src/lib/logger";
import { shopifyGraphQL } from "@/src/lib/shopify/client";
import {
  DRAFT_ORDERS_BY_TAG_QUERY,
  DRAFT_ORDER_BY_ID_QUERY,
  DRAFT_ORDER_COMPLETE_MUTATION,
  DRAFT_ORDER_CREATE_MUTATION,
  type DraftOrderByIdResponse,
  type DraftOrderCompleteResponse,
  type DraftOrderCreateResponse,
  type DraftOrderNode,
  type DraftOrdersByTagResponse,
  type ShopifyUserError,
} from "@/src/lib/shopify/order-mutations";

import type { DraftOrderInput } from "./draft-order-input";
import { resolveCodPaymentTerms } from "./payment-terms";
import { PermanentSubmissionError, type ShopifyPort } from "./submit-order";

/**
 * Renders userErrors for a log line and a `lastError` column.
 *
 * Field paths and messages only. A userError message is Shopify's own text about
 * what it refused ("Variant does not exist"); it is not customer data, and the
 * input that caused it is deliberately not included.
 */
function describeUserErrors(errors: ShopifyUserError[]): string {
  return errors
    .map((error) => {
      const path = (error.field ?? []).join(".");
      return path ? `${path}: ${error.message}` : error.message;
    })
    .join("; ");
}

/**
 * Shopify's wording when the token may not set payment terms. Recognised so the
 * failure reason names the actual cause instead of a generic user error -- this one
 * cost a live order attempt, and `draftOrderCalculate` accepts the same input, so
 * nothing short of the real mutation reveals it.
 */
const PAYMENT_TERMS_FORBIDDEN = /access to set payment terms/i;

function assertNoUserErrors(reason: string, errors: ShopifyUserError[] | undefined): void {
  if (!errors || errors.length === 0) return;

  const description = describeUserErrors(errors);

  if (PAYMENT_TERMS_FORBIDDEN.test(description)) {
    throw new PermanentSubmissionError(
      "payment_terms_forbidden",
      `${description} -- set SHOPIFY_COD_PAYMENT_MODE=payment_pending, or grant the app permission to set payment terms`,
    );
  }

  throw new PermanentSubmissionError(reason, description);
}

export function createShopifyPort(log: Logger = logger): ShopifyPort {
  return {
    async createDraftOrder(input: DraftOrderInput): Promise<DraftOrderNode> {
      const { data } = await shopifyGraphQL<DraftOrderCreateResponse>(DRAFT_ORDER_CREATE_MUTATION, {
        operation: "DraftOrderCreate",
        variables: { input },
        log,
        // One attempt inside the call. The client's internal retry is for
        // throttles and transport blips, and it is safe for a READ; for a
        // mutation that creates something, an inline retry after an ambiguous
        // failure risks two drafts. Retrying is BullMQ's job, and by then the tag
        // pre-flight is there to notice the first draft.
        maxAttempts: 1,
      });

      const payload = data.draftOrderCreate;
      if (!payload) {
        throw new PermanentSubmissionError("create_no_payload", "draftOrderCreate returned no payload");
      }

      assertNoUserErrors("draft_create_user_error", payload.userErrors);

      if (!payload.draftOrder) {
        throw new PermanentSubmissionError(
          "create_no_draft",
          "draftOrderCreate reported no userErrors and no draft order",
        );
      }

      return payload.draftOrder;
    },

    async completeDraftOrder(draftOrderId: string): Promise<DraftOrderNode> {
      // Exactly one of the two "unpaid" mechanisms. In payment_terms mode the
      // draft already carries the terms, so this stays null; in payment_pending
      // mode the draft carries nothing and this is what makes the resulting order
      // unpaid.
      const paymentPending = env.codPaymentMode === "payment_pending" ? true : null;

      const { data } = await shopifyGraphQL<DraftOrderCompleteResponse>(
        DRAFT_ORDER_COMPLETE_MUTATION,
        {
          operation: "DraftOrderComplete",
          variables: { id: draftOrderId, paymentPending },
          log,
          // As above, and more so: this is the mutation that creates the real
          // order a courier will deliver.
          maxAttempts: 1,
        },
      );

      const payload = data.draftOrderComplete;
      if (!payload) {
        throw new PermanentSubmissionError(
          "complete_no_payload",
          "draftOrderComplete returned no payload",
        );
      }

      assertNoUserErrors("draft_complete_user_error", payload.userErrors);

      if (!payload.draftOrder) {
        throw new PermanentSubmissionError(
          "complete_no_draft",
          "draftOrderComplete reported no userErrors and no draft order",
        );
      }

      return payload.draftOrder;
    },

    async getDraftOrder(draftOrderId: string): Promise<DraftOrderNode | null> {
      const { data } = await shopifyGraphQL<DraftOrderByIdResponse>(DRAFT_ORDER_BY_ID_QUERY, {
        operation: "DraftOrderById",
        variables: { id: draftOrderId },
        log,
      });
      return data.draftOrder ?? null;
    },

    async findDraftOrdersByQuery(query: string): Promise<DraftOrderNode[]> {
      const { data } = await shopifyGraphQL<DraftOrdersByTagResponse>(DRAFT_ORDERS_BY_TAG_QUERY, {
        operation: "DraftOrdersByTag",
        variables: { query },
        log,
      });
      return data.draftOrders?.nodes ?? [];
    },

    async resolvePaymentTermsTemplateId(): Promise<string | undefined> {
      // In payment_pending mode the draft must NOT carry payment terms: setting
      // them needs a permission this app lacks, and `draftOrderCreate` refuses
      // the whole mutation with "The user must have access to set payment terms."
      // Returning undefined here is what keeps them off the draft -- and it also
      // avoids spending a Shopify call to look up a template that will not be
      // used.
      if (env.codPaymentMode !== "payment_terms") return undefined;

      const terms = await resolveCodPaymentTerms(log);
      return terms?.templateId;
    },
  };
}
