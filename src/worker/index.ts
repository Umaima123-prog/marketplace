/**
 * The worker process. Run with `npm run worker`.
 *
 * This is a SEPARATE Node process from Next (ARCHITECTURE §2): it serves no
 * HTTP, and Next never constructs a BullMQ Worker. The separation is the point
 * -- a sync that runs inside a page request ties catalog freshness to whoever
 * happens to load a page, holds a request open for minutes, and dies when the
 * serverless invocation does.
 */
import { Worker, type Job } from "bullmq";

import { describeEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";
import { prisma } from "@/src/lib/prisma";
import { createWorkerConnection } from "@/src/lib/redis";
import { QUEUE, workerLockDurationMs } from "@/src/lib/queues";
import { shouldRetry } from "@/src/lib/shopify/errors";

import { processOrderRecovery } from "./processors/order-recovery";
import { processProductSync } from "./processors/product-sync";
import { processProductSyncPage } from "./processors/product-sync-page";
import { submitOrderProcessor } from "./processors/submit-order";
import { processVariantSync } from "./processors/variant-sync";
import { registerRepeatableJobs } from "./scheduler";

const log = logger.child({ service: "worker" });

/**
 * `lockDuration` must exceed p99 job duration or BullMQ decides a healthy job
 * is stalled and runs it a second time. A page job is one Shopify round trip
 * plus a transaction, so the floor is the page transaction's own budget.
 *
 * DERIVED rather than a second hard-coded number, deliberately. These two
 * settings are coupled: raising the transaction timeout alone would push a slow
 * page past the lock and trade "Transaction not found" for a stalled job being
 * re-delivered and the page written twice. Deriving it means the two cannot be
 * configured into disagreement -- whatever `SYNC_PAGE_TRANSACTION_TIMEOUT_MS`
 * is set to, the lock outlives it.
 *
 * The headroom covers everything in the job that is NOT the transaction: the
 * heartbeat, the shop-currency lookup, the Shopify page fetch (including a
 * throttle wait), and the post-commit enqueues.
 *
 * The derivation lives in `queues.ts` so it is unit-testable without importing
 * this module, which starts workers on import.
 */
const LOCK_DURATION_MS = workerLockDurationMs();

const workers: Worker[] = [];

function build<T>(
  queueName: string,
  processor: (job: Job<T>) => Promise<unknown>,
  concurrency: number,
): Worker<T> {
  // BullMQ calls a processor as `(job, token)`. Passing `processor` straight
  // through therefore hands its SECOND parameter BullMQ's token string -- which
  // silently defeated a dependency-injection default on the submit-order
  // processor and produced "shopify.findDraftOrdersByQuery is not a function" on
  // a live order. Wrapping to a single argument removes the whole class of bug
  // for every processor, present and future.
  const worker = new Worker<T>(
    queueName,
    ((job: Job<T>) => processor(job)) as never,
    {
      connection: createWorkerConnection(),
      concurrency,
      lockDuration: LOCK_DURATION_MS,
    },
  );

  worker.on("failed", (job, error) => {
    const attempt = (job?.attemptsMade ?? 0) + 1;
    const maxAttempts = job?.opts.attempts ?? 1;
    log.warn(
      {
        queue: queueName,
        jobName: job?.name,
        jobId: job?.id,
        attempt,
        maxAttempts,
        // Whether BullMQ will try again is the operational question a reader of
        // this line actually has.
        willRetry: attempt < maxAttempts && shouldRetry(error),
        errorClass: error?.name,
        errorMessage: error?.message,
        event: "bullmq_job_failed",
      },
      "job failed",
    );
  });

  // A stalled job is a job whose lock expired while it was supposedly running:
  // the process died, or it blocked for longer than lockDuration. BullMQ will
  // re-run it, and the page processor's `status !== RUNNING` guard is what stops
  // the re-run from writing against a finalised run.
  worker.on("stalled", (jobId) => {
    log.warn(
      { queue: queueName, jobId, lockDurationMs: LOCK_DURATION_MS, event: "bullmq_job_stalled" },
      "job stalled; its lock expired and BullMQ will re-run it",
    );
  });

  worker.on("error", (error) => {
    log.error({ queue: queueName, errorMessage: error.message }, "worker error");
  });

  workers.push(worker as Worker);
  return worker;
}

async function main(): Promise<void> {
  log.info({ ...describeEnv(), event: "worker_starting" }, "worker starting");

  // ---- concurrency -------------------------------------------------------
  //
  // sync-products runs at concurrency 1, deliberately and explicitly. Two
  // orchestrators would race for one database lock and the loser would do
  // nothing but log that it lost. The lock makes a second runner harmless; this
  // setting makes it pointless as well.
  //
  // Pages and variant chains run a few at a time. Their ceiling is Shopify's
  // cost bucket, not CPU: more concurrency here buys throttling, not
  // throughput. 3 is chosen against a development store and should be re-tuned
  // from the `requestedCost` / `availableCost` fields on the page_complete log
  // line once real catalog sizes are known.
  //
  // IMPORTANT, and a production gap: cost pacing is PROCESS-LOCAL. The client
  // keeps the last observed `throttleStatus` in module state, so the three page
  // workers above share one view of the bucket -- correct within this process.
  // Shopify meters the bucket PER SHOP, so N worker processes would each pace
  // against their own partial view and collectively over-request by roughly N
  // times. Running more than one worker process in production needs a shared
  // limiter (a Redis token bucket in front of every Shopify call), not a larger
  // number here. See ARCHITECTURE §3.7 S2.
  build(QUEUE.PRODUCT_SYNC, processProductSync, 1);
  build(QUEUE.PRODUCT_SYNC_PAGE, processProductSyncPage, 3);
  build(QUEUE.VARIANT_SYNC, processVariantSync, 3);

  // submit-order runs at concurrency 1, and this one is a correctness-adjacent
  // choice rather than a throughput one. The conditional claim already makes a
  // second concurrent consumer SAFE -- two workers cannot submit one order twice
  // -- but serialising submission also keeps it roughly FIFO, so the customer
  // who checked out first is sent to Shopify first. Each submission is two
  // Shopify round trips, so this caps order throughput; raising it is a
  // deliberate decision that needs the cross-process cost limiter first (S2).
  build(QUEUE.SUBMIT_ORDER, submitOrderProcessor, 1);

  // The outbox drain. Concurrency 1 because two sweeps would find the same rows
  // and race to enqueue the same job ids for no benefit.
  build(QUEUE.ORDER_RECOVERY, processOrderRecovery, 1);

  await registerRepeatableJobs(log);

  log.info(
    {
      concurrency: {
        [QUEUE.PRODUCT_SYNC]: 1,
        [QUEUE.PRODUCT_SYNC_PAGE]: 3,
        [QUEUE.VARIANT_SYNC]: 3,
        [QUEUE.SUBMIT_ORDER]: 1,
        [QUEUE.ORDER_RECOVERY]: 1,
      },
      costPacing: "process-local",
      event: "worker_ready",
    },
    "worker ready",
  );
}

/**
 * Graceful shutdown. `worker.close()` waits for in-flight jobs to finish, so a
 * deploy does not leave a half-written page and a lock that has to time out.
 */
async function shutdown(signal: string): Promise<void> {
  log.info({ signal, event: "worker_stopping" }, "shutting down");
  await Promise.allSettled(workers.map((worker) => worker.close()));
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  log.error({ reason: reason instanceof Error ? reason.message : String(reason) }, "unhandled rejection");
});

main().catch((error: unknown) => {
  log.error(
    { errorMessage: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined },
    "worker failed to start",
  );
  process.exit(1);
});
