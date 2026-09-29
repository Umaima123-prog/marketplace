/**
 * Queue names, payload shapes and job options.
 *
 * Shared by both processes, but note the asymmetry (ARCHITECTURE §2): the web
 * process is a PRODUCER ONLY and may call `queue.add`; it must never construct
 * a `Worker`. Workers are built in src/worker only.
 *
 * Payloads carry IDs, never data. Redis is plaintext with no retention policy,
 * so a payload holding a product title is a copy of the catalog living
 * somewhere nobody thinks to look.
 */
import { Queue, type JobsOptions } from "bullmq";

import { getQueueConnection } from "./redis";

export const QUEUE = {
  PRODUCT_SYNC: "product-sync",
  PRODUCT_SYNC_PAGE: "product-sync-page",
  VARIANT_SYNC: "variant-sync",
} as const;

export const JOB = {
  SYNC_PRODUCTS: "sync-products",
  SYNC_PRODUCTS_PAGE: "sync-products-page",
  SYNC_VARIANTS: "sync-variants",
} as const;

export type SyncMode = "FULL" | "INCREMENTAL";
export type SyncTrigger = "SCHEDULE" | "NIGHTLY" | "MANUAL" | "WEBHOOK";

/** Orchestrator: claims the run lock, enqueues page 1, then exits. */
export interface ProductSyncPayload {
  mode: SyncMode;
  triggeredBy: SyncTrigger;
}

/** One page of the product connection. Chained: each page enqueues the next. */
export interface ProductSyncPagePayload {
  syncRunId: string;
  cursor: string | null;
  pageIndex: number;
}

/** Only for products whose variant connection exceeded one page. */
export interface VariantSyncPayload {
  syncRunId: string;
  productId: string;
  shopifyProductId: string;
  cursor: string | null;
}

/**
 * Retention: keep enough to debug yesterday, not enough to fill Redis. The
 * durable record is the JobLog table -- BullMQ's history lives in Redis, which
 * this architecture treats as disposable.
 */
const RETENTION = {
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5_000 },
} satisfies Pick<JobsOptions, "removeOnComplete" | "removeOnFail">;

/**
 * 3 attempts with exponential backoff, as specified. The orchestrator does
 * little work, so a failure here is almost always Redis or MySQL being
 * unavailable -- 30s, 60s, 120s gives them time to come back.
 */
export const PRODUCT_SYNC_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 30_000 },
  ...RETENTION,
};

/**
 * Pages get more attempts and a shorter base delay: a page failure is usually a
 * throttle or a transient 5xx from Shopify, and losing one page to exhausted
 * attempts marks the whole run PARTIAL.
 */
export const PAGE_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  ...RETENTION,
};

export const VARIANT_JOB_OPTIONS: JobsOptions = { ...PAGE_JOB_OPTIONS };

let productSyncQueue: Queue<ProductSyncPayload> | undefined;
let productSyncPageQueue: Queue<ProductSyncPagePayload> | undefined;
let variantSyncQueue: Queue<VariantSyncPayload> | undefined;

export function getProductSyncQueue(): Queue<ProductSyncPayload> {
  productSyncQueue ??= new Queue<ProductSyncPayload>(QUEUE.PRODUCT_SYNC, {
    connection: getQueueConnection(),
    defaultJobOptions: PRODUCT_SYNC_JOB_OPTIONS,
  });
  return productSyncQueue;
}

export function getProductSyncPageQueue(): Queue<ProductSyncPagePayload> {
  productSyncPageQueue ??= new Queue<ProductSyncPagePayload>(QUEUE.PRODUCT_SYNC_PAGE, {
    connection: getQueueConnection(),
    defaultJobOptions: PAGE_JOB_OPTIONS,
  });
  return productSyncPageQueue;
}

export function getVariantSyncQueue(): Queue<VariantSyncPayload> {
  variantSyncQueue ??= new Queue<VariantSyncPayload>(QUEUE.VARIANT_SYNC, {
    connection: getQueueConnection(),
    defaultJobOptions: VARIANT_JOB_OPTIONS,
  });
  return variantSyncQueue;
}

/**
 * Enqueue a sync and return immediately. This is the ONLY thing a trigger does
 * -- an HTTP handler must never wait on Shopify pagination.
 *
 * `jobId` deduplicates bursts: while a job with this id is waiting or active,
 * BullMQ ignores duplicates, so an operator double-clicking the button does not
 * queue two runs. It is deliberately NOT unique per run -- the queue is the
 * first line of defence against concurrent runs, the database lock is the real
 * one.
 */
export async function enqueueProductSync(payload: ProductSyncPayload): Promise<string | undefined> {
  const job = await getProductSyncQueue().add(JOB.SYNC_PRODUCTS, payload, {
    jobId: `product-sync:${payload.mode.toLowerCase()}`,
  });
  return job.id;
}
