/**
 * Sync decisions, extracted as pure functions.
 *
 * These are the rules that are easy to get wrong and expensive to get wrong:
 * whether to overwrite a row, whether a lock may be taken, and whether it is
 * safe to deactivate products. Keeping them free of Prisma and BullMQ means
 * each one can be tested exhaustively in milliseconds, which matters because
 * two of them can destroy a catalog if they answer "yes" too readily.
 */

export type SyncMode = "FULL" | "INCREMENTAL";
export type SyncRunStatus = "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";

/**
 * Should an incoming payload overwrite the stored row?
 *
 * Shopify does not guarantee ordering between a bulk page and a webhook, so a
 * page fetched 40 seconds ago can arrive after a webhook carrying newer data.
 * Comparing Shopify's own `updatedAt` is the only ordering that means anything;
 * our `syncedAt` measures when we happened to write, which is not the same.
 *
 * `>=` rather than `>`: a re-run of the same page must be able to repair a row
 * that was written from a partially-failed attempt, and an equal timestamp
 * means the same version of the truth, so applying it changes nothing.
 */
export function shouldApplyUpdate(incoming: Date, stored: Date | null | undefined): boolean {
  if (!stored) return true;
  return incoming.getTime() >= stored.getTime();
}

export interface RunLockCandidate {
  status: SyncRunStatus;
  heartbeatAt: Date;
}

/**
 * Is an existing RUNNING row abandoned, so its lock may be taken?
 *
 * A worker that is killed mid-page never clears `activeLock`, and the unique
 * index means nothing else can ever start. The heartbeat is what distinguishes
 * "still working" from "died holding the lock".
 *
 * The threshold must exceed p99 page duration, or a healthy slow run gets
 * reclaimed underneath itself and two runs write the same rows.
 */
export function isLockStale(run: RunLockCandidate, now: Date, staleAfterMs: number): boolean {
  if (run.status !== "RUNNING") return true;
  return now.getTime() - run.heartbeatAt.getTime() > staleAfterMs;
}

export interface SweepGateInput {
  mode: SyncMode;
  status: SyncRunStatus;
  /** Pages that failed during this run. */
  failures: number;
  /** True only when the product connection reported no further pages. */
  reachedLastPage: boolean;
}

/**
 * May this run deactivate products it did not see?
 *
 * The sweep is a set difference: "everything not stamped with this run id is
 * gone from Shopify". That statement is only true if the run actually saw the
 * whole catalog, so all four conditions are load-bearing:
 *
 *   - FULL only. An INCREMENTAL run filters by `updated_at`, so it never sees
 *     unchanged products -- sweeping after one would deactivate the entire
 *     catalog except whatever changed in the last 15 minutes.
 *   - COMPLETED only. A run that is still RUNNING has not finished looking.
 *   - Zero failures. One failed page is one page of products that exist and
 *     were not stamped.
 *   - Reached the last page. `hasNextPage === false` is the only proof the walk
 *     ran to the end rather than stopping early.
 *
 * This function returning true on a partial run is the single most destructive
 * bug available in this codebase, which is why it is 6 lines and tested
 * directly.
 */
export function canSweep(input: SweepGateInput): boolean {
  return (
    input.mode === "FULL" &&
    input.status === "COMPLETED" &&
    input.failures === 0 &&
    input.reachedLastPage
  );
}

/**
 * Is a stored product stale relative to the run that just completed?
 *
 * NULL-safe on purpose. In SQL, `last_sync_run_id != 'abc'` evaluates to NULL
 * for a row where the column is NULL, and NULL is not TRUE -- so a product that
 * has never been stamped would be silently skipped by the obvious predicate.
 * Every caller must express this as `(lastSyncRunId IS NULL OR lastSyncRunId != ?)`.
 */
export function isStaleAfterRun(lastSyncRunId: string | null, runId: string): boolean {
  return lastSyncRunId === null || lastSyncRunId !== runId;
}

/**
 * Variant completeness, from the fields the schema already carries.
 *
 * A product is complete when the inline page covered every variant, or when a
 * continuation chain ran to exhaustion. It is explicitly NOT complete while a
 * chain is in flight or after a chain failed -- `variantSyncComplete = false`
 * is a durable statement that the stored variant set is truncated, and the
 * storefront must treat it as such.
 */
export function variantSyncState(hasNextPage: boolean, endCursor: string | null): {
  variantSyncComplete: boolean;
  variantSyncCursor: string | null;
} {
  if (!hasNextPage) return { variantSyncComplete: true, variantSyncCursor: null };
  return { variantSyncComplete: false, variantSyncCursor: endCursor };
}

/**
 * The `updated_at` filter for an incremental run.
 *
 * The overlap is deliberate. Shopify's `updated_at` has second granularity and
 * its search index is eventually consistent, so a product modified in the same
 * second the last run finished can be missed by an exact boundary. Re-fetching
 * a few minutes of already-seen products is cheap; a permanently missed product
 * is invisible until the nightly full run.
 */
export const INCREMENTAL_OVERLAP_MS = 5 * 60 * 1000;

export function incrementalWatermark(
  lastCompletedAt: Date | null,
  now: Date,
  overlapMs = INCREMENTAL_OVERLAP_MS,
): Date | null {
  if (!lastCompletedAt) return null; // never completed -> behave as a full walk
  const candidate = new Date(lastCompletedAt.getTime() - overlapMs);
  return candidate.getTime() > now.getTime() ? now : candidate;
}

/** `updated_at:>=2026-09-29T05:00:00Z`, or null for an unfiltered walk. */
export function buildProductQueryFilter(watermark: Date | null): string | null {
  if (!watermark) return null;
  return `updated_at:>=${watermark.toISOString()}`;
}
