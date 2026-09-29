/**
 * The order submission state machine, as database operations.
 *
 *   PENDING_SYNC ──claim──> SYNCING ──draft created──> DRAFT_CREATED
 *                                                          │
 *                                              ┌───claim────┘
 *                                              ▼
 *                                           SYNCING ──completed──> SYNCED
 *                                              │
 *                                              └──permanent/exhausted──> FAILED
 *
 * Every transition here is a CONDITIONAL update -- `updateMany` with the expected
 * state in the WHERE clause -- not a read followed by a write. That is the whole
 * mechanism by which two workers cannot submit one order twice: both may read
 * PENDING_SYNC, but only one `UPDATE ... WHERE status = 'PENDING_SYNC'` affects a
 * row. The loser sees `count: 0` and stops.
 *
 * The claim is a LEASE, not a latch. A worker that dies mid-submission leaves a
 * SYNCING row nobody will ever finish, so a claim older than the lease is
 * reclaimable. Without that, one crash strands an order forever.
 */
import type { OrderStatus, Prisma, PrismaClient } from "@/src/generated/prisma";
import { env } from "@/src/lib/env";

/** Transaction client or the client itself -- every function here works with both. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The statuses a submission may be claimed from.
 *
 * DRAFT_CREATED is included because it is a resumable checkpoint, not a failure:
 * the draft exists and completion is what remains. FAILED is included so an
 * operator (or a later reconcile) can retry a failed order without a manual
 * status edit. SYNCED is deliberately absent -- there is nothing left to do, and
 * a claim would be the first step toward a duplicate.
 */
export const CLAIMABLE_STATUSES: OrderStatus[] = ["PENDING_SYNC", "DRAFT_CREATED", "FAILED"];

export interface ClaimedOrder {
  id: string;
  reference: string;
  submissionKey: string;
  /** The status the order was in when this attempt claimed it. */
  startStatus: OrderStatus;
  attempt: number;
  shopifyDraftOrderId: string | null;
  shopifyOrderId: string | null;
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
  items: Array<{
    shopifyVariantId: string;
    quantity: number;
    unitPrice: string;
  }>;
}

export type ClaimOutcome =
  /** This worker holds the lease and must do the work. */
  | { kind: "claimed"; order: ClaimedOrder }
  /** Already submitted. Nothing to do, and saying so is not an error. */
  | { kind: "already_synced"; shopifyOrderId: string }
  /** Another worker holds a live claim. Leave it alone. */
  | { kind: "held_elsewhere"; status: OrderStatus }
  /** No such order -- a stale queued job naming a row that no longer exists. */
  | { kind: "not_found" };

function leaseCutoff(now: Date): Date {
  return new Date(now.getTime() - env.orderClaimLeaseSeconds * 1000);
}

/**
 * Claim an order for submission.
 *
 * The WHERE clause is the concurrency control, and it says: claimable status, OR
 * SYNCING with an expired lease. Two workers issuing this UPDATE at the same
 * moment serialize on the row in InnoDB; the second one's WHERE no longer matches
 * -- the status is now SYNCING with a fresh `claimedAt` -- so it affects zero
 * rows and backs off.
 *
 * `attempt` is incremented here rather than in the processor so the count
 * survives a crash: it records claims, which is what "how many times has this
 * been tried" actually means.
 */
