/**
 * Orchestrator. Claims the run lock, enqueues page 1, exits.
 *
 * It deliberately does no Shopify work itself: a single job walking 400 pages
 * holds a BullMQ lock for minutes, dies on deploy, and its retry restarts from
 * page 0. Chained page jobs lose one page to a crash (ARCHITECTURE §3.2).
 */
import type { Job } from "bullmq";

import { prisma } from "@/src/lib/prisma";
import { jobLogger } from "@/src/lib/logger";
import { withJobLog } from "@/src/lib/jobs/job-log";
import {
  JOB,
  QUEUE,
  buildJobId,
  getProductSyncPageQueue,
  type ProductSyncPayload,
} from "@/src/lib/queues";
import { buildProductQueryFilter, incrementalWatermark } from "@/src/lib/sync/decisions";
import {
  SyncAlreadyRunningError,
  lastCompletedRunAt,
  startSyncRun,
} from "@/src/lib/sync/sync-run";

export interface ProductSyncResult {
  syncRunId?: string;
  enqueuedFirstPage: boolean;
  skipped?: "already_running";
  reclaimedFrom?: string;
  watermark?: string | null;
}

export async function processProductSync(job: Job<ProductSyncPayload>): Promise<ProductSyncResult> {
  const attempt = job.attemptsMade + 1;
  const log = jobLogger({
    queue: QUEUE.PRODUCT_SYNC,
    jobName: JOB.SYNC_PRODUCTS,
    jobId: String(job.id),
    attempt,
  });

  return withJobLog(
    prisma,
    log,
    {
      queueName: QUEUE.PRODUCT_SYNC,
      jobName: JOB.SYNC_PRODUCTS,
      bullJobId: String(job.id),
      attempt,
      maxAttempts: job.opts.attempts ?? 1,
    },
    async () => {
      const now = new Date();

      // INCREMENTAL narrows by updated_at from the last COMPLETED run, with a
      // deliberate overlap. FULL walks everything and is the only mode allowed
      // to deactivate.
      const watermark =
        job.data.mode === "INCREMENTAL"
          ? incrementalWatermark(await lastCompletedRunAt(prisma), now)
          : null;

      let run: { id: string; reclaimedFrom?: string };
      try {
        run = await startSyncRun(prisma, {
          mode: job.data.mode,
          triggeredBy: job.data.triggeredBy,
          watermarkFrom: watermark,
          now,
          log,
        });
      } catch (error) {
        if (error instanceof SyncAlreadyRunningError) {
          // Not a failure. Another run holds the lock and is alive; this
          // trigger is redundant. Returning cleanly avoids burning retries on
          // a condition that retrying cannot improve.
          log.info(
            { activeRunId: error.activeRunId, event: "sync_skipped" },
            "sync already running, skipping",
          );
          return { enqueuedFirstPage: false, skipped: "already_running" as const };
        }
        throw error;
      }

      await getProductSyncPageQueue().add(
        JOB.SYNC_PRODUCTS_PAGE,
        { syncRunId: run.id, cursor: null, pageIndex: 0 },
        // Deterministic id so a retry of THIS orchestrator cannot enqueue a
        // second page-0 for the same run.
        { jobId: buildJobId(run.id, "page", 0) },
      );

      log.info(
        {
          syncRunId: run.id,
          mode: job.data.mode,
          triggeredBy: job.data.triggeredBy,
          watermark: buildProductQueryFilter(watermark),
          reclaimedFrom: run.reclaimedFrom,
          event: "sync_started",
        },
        "sync run started",
      );

      return {
        syncRunId: run.id,
        enqueuedFirstPage: true,
        reclaimedFrom: run.reclaimedFrom,
        watermark: watermark ? watermark.toISOString() : null,
      };
    },
  );
}
