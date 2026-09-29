/**
 * The two-phase draft order submission (ARCHITECTURE 4.2).
 *
 *   Phase 1  ensure exactly one draft exists, and persist its id IMMEDIATELY
 *   Phase 2  complete that draft into an order, and persist the order id
 *
 * The phases are separate because their failure modes are worth different
 * amounts. A stranded draft is garbage: inert, decrements no inventory, invisible
 * to the customer, sweepable. A duplicated ORDER is a second parcel and a second
 * cash collection. So all the uncertainty is pushed into phase 1, where a mistake
 * is cheap, and phase 2 is keyed by an id this system already stored.
 *
 * Shopify is injected as `ShopifyPort` rather than imported. Every test in this
 * phase drives the real state machine against real MySQL with a fake port -- no
 * test creates a Shopify order, and no test asserts against a mock of our own
 * database logic.
 */
import type { PrismaClient } from "@/src/generated/prisma";
import { errorFields, type Logger } from "@/src/lib/logger";
import { ShopifyError } from "@/src/lib/shopify/errors";
import { submissionTagQuery, type DraftOrderNode } from "@/src/lib/shopify/order-mutations";

import { buildDraftOrderInput, type DraftOrderInput } from "./draft-order-input";
import {
  claimOrderForSubmission,
  readStatus,
  recordDraftCreated,
  recordFailed,
  recordSynced,
  releaseClaim,
  type ClaimedOrder,
} from "./order-repo";

/**
 * The Shopify operations a submission needs.
 *
 * An interface rather than direct calls so the processor can be exercised
 * end-to-end without the network. The implementation is in shopify-port.ts; this
 * module never imports the GraphQL client.
 */
export interface ShopifyPort {
  createDraftOrder(input: DraftOrderInput): Promise<DraftOrderNode>;
  completeDraftOrder(draftOrderId: string): Promise<DraftOrderNode>;
  getDraftOrder(draftOrderId: string): Promise<DraftOrderNode | null>;
  findDraftOrdersByQuery(query: string): Promise<DraftOrderNode[]>;
  resolvePaymentTermsTemplateId(): Promise<string | undefined>;
}

export type SubmitOutcome =
  | { kind: "synced"; shopifyOrderId: string; shopifyOrderName: string | null; startStatus: string; replayed: boolean }
  | { kind: "already_synced"; shopifyOrderId: string }
  | { kind: "held_elsewhere"; status: string }
  | { kind: "not_found" }
  | { kind: "failed"; reason: string; retryable: boolean; startStatus: string };

export interface SubmitContext {
  prisma: PrismaClient;
  shopify: ShopifyPort;
  log: Logger;
  /** Whether BullMQ has attempts left. Decides release-for-retry vs mark FAILED. */
  willRetry: boolean;
}

/**
 * A failure the submission itself declares terminal.
 *
 * `userErrors` from a mutation are the archetype: the request was well-formed,
 * Shopify understood it, and refused. "Variant does not exist", "price is
 * invalid" -- none of those succeed unchanged, and retrying them five times with
 * exponential backoff just delays the operator finding out.
 */
export class PermanentSubmissionError extends Error {
  readonly reason: string;
  readonly retryable = false;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "PermanentSubmissionError";
    this.reason = reason;
  }
}

export function isPermanent(error: unknown): boolean {
  if (error instanceof PermanentSubmissionError) return true;
  if (error instanceof ShopifyError) return !error.retryable;
  return false;
}

/**
 * Submit one order. Idempotent at every step.
 *
 * Returns rather than throws for the states that are not this worker's problem
 * (already synced, held elsewhere, missing). Throws for retryable failures,
 * because throwing is how BullMQ is told to retry -- and the throw happens only
 * after the order row has been put back into a claimable state.
 */