export async function claimOrderForSubmission(
  db: Db,
  orderId: string,
  now: Date = new Date(),
): Promise<ClaimOutcome> {
  const claimed = await db.order.updateMany({
    where: {
      id: orderId,
      OR: [
        { status: { in: CLAIMABLE_STATUSES } },
        // A dead worker's claim. `claimedAt: null` is impossible for a SYNCING
        // row -- the claim always sets it -- but the predicate is written so a
        // null could never be mistaken for "expired long ago".
        { status: "SYNCING", claimedAt: { lt: leaseCutoff(now) } },
      ],
    },
    data: { status: "SYNCING", claimedAt: now, attempt: { increment: 1 } },
  });

  if (claimed.count === 1) {
    const order = await loadClaimedOrder(db, orderId);
    return order ? { kind: "claimed", order } : { kind: "not_found" };
  }

  // The claim failed. Why it failed decides whether that is fine or a problem,
  // so the current state is read -- AFTER the attempt, not before, because a
  // read-then-claim is the race this design exists to avoid.
  const current = await db.order.findUnique({
    where: { id: orderId },
    select: { status: true, shopifyOrderId: true },
  });

  if (!current) return { kind: "not_found" };
  if (current.status === "SYNCED" && current.shopifyOrderId) {
    return { kind: "already_synced", shopifyOrderId: current.shopifyOrderId };
  }
  return { kind: "held_elsewhere", status: current.status };
}

/**
 * Everything the submission needs, and nothing it does not.
 *
 * `startStatus` is reconstructed from the claim rather than re-read: by the time
 * this runs the row says SYNCING, so the status the attempt began in has to come
 * from somewhere else. It is derived from what is on the row -- a draft id means
 * the checkpoint was reached -- which is the same fact the resume logic uses.
 */
