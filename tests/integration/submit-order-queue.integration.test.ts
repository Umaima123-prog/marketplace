/**
 * `enqueueSubmitOrder` against REAL Redis and real BullMQ.
 *
 * This file exists because of a live failure that no mock would have caught. The
 * recovery path re-enqueues an order by replacing the retained terminal job that
 * owns its fixed job id. In the live run the removal failed, the add was silently
 * deduplicated against the completed job, and the caller was told the work was
 * queued when nothing had been — the order sat unsubmitted with a cheerful log
 * line. The old code both swallowed the removal error and inferred success from
 * `job.id === jobId`, which is true whether the job was created or merely
 * returned.
 *
 * The behaviour being pinned here is BullMQ's, so it is tested against BullMQ.
 */
import { Worker } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { disconnect } from "./setup";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { enqueueSubmitOrder, getSubmitOrderQueue, submitOrderJobId, JOB } = await import(
  "@/src/lib/queues"
);

const { createWorkerConnection } = await import("@/src/lib/redis");
const { QUEUE } = await import("@/src/lib/queues");

const queue = getSubmitOrderQueue();

/**
 * Drives one job to a terminal state through a REAL worker.
 *
 * `job.moveToCompleted` from outside a worker fails with "Missing lock" -- only the
 * process holding the job's lock may finish it. Since the behaviour under test is
 * BullMQ's own deduplication against retained terminal jobs, the terminal state has
 * to be reached the way production reaches it.
 */
async function drainOne(expectedOrderId: string): Promise<void> {
  const worker = new Worker(
    QUEUE.SUBMIT_ORDER,
    async (job) => ({ orderId: (job.data as { orderId: string }).orderId, outcome: "failed" }),
    { connection: createWorkerConnection(), concurrency: 1 },
  );

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("job was not processed in time")), 15_000);
      worker.on("completed", (job) => {
        if ((job.data as { orderId?: string })?.orderId !== expectedOrderId) return;
        clearTimeout(timer);
        resolve();
      });
      worker.on("failed", (_job, error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    await worker.close();
  }
}

/** Distinct per test, so one test's leftovers cannot satisfy another's assertion. */
let seq = 0;
const nextOrderId = () => `queue-test-${Date.now()}-${(seq += 1)}`;

const touched: string[] = [];

async function enqueue(orderId: string, options?: { replaceExisting?: boolean }) {
  touched.push(orderId);
  return enqueueSubmitOrder(orderId, options);
}

beforeAll(async () => {
  await queue.waitUntilReady();
});

afterEach(async () => {
  // Redis is shared with the running development stack; leave nothing behind.
  for (const orderId of touched.splice(0)) {
    await queue.remove(submitOrderJobId(orderId)).catch(() => undefined);
  }
});

afterAll(async () => {
  await queue.close();
  await disconnect();
});

describe("enqueueSubmitOrder: a fresh order", () => {
  it("creates the job and reports it as enqueued", async () => {
    const orderId = nextOrderId();

    const result = await enqueue(orderId);

    expect(result.enqueued).toBe(true);
    expect(result.jobId).toBe(submitOrderJobId(orderId));
    expect(result.deduplicatedAgainstState).toBeUndefined();

    const job = await queue.getJob(submitOrderJobId(orderId));
    expect(job?.data).toEqual({ orderId });
    expect(job?.name).toBe(JOB.SUBMIT_ORDER);
  });

  it("carries the order id and nothing else -- Redis holds no customer data", async () => {
    const orderId = nextOrderId();
    await enqueue(orderId);

    const job = await queue.getJob(submitOrderJobId(orderId));
    expect(Object.keys(job?.data ?? {})).toEqual(["orderId"]);
  });

  it("uses a job id with no colon, which BullMQ would reject", async () => {
    const orderId = nextOrderId();
    const result = await enqueue(orderId);
    expect(result.jobId).not.toContain(":");
  });
});

describe("enqueueSubmitOrder: a second call for the same order", () => {
  it("does not create a second job, and says so", async () => {
    // One order, one job, forever: two jobs would mean two Shopify drafts.
    const orderId = nextOrderId();

    const first = await enqueue(orderId);
    const second = await enqueue(orderId);

    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
    expect(second.jobId).toBe(first.jobId);
    expect(second.deduplicatedAgainstState).toBeDefined();
  });

  it("is deduplicated against a job that has already COMPLETED", async () => {
    // The case that broke the live retry. A completed job is retained for the
    // removeOnComplete window and still owns the id, so a plain add is a no-op --
    // which is correct for the checkout path and fatal for the recovery path.
    const orderId = nextOrderId();
    await enqueue(orderId);

    // Drive it to a terminal state the way production does.
    await drainOne(orderId);
    const job = await queue.getJob(submitOrderJobId(orderId));
    expect(await job!.getState()).toBe("completed");

    const again = await enqueue(orderId);

    expect(again.enqueued).toBe(false);
    expect(again.deduplicatedAgainstState).toBe("completed");
  });
});

describe("enqueueSubmitOrder: replaceExisting", () => {
  it("replaces a COMPLETED job so the order can actually be retried", async () => {
    // The fix, end to end: without this the recovery sweep finds the order every
    // five minutes and queues nothing.
    const orderId = nextOrderId();
    await enqueue(orderId);
    await drainOne(orderId);
    expect(await (await queue.getJob(submitOrderJobId(orderId)))!.getState()).toBe("completed");

    const replaced = await enqueue(orderId, { replaceExisting: true });

    expect(replaced.removedExisting).toBe(true);
    expect(replaced.removeError).toBeUndefined();
    // Genuinely new: created by this call, and waiting rather than completed.
    expect(replaced.enqueued).toBe(true);

    const fresh = await queue.getJob(submitOrderJobId(orderId));
    expect(fresh).toBeDefined();
    expect(await fresh!.getState()).toBe("waiting");
    expect(fresh!.finishedOn).toBeUndefined();
  });

  it("reports removedExisting: false when there was nothing to replace", async () => {
    const orderId = nextOrderId();

    const result = await enqueue(orderId, { replaceExisting: true });

    expect(result.removedExisting).toBe(false);
    expect(result.enqueued).toBe(true);
    expect(result.removeError).toBeUndefined();
  });

  it("leaves one job, not two", async () => {
    const orderId = nextOrderId();
    await enqueue(orderId);
    await enqueue(orderId, { replaceExisting: true });
    await enqueue(orderId, { replaceExisting: true });

    const keys = await queue.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
    const mine = keys.filter((job) => (job.data as { orderId?: string })?.orderId === orderId);
    expect(mine).toHaveLength(1);
  });
});

describe("enqueueSubmitOrder: what the result promises", () => {
  it("never claims enqueued for a job it did not create", async () => {
    // The invariant the live bug violated. Whatever the state of a pre-existing
    // job, a call that created nothing must not report success.
    const orderId = nextOrderId();
    await enqueue(orderId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await enqueue(orderId);
      expect(result.enqueued).toBe(false);
    }
  });
});