export async function submitOrder(orderId: string, context: SubmitContext): Promise<SubmitOutcome> {
  const { prisma, log } = context;

  const claim = await claimOrderForSubmission(prisma, orderId);

  if (claim.kind === "not_found") {
    // A queued job naming an order that does not exist. Nothing to retry.
    log.warn({ event: "submit_order_missing", orderId }, "no such order; dropping the job");
    return { kind: "not_found" };
  }

  if (claim.kind === "already_synced") {
    // The SYNCED no-op. Reached by a duplicate job, a sweep that raced the normal
    // path, or a stalled-job re-delivery. Success, not an error.
    log.info(
      { event: "submit_order_noop", orderId, shopifyOrderId: claim.shopifyOrderId },
      "order is already synced; nothing to do",
    );
    return { kind: "already_synced", shopifyOrderId: claim.shopifyOrderId };
  }

  if (claim.kind === "held_elsewhere") {
    // Another worker holds a live lease. Returning success is correct: this job
    // has nothing to do, and failing it would retry against a healthy claim.
    log.info(
      { event: "submit_order_held", orderId, status: claim.status },
      "another worker holds a live claim on this order",
    );
    return { kind: "held_elsewhere", status: claim.status };
  }

  const order = claim.order;
  const claimedAt = await claimTimestamp(prisma, orderId);

  log.info(
    {
      event: "submit_order_claimed",
      orderId,
      attempt: order.attempt,
      startStatus: order.startStatus,
      hasDraft: order.shopifyDraftOrderId !== null,
      itemCount: order.items.length,
    },
    "claimed order for submission",
  );

  try {
    // ---- Phase 1: exactly one draft ------------------------------------
    const draftOrderId = await ensureDraft(order, context, claimedAt);

    // ---- Phase 2: complete it ------------------------------------------
    const completed = await completeDraft(draftOrderId, context);

    if (!completed.order?.id) {
      // Completion reported success without an order. Terminal: retrying cannot
      // invent the order id, and treating it as success would mark an order
      // SYNCED with nothing to point at.
      throw new PermanentSubmissionError(
        "complete_without_order",
        "draftOrderComplete returned no order id",
      );
    }

    const synced = await recordSynced(prisma, orderId, {
      orderId: completed.order.id,
      orderName: completed.order.name,
      draftOrderId,
    });

    if (!synced) {
      // The row moved under us -- the lease expired and another worker finished
      // it. The order IS synced; this attempt simply was not the one that
      // recorded it. Not an error, and emphatically not something to retry.
      const status = await readStatus(prisma, orderId);
      log.warn(
        { event: "submit_order_lost_race", orderId, status },
        "could not record SYNCED; another attempt finished this order first",
      );
      return { kind: "already_synced", shopifyOrderId: completed.order.id };
    }

    log.info(
      {
        event: "submit_order_synced",
        orderId,
        shopifyOrderId: completed.order.id,
        shopifyOrderName: completed.order.name,
        startStatus: order.startStatus,
      },
      "order submitted to Shopify",
    );

    return {
      kind: "synced",
      shopifyOrderId: completed.order.id,
      shopifyOrderName: completed.order.name,
      startStatus: order.startStatus,
      replayed: order.startStatus === "DRAFT_CREATED",
    };
  } catch (error) {
    const permanent = isPermanent(error);
    const terminal = permanent || !context.willRetry;
    const fields = errorFields(error);

    if (terminal) {
      // FAILED keeps shopifyDraftOrderId: the draft may exist, and an operator
      // retry must resume it rather than create a second one.
      await recordFailed(prisma, orderId, {
        reason: permanent ? reasonOf(error) : "attempts_exhausted",
        detail: [fields.errorMessage, fields.stack].filter(Boolean).join("\n\n"),
      });

      log.error(
        {
          event: "submit_order_failed_terminal",
          orderId,
          startStatus: order.startStatus,
          permanent,
          ...shopifyLogFields(error),
        },
        permanent ? "submission permanently failed" : "submission failed and attempts are exhausted",
      );

      return {
        kind: "failed",
        reason: permanent ? reasonOf(error) : "attempts_exhausted",
        retryable: false,
        startStatus: order.startStatus,
      };
    }

    // Retryable: put the row back where the next attempt can claim it, THEN
    // rethrow so BullMQ schedules the retry. Order matters -- throwing first
    // would leave the row SYNCING until its lease expired, delaying the retry by
    // the whole lease window.
    const released = await releaseClaim(prisma, orderId, claimedAt);
    log.warn(
      {
        event: "submit_order_failed_retryable",
        orderId,
        startStatus: order.startStatus,
        releasedTo: released,
        ...shopifyLogFields(error),
      },
      "submission failed; released the claim for retry",
    );
    throw error;
  }
}

/**
 * Phase 1. Returns a draft order id, creating one only if none can be found.
 *
 * Three ways to already have a draft, in decreasing order of confidence:
 *   1. `shopifyDraftOrderId` on the row -- the checkpoint was reached.
 *   2. a draft tagged with this submission key -- the mutation succeeded and its
 *      response was lost before step 1 could run.
 *   3. neither -- create one.
 */