async function loadClaimedOrder(db: Db, orderId: string): Promise<ClaimedOrder | null> {
  const row = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      reference: true,
      submissionKey: true,
      attempt: true,
      shopifyDraftOrderId: true,
      shopifyOrderId: true,
      currencyCode: true,
      customerName: true,
      customerPhone: true,
      customerEmail: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      province: true,
      postalCode: true,
      countryCode: true,
      customerNote: true,
      items: {
        select: { shopifyVariantId: true, quantity: true, unitPrice: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!row) return null;

  return {
    ...row,
    startStatus: row.shopifyDraftOrderId ? "DRAFT_CREATED" : "PENDING_SYNC",
    items: row.items.map((item) => ({
      shopifyVariantId: item.shopifyVariantId,
      quantity: item.quantity,
      // Exact decimal string. A Decimal must never reach a JSON body as a number.
      unitPrice: item.unitPrice.toString(),
    })),
  };
}

/**
 * The durable checkpoint: a draft exists.
 *
 * Written IMMEDIATELY after `draftOrderCreate` returns, before completion is
 * attempted, and this is the single most important write in the phase. Between
 * the draft existing in Shopify and its id existing in MySQL, a crash produces an
 * orphan draft that a retry cannot find by id -- which is why the tag pre-flight
 * exists as the second line of defence.
 *
 * Conditional on the claim still being held: a worker whose lease expired and
 * whose order was reclaimed must not write its stale draft id over the new
 * claim's.
 */
export async function recordDraftCreated(
  db: Db,
  orderId: string,
  shopifyDraftOrderId: string,
  claimedAt: Date,
): Promise<boolean> {
  const updated = await db.order.updateMany({
    where: { id: orderId, status: "SYNCING", claimedAt },
    data: { status: "DRAFT_CREATED", shopifyDraftOrderId, failureReason: null, lastError: null },
  });
  return updated.count === 1;
}

/**
 * Terminal success.
 *
 * Accepts SYNCING or DRAFT_CREATED as the prior state: the completion may follow
 * the checkpoint in this attempt, or be adopted from a draft that turned out to
 * already have an order (a lost response).
 */
export async function recordSynced(
  db: Db,
  orderId: string,
  shopify: { orderId: string; orderName: string | null; draftOrderId: string },
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db.order.updateMany({
    where: { id: orderId, status: { in: ["SYNCING", "DRAFT_CREATED"] } },
    data: {
      status: "SYNCED",
      shopifyOrderId: shopify.orderId,
      shopifyOrderName: shopify.orderName,
      shopifyDraftOrderId: shopify.draftOrderId,
      submittedAt: now,
      claimedAt: null,
      failureReason: null,
      lastError: null,
    },
  });
  return updated.count === 1;
}

/**
 * Terminal failure.
 *
 * The lease is released (`claimedAt: null`) so the row is not left looking
 * claimed, and the draft id is KEPT: if a draft was created before the failure it
 * still exists in Shopify, and an operator retry must resume it rather than
 * create a second one.
 *
 * `failureReason` is a short classification for an operator list; `lastError` is
 * the detail. Neither may contain customer data -- both come from the Shopify
 * error, never from the order.
 */
export async function recordFailed(
  db: Db,
  orderId: string,
  failure: { reason: string; detail: string },
): Promise<boolean> {
  const updated = await db.order.updateMany({
    where: { id: orderId, status: { in: ["SYNCING", "DRAFT_CREATED"] } },
    data: {
      status: "FAILED",
      claimedAt: null,
      failureReason: failure.reason.slice(0, 128),
      lastError: failure.detail.slice(0, 60_000),
    },
  });
  return updated.count === 1;
}

/**
 * Release a claim without a verdict.
 *
 * For a retryable failure: the attempt did not work, BullMQ will try again, and
 * the order should go back to a state the next attempt can claim. It returns to
 * DRAFT_CREATED when a draft exists and PENDING_SYNC when it does not, so the
 * status always describes how far the work actually got.
 */
export async function releaseClaim(db: Db, orderId: string, claimedAt: Date): Promise<OrderStatus | null> {
  const row = await db.order.findUnique({
    where: { id: orderId },
    select: { shopifyDraftOrderId: true },
  });
  if (!row) return null;

  const next: OrderStatus = row.shopifyDraftOrderId ? "DRAFT_CREATED" : "PENDING_SYNC";

  const updated = await db.order.updateMany({
    where: { id: orderId, status: "SYNCING", claimedAt },
    data: { status: next, claimedAt: null },
  });

  return updated.count === 1 ? next : null;
}

/** The current status, for a JobLog end-status field. */
export async function readStatus(db: Db, orderId: string): Promise<OrderStatus | null> {
  const row = await db.order.findUnique({ where: { id: orderId }, select: { status: true } });
  return row?.status ?? null;
}

// ---------------------------------------------------------------------------
// recovery
// ---------------------------------------------------------------------------

export interface RecoverableOrder {
  id: string;
  reference: string;
  status: OrderStatus;
}

/**
 * Orders that should be on the queue and may not be.
 *
 * Two populations, one query:
 *
 *   PENDING_SYNC older than the grace period -- the enqueue after checkout
 *   failed (Redis was down), or Redis was flushed. The Order row IS the outbox
 *   (ARCHITECTURE 4.1), so this query is the outbox drain.
 *
 *   DRAFT_CREATED older than the grace period -- a draft exists and completion
 *   never happened, because the process died between the two phases.
 *
 * The grace period matters: an order committed a millisecond ago has an enqueue
 * still in flight, and sweeping it would race the normal path. The stable
 * `jobId` makes that race harmless, but not sweeping it at all is better.
 */
export async function findOrdersNeedingSubmission(
  db: Db,
  options: { limit?: number; now?: Date } = {},
): Promise<RecoverableOrder[]> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - env.orderRecoveryGraceSeconds * 1000);

  return db.order.findMany({
    where: {
      status: { in: ["PENDING_SYNC", "DRAFT_CREATED"] },
      createdAt: { lt: cutoff },
    },
    select: { id: true, reference: true, status: true },
    // Oldest first: a customer who has been waiting longest is served first.
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 50,
  });
}

/**
 * Orders stuck in SYNCING with an expired lease.
 *
 * Separate from the query above because the diagnosis differs: these are not
 * un-enqueued, they are abandoned mid-flight by a worker that died. The claim
 * logic can reclaim them directly, so all this does is find them to be
 * re-enqueued.
 */
export async function findExpiredClaims(
  db: Db,
  options: { limit?: number; now?: Date } = {},
): Promise<RecoverableOrder[]> {
  const now = options.now ?? new Date();

  return db.order.findMany({
    where: { status: "SYNCING", claimedAt: { lt: leaseCutoff(now) } },
    select: { id: true, reference: true, status: true },
    orderBy: { claimedAt: "asc" },
    take: options.limit ?? 50,
  });
}
