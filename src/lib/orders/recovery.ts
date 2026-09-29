/**
 * The outbox drain.
 *
 * There is no outbox table: the Order row IS the outbox (ARCHITECTURE 4.1), and
 * `status = PENDING_SYNC` means "needs submitting". This sweep is what makes that
 * claim true rather than aspirational. Without it, the enqueue after checkout is a
 * single point of failure -- Redis down for thirty seconds means an order that is
 * committed, paid for on delivery, and never sent to Shopify.
 *
 * Three populations, all recovered the same way -- by enqueueing a job with the
 * order's stable job id:
 *
 *   PENDING_SYNC  past the grace period   the enqueue was lost, or Redis was flushed
 *   DRAFT_CREATED past the grace period   the process died between the two phases
 *   SYNCING       past the lease          the worker holding it died
 *
 * Safety rests entirely on `jobId = order--<id>` plus the conditional claim: the
 * sweep cannot create a duplicate job, and even if it did, the claim would let
 * only one of them work. So the sweep is allowed to be dumb and frequent.
 */
import type { PrismaClient } from "@/src/generated/prisma";
import type { Logger } from "@/src/lib/logger";
import { errorFields } from "@/src/lib/logger";
import { enqueueSubmitOrder } from "@/src/lib/queues";

import { findExpiredClaims, findOrdersNeedingSubmission } from "./order-repo";

export interface RecoverySummary {
  pendingFound: number;
  expiredClaimsFound: number;
  enqueued: number;
  alreadyQueued: number;
  enqueueFailed: number;
}

export interface RecoveryOptions {
  limit?: number;
  now?: Date;
  /** Injectable for tests: the real one talks to Redis. */
  enqueue?: (
    orderId: string,
    options?: { replaceExisting?: boolean },
  ) => Promise<{ enqueued: boolean; removeError?: string }>;
}

/**
 * One sweep.
 *
 * Never throws: recovery is a background repair, and a failure to repair must not
 * take the worker down. Everything is counted and logged instead, so a sweep that
 * silently achieves nothing is visible in the log rather than inferred from
 * orders that never ship.
 */
export async function recoverPendingSubmissions(
  prisma: PrismaClient,
  log: Logger,
  options: RecoveryOptions = {},
): Promise<RecoverySummary> {
  const enqueue = options.enqueue ?? ((orderId, opts) => enqueueSubmitOrder(orderId, opts));

  const summary: RecoverySummary = {
    pendingFound: 0,
    expiredClaimsFound: 0,
    enqueued: 0,
    alreadyQueued: 0,
    enqueueFailed: 0,
  };

  const pending = await findOrdersNeedingSubmission(prisma, options);
  const expired = await findExpiredClaims(prisma, options);

  summary.pendingFound = pending.length;
  summary.expiredClaimsFound = expired.length;

  if (pending.length === 0 && expired.length === 0) return summary;

  for (const order of [...pending, ...expired]) {
    try {
      // `replaceExisting` for both populations, and this is the subtle part: a
      // fixed job id is deduplicated against COMPLETED and FAILED jobs as well as
      // waiting ones. An order whose submit job exhausted its attempts still owns
      // its job id for the retention window, so without this the sweep would find
      // the order every five minutes, enqueue nothing, and report success.
      const result = await enqueue(order.id, { replaceExisting: true });

      if (result.removeError) {
        // The previous job could not be removed, so the add below was a no-op.
        // Counting this as "enqueued" is how a sweep reports success while
        // achieving nothing.
        summary.enqueueFailed += 1;
        log.error(
          { event: "order_recovery_replace_failed", orderId: order.id, removeError: result.removeError },
          "could not replace the previous submit job; the order was NOT re-enqueued",
        );
        continue;
      }

      if (result.enqueued) summary.enqueued += 1;
      else summary.alreadyQueued += 1;
    } catch (error) {
      // Redis is still down. The order stays PENDING_SYNC and the next sweep
      // tries again -- which is exactly the behaviour that makes this a recovery
      // path rather than another single point of failure.
      summary.enqueueFailed += 1;
      log.error(
        { event: "order_recovery_enqueue_failed", orderId: order.id, ...errorFields(error) },
        "could not re-enqueue an order needing submission",
      );
    }
  }

  log.info(
    { event: "order_recovery_sweep", ...summary },
    "re-enqueued orders that were waiting to be submitted",
  );

  return summary;
}
