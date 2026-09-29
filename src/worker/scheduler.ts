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
import {
  JOB,
  ORDER_RECOVERY_JOB_OPTIONS,
  PRODUCT_SYNC_JOB_OPTIONS,
  getOrderRecoveryQueue,
  getProductSyncQueue,
  type ProductSyncPayload,
} from "@/src/lib/queues";

const INCREMENTAL_SCHEDULER_ID = "product-sync-incremental";
const NIGHTLY_SCHEDULER_ID = "product-sync-nightly";
const ORDER_RECOVERY_SCHEDULER_ID = "order-recovery";

export async function registerRepeatableJobs(log: Logger): Promise<void> {
  // Two independent decisions, deliberately not one flag. See src/lib/env.ts.
  await registerSyncSchedulers(log);
  await registerOrderRecoveryScheduler(log);
}

async function registerSyncSchedulers(log: Logger): Promise<void> {
  if (!env.syncSchedulersEnabled) {
    log.warn(
      { event: "sync_schedulers_disabled" },
      "SYNC_SCHEDULERS_ENABLED=false: this worker runs no scheduled catalog sync",
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
      event: "sync_schedulers_registered",
    },
    "repeatable sync jobs registered",
  );
}

/**
 * The outbox drain.
 *
 * Registered independently of the sync schedules, because an order whose enqueue
 * was lost is a customer waiting for a parcel that was never ordered -- not log
 * noise to be silenced during a controlled run.
 */
async function registerOrderRecoveryScheduler(log: Logger): Promise<void> {
  if (!env.orderRecoveryEnabled) {
    log.warn(
      { event: "order_recovery_disabled" },
      "ORDER_RECOVERY_ENABLED=false: orders whose enqueue was lost will NOT be recovered automatically",
    );
    return;
  }

  await getOrderRecoveryQueue().upsertJobScheduler(
    ORDER_RECOVERY_SCHEDULER_ID,
    { every: env.orderRecoveryIntervalMinutes * 60 * 1000 },
    {
      name: JOB.RECOVER_ORDERS,
      data: {},
      opts: {
        attempts: ORDER_RECOVERY_JOB_OPTIONS.attempts,
        backoff: ORDER_RECOVERY_JOB_OPTIONS.backoff,
      },
    },
  );

  log.info(
    {
      orderRecoveryEveryMinutes: env.orderRecoveryIntervalMinutes,
      graceSeconds: env.orderRecoveryGraceSeconds,
      leaseSeconds: env.orderClaimLeaseSeconds,
      event: "order_recovery_scheduler_registered",
    },
    "order recovery sweep registered",
  );
}
