/**
 * The recovery sweep, as a job.
 *
 * A repeatable job rather than a `setInterval` in the worker: it inherits the
 * queue's retries, its history, and its visibility, and it stops when the worker
 * stops instead of running inside a process that is shutting down.
 */
import type { Job } from "bullmq";

import { jobLogger } from "@/src/lib/logger";
import { prisma } from "@/src/lib/prisma";
import { withJobLog } from "@/src/lib/jobs/job-log";
import { JOB, QUEUE, type OrderRecoveryPayload } from "@/src/lib/queues";
import { recoverPendingSubmissions, type RecoverySummary } from "@/src/lib/orders/recovery";

export async function processOrderRecovery(
  job: Job<OrderRecoveryPayload>,
): Promise<RecoverySummary> {
  const attempt = job.attemptsMade + 1;

  const log = jobLogger({
    queue: QUEUE.ORDER_RECOVERY,
    jobName: JOB.RECOVER_ORDERS,
    jobId: String(job.id),
    attempt,
  });

  return withJobLog(
    prisma,
    log,
    {
      queueName: QUEUE.ORDER_RECOVERY,
      jobName: JOB.RECOVER_ORDERS,
      bullJobId: String(job.id),
      jobInstance: String(job.timestamp),
      attempt,
      maxAttempts: job.opts.attempts ?? 1,
      // No entity: the sweep is about a population, not one order. Which orders
      // it re-enqueued is in the log line and in each order's own JobLog rows.
    },
    async () => recoverPendingSubmissions(prisma, log),
  );
}
