/**
 * Throttle arithmetic, kept pure so it can be tested without a network.
 *
 * Shopify's Admin GraphQL API is metered by *calculated query cost* against a
 * leaky bucket, not by request count. Every response carries the bucket state in
 * `extensions.cost`, which means a well-behaved client never has to discover the
 * limit by being rejected -- it can read the gauge and wait.
 */

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface QueryCost {
  requestedQueryCost: number;
  actualQueryCost?: number | null;
  throttleStatus: ThrottleStatus;
}

/** Shape check: `extensions.cost` is `unknown` until proven otherwise. */
export function parseCost(extensions: unknown): QueryCost | null {
  if (typeof extensions !== "object" || extensions === null) return null;
  const cost = (extensions as { cost?: unknown }).cost;
  if (typeof cost !== "object" || cost === null) return null;

  const { requestedQueryCost, actualQueryCost, throttleStatus } = cost as Record<string, unknown>;
  if (typeof requestedQueryCost !== "number") return null;
  if (typeof throttleStatus !== "object" || throttleStatus === null) return null;

  const { maximumAvailable, currentlyAvailable, restoreRate } = throttleStatus as Record<
    string,
    unknown
  >;
  if (
    typeof maximumAvailable !== "number" ||
    typeof currentlyAvailable !== "number" ||
    typeof restoreRate !== "number"
  ) {
    return null;
  }

  return {
    requestedQueryCost,
    actualQueryCost: typeof actualQueryCost === "number" ? actualQueryCost : null,
    throttleStatus: { maximumAvailable, currentlyAvailable, restoreRate },
  };
}

/**
 * How long to wait before a request of `nextCost` can succeed.
 *
 * Proactive: called after a SUCCESSFUL response, to decide whether the next call
 * should pause. Reacting to a THROTTLED error instead means every worker
 * discovers the limit by tripping it, which wastes a round trip and puts an
 * error in the log for a condition that is entirely predictable.
 *
 * Returns 0 when the bucket already holds enough.
 */
export function waitForCostMs(status: ThrottleStatus, nextCost: number): number {
  if (status.currentlyAvailable >= nextCost) return 0;
  if (status.restoreRate <= 0) return 0;

  const deficit = nextCost - status.currentlyAvailable;
  return Math.ceil((deficit / status.restoreRate) * 1000);
}

/**
 * Wait implied by a THROTTLED *error*, where the bucket is already empty.
 *
 * Capped: a pathological `restoreRate` should not park a worker for minutes
 * holding a BullMQ lock. Past the cap it is better to fail the attempt and let
 * the backoff schedule handle it, because backoff releases the lock.
 */
export const MAX_INLINE_THROTTLE_WAIT_MS = 10_000;

export function throttleRetryDelayMs(cost: QueryCost | null, requestedCost: number): number {
  if (!cost) return 1_000;
  const wait = waitForCostMs(cost.throttleStatus, requestedCost || cost.requestedQueryCost);
  return Math.min(Math.max(wait, 250), MAX_INLINE_THROTTLE_WAIT_MS);
}

/**
 * Exponential backoff with FULL jitter for transport failures.
 *
 * Full jitter, not "base * 2^n plus a little": when N page jobs fail at the same
 * instant (Shopify blips, and every in-flight page sees it), a deterministic
 * schedule makes all N retry at the same instant too. Randomising across the
 * whole interval is what actually spreads the retry storm.
 */
export function backoffMs(attempt: number, baseMs = 500, capMs = 30_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * ceiling);
}