async function ensureDraft(
  order: ClaimedOrder,
  context: SubmitContext,
  claimedAt: Date,
): Promise<string> {
  const { prisma, shopify, log } = context;

  // 1. The stored checkpoint. Trusted without a round trip: this system wrote it.
  if (order.shopifyDraftOrderId) {
    log.info(
      { event: "submit_order_resume", orderId: order.id, shopifyDraftOrderId: order.shopifyDraftOrderId },
      "resuming at completion; the draft already exists",
    );
    return order.shopifyDraftOrderId;
  }

  // 2. The lost-response pre-flight. Only reachable when no id is stored, which
  //    is exactly the window where a created draft is invisible to us.
  const existing = await shopify.findDraftOrdersByQuery(submissionTagQuery(order.submissionKey));

  if (existing.length > 1) {
    // Impossible unless the submission key was reused, which would mean the
    // uniqueness guarantee is broken. Refusing is safer than picking one.
    throw new PermanentSubmissionError(
      "duplicate_submission_key",
      `found ${existing.length} drafts tagged with one submission key`,
    );
  }

  if (existing.length === 1) {
    const found = existing[0];
    log.warn(
      { event: "submit_order_draft_recovered", orderId: order.id, shopifyDraftOrderId: found.id },
      "found an existing draft by submission tag; a previous create response was lost",
    );
    await recordDraftCreated(prisma, order.id, found.id, claimedAt);
    return found.id;
  }

  // 3. Create it.
  const paymentTermsTemplateId = await shopify.resolvePaymentTermsTemplateId();
  const input = buildDraftOrderInput(order, { paymentTermsTemplateId });

  const draft = await shopify.createDraftOrder(input);

  if (!draft.id) {
    throw new PermanentSubmissionError("create_without_id", "draftOrderCreate returned no draft id");
  }

  // THE critical write. Persisted before completion is attempted, so a crash
  // between the two phases leaves a resumable checkpoint rather than an orphan.
  const checkpointed = await recordDraftCreated(prisma, order.id, draft.id, claimedAt);

  if (!checkpointed) {
    // The lease expired mid-create and someone else claimed the order. The draft
    // is real but this attempt may not own the row any more. Terminal for this
    // attempt: the tag pre-flight will find the draft for whoever holds the
    // claim, so nothing is lost and nothing is duplicated.
    throw new PermanentSubmissionError(
      "checkpoint_lost_claim",
      "created a draft but the claim had already been taken over; the draft is recoverable by its tag",
    );
  }

  log.info(
    {
      event: "submit_order_draft_created",
      orderId: order.id,
      shopifyDraftOrderId: draft.id,
      paymentTerms: paymentTermsTemplateId ? "set" : "absent",
    },
    "draft order created and checkpointed",
  );

  return draft.id;
}

/**
 * Phase 2. Completes the draft, or adopts the order it already produced.
 *
 * The lookup first is the lost-response guard: `draftOrderComplete` may have
 * succeeded with its response lost, and completing an already-completed draft is
 * either an error or -- worse, if Shopify ever allowed it -- a second order.
 */
async function completeDraft(draftOrderId: string, context: SubmitContext): Promise<DraftOrderNode> {
  const { shopify, log } = context;

  const existing = await shopify.getDraftOrder(draftOrderId);

  if (existing?.order?.id) {
    log.warn(
      {
        event: "submit_order_complete_recovered",
        shopifyDraftOrderId: draftOrderId,
        shopifyOrderId: existing.order.id,
      },
      "the draft was already completed; adopting its order instead of completing again",
    );
    return existing;
  }

  if (existing === null) {
    // The stored draft id resolves to nothing: deleted in the admin, or from
    // another shop. Terminal -- a retry will look it up again and find the same
    // nothing.
    throw new PermanentSubmissionError(
      "draft_not_found",
      "the stored draft order id does not resolve to a draft order",
    );
  }

  return shopify.completeDraftOrder(draftOrderId);
}

/** The claim timestamp, read back so conditional writes can pin to this lease. */
async function claimTimestamp(prisma: PrismaClient, orderId: string): Promise<Date> {
  const row = await prisma.order.findUnique({
    where: { id: orderId },
    select: { claimedAt: true },
  });
  // Unreachable in practice: the claim set it. A fresh Date would simply fail
  // every conditional write, which is the safe direction.
  return row?.claimedAt ?? new Date(0);
}

function reasonOf(error: unknown): string {
  if (error instanceof PermanentSubmissionError) return error.reason;
  if (error instanceof ShopifyError) return `shopify_${error.kind}`;
  return "unknown";
}

/** Safe log fields only: no token, no request body, no customer data. */
function shopifyLogFields(error: unknown): Record<string, unknown> {
  if (error instanceof ShopifyError) return error.toLogFields();
  const fields = errorFields(error);
  return { errorClass: fields.errorClass, errorMessage: fields.errorMessage };
}
