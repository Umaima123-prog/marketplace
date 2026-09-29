/**
 * The submit-order processor.
 *
 * Thin: it binds a logger, wraps the work in a JobLog row, and hands off to
 * `submitOrder`, which owns the state machine. The split exists so every rule
 * about claiming, resuming and failing can be tested against real MySQL without
 * constructing a BullMQ job.
 *
 * Runs at concurrency 1 (see src/worker/index.ts). The claim would make a second
 * concurrent worker safe; the concurrency setting makes it unnecessary, and it
 * keeps submission order roughly FIFO, which is what a customer waiting for a
 * delivery would expect.
 */
import type { Job } from "bullmq";

import { jobLogger, type Logger } from "@/src/lib/logger";
import { prisma } from "@/src/lib/prisma";
import { withJobLog } from "@/src/lib/jobs/job-log";
import { JOB, QUEUE, type SubmitOrderPayload } from "@/src/lib/queues";
import { createShopifyPort } from "@/src/lib/orders/shopify-port";
import { readStatus } from "@/src/lib/orders/order-repo";
import { isPermanent, submitOrder, type ShopifyPort, type SubmitOutcome } from "@/src/lib/orders/submit-order";

export interface SubmitOrderResult {
  orderId: string;
  outcome: SubmitOutcome["kind"];
  shopifyOrderId?: string;
}

/**
 * What BullMQ registers: exactly ONE parameter.
 *
 * BullMQ invokes a processor as `(job, token)`, so a processor whose second
 * parameter is a dependency receives the token instead. That is not theoretical --
 * it happened on the first live order, as
 * "shopify.findDraftOrdersByQuery is not a function". The worker wraps every
 * processor now, and this single-argument entry point means the mistake cannot be
 * reintroduced by registering the wrong function.
 */
export function submitOrderProcessor(job: Job<SubmitOrderPayload>): Promise<SubmitOrderResult> {
  return processSubmitOrder(job);
}

/**
 * The port is resolved rather than defaulted in the parameter list.
 *
 * A default parameter is silently replaced by any second argument a caller
 * passes, including a BullMQ token; this rejects anything that is not actually a
 * port and falls back to the real client, so a mis-registration degrades to
 * correct behaviour instead of a TypeError mid-submission.
 *
 * `createShopifyPort` opens no connection -- it returns an object of closures --
 * so building one to discard it costs nothing.
 */
export function resolveShopifyPort(candidate: unknown, log: Logger): ShopifyPort {
  const looksLikePort =
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as ShopifyPort).createDraftOrder === "function" &&
    typeof (candidate as ShopifyPort).completeDraftOrder === "function" &&
    typeof (candidate as ShopifyPort).getDraftOrder === "function" &&
    typeof (candidate as ShopifyPort).findDraftOrdersByQuery === "function" &&
    typeof (candidate as ShopifyPort).resolvePaymentTermsTemplateId === "function";

  return looksLikePort ? (candidate as ShopifyPort) : createShopifyPort(log);
}

/**
 * `shopify` is injectable so the integration tests can drive this exact
 * processor with a fake port. Production passes nothing and gets the real client.
 */
export async function processSubmitOrder(
  job: Job<SubmitOrderPayload>,
  shopify?: unknown,
): Promise<SubmitOrderResult> {
  const attempt = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? 1;
  const { orderId } = job.data;

  const log = jobLogger({
    queue: QUEUE.SUBMIT_ORDER,
    jobName: JOB.SUBMIT_ORDER,
    jobId: String(job.id),
    attempt,
    // The order id is the only identifier logged. Never the customer, the
    // address, the phone number or the totals (ARCHITECTURE 8).
    orderId,
  });

  const port = resolveShopifyPort(shopify, log);

  return withJobLog(
    prisma,
    log,
    {
      queueName: QUEUE.SUBMIT_ORDER,
      jobName: JOB.SUBMIT_ORDER,
      bullJobId: String(job.id),
      jobInstance: String(job.timestamp),
      attempt,
      maxAttempts,
      entityType: "ORDER",
      entityId: orderId,
    },
    async (_started, annotate) => {
      // The status BEFORE this attempt touched anything. Read here rather than
      // inside submitOrder because the claim overwrites it.
      const startStatus = await readStatus(prisma, orderId);
      annotate({ startStatus });

      try {
        const outcome = await submitOrder(orderId, {
          prisma,
          shopify: port,
          log,
          // Whether BullMQ has another attempt left decides release-for-retry
          // versus mark-FAILED. The processor knows this; the state machine
          // should not have to guess at it.
          willRetry: attempt < maxAttempts,
        });

        annotate({
          endStatus: await readStatus(prisma, orderId),
          retryable: outcome.kind === "failed" ? false : null,
        });

        return {
          orderId,
          outcome: outcome.kind,
          ...(outcome.kind === "synced" || outcome.kind === "already_synced"
            ? { shopifyOrderId: outcome.shopifyOrderId }
            : {}),
        };
      } catch (error) {
        // A retryable failure: submitOrder has already released the claim, so the
        // row is back in a claimable state and the end status reflects that.
        annotate({ endStatus: await readStatus(prisma, orderId), retryable: !isPermanent(error) });
        throw error;
      }
    },
  );
}
