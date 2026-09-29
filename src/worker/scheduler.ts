/**
 * Repeatable jobs, registered by the worker at boot.
 *
 * Registered here rather than in the web process for two reasons: the web
 * process may run as many instances as it likes (each would re-register), and a
 * schedule that only exists while someone is serving traffic is not a schedule.
 *
 * BullMQ keys a job scheduler by its id, so repeated boots update the schedule
 * in place instead of accumulating duplicates.
 */
import { env } from "@/src/lib/env";
import type { Logger } from "@/src/lib/logger";
import { JOB, PRODUCT_SYNC_JOB_OPTIONS, getProductSyncQueue, type ProductSyncPayload } from "@/src/lib/queues";

const INCREMENTAL_SCHEDULER_ID = "product-sync-incremental";
const NIGHTLY_SCHEDULER_ID = "product-sync-nightly";

export async function registerRepeatableJobs(log: Logger): Promise<void> {
  if (!env.syncSchedulersEnabled) {
    log.warn(
      { event: "schedulers_disabled" },
      "SYNC_SCHEDULERS_ENABLED=false: this worker processes only what is explicitly enqueued",
    );
    return;
  }

  // Queue.upsertJobScheduler is the supported entry point; constructing a bare
  // JobScheduler is an internal detail of BullMQ and its signature differs
  // between minor versions.
  const queue = getProductSyncQueue();

  // Incremental catch-up. With webhooks out of core scope, this interval IS the
  // freshness guarantee -- catalog staleness is bounded by it and by nothing
  // else.
  await queue.upsertJobScheduler(
    INCREMENTAL_SCHEDULER_ID,
    { every: env.productSyncIntervalMinutes * 60 * 1000 },
    {
      name: JOB.SYNC_PRODUCTS,
      data: { mode: "INCREMENTAL", triggeredBy: "SCHEDULE" } satisfies ProductSyncPayload,
      opts: { attempts: PRODUCT_SYNC_JOB_OPTIONS.attempts, backoff: PRODUCT_SYNC_JOB_OPTIONS.backoff },
    },
  );

  // Nightly full reconciliation: the only mode allowed to deactivate, so it is
  // also the only thing that ever removes a product the storefront still shows.
  await queue.upsertJobScheduler(
    NIGHTLY_SCHEDULER_ID,
    { pattern: "0 3 * * *" },
    {
      name: JOB.SYNC_PRODUCTS,
      data: { mode: "FULL", triggeredBy: "NIGHTLY" } satisfies ProductSyncPayload,
      opts: { attempts: PRODUCT_SYNC_JOB_OPTIONS.attempts, backoff: PRODUCT_SYNC_JOB_OPTIONS.backoff },
    },
  );

  log.info(
    {
      incrementalEveryMinutes: env.productSyncIntervalMinutes,
      nightlyCron: "0 3 * * *",
      event: "schedulers_registered",
    },
    "repeatable sync jobs registered",
  );
}
