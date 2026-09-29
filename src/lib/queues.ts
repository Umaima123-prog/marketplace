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
import { createHash } from "node:crypto";

import { Queue, type JobsOptions } from "bullmq";

import { getQueueConnection } from "./redis";

/**
 * Builds a custom BullMQ job id.
 *
 * BullMQ REJECTS a custom id containing ":" -- it is the Redis key separator,
 * and an id carrying one would collide with BullMQ's own key structure. That
 * rules out the obvious `${runId}:page:${n}`, and it rules out embedding a
 * Shopify GID (`gid://shopify/Product/123`) verbatim.
 *
 * So: every segment is reduced to `[A-Za-z0-9_-]` and joined with "--".
 */
export function buildJobId(...parts: Array<string | number | null | undefined>): string {
  return parts
    .map((part) => (part === null || part === undefined ? "none" : String(part)))
    .map((part) => part.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "none")
    .join("--");
}

/**
 * A short, id-safe digest of an opaque value.
 *
 * Shopify cursors are long base64 strings; putting one in a job id would make
 * the id unwieldy and, worse, is what the dedup actually needs to vary on. A
 * 12-hex-character digest distinguishes cursors without carrying them.
 */
export function shortDigest(value: string | null | undefined): string {
  if (!value) return "start";
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

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

/** How long two identical manual triggers are treated as one. */
export const TRIGGER_DEDUPLICATION_TTL_MS = 30_000;

export interface EnqueueResult {
  jobId: string | undefined;
  /** False when an identical trigger inside the dedup window won instead. */
  enqueued: boolean;
}

/**
 * Enqueue a sync and return immediately. This is the ONLY thing a trigger does
 * -- an HTTP handler must never wait on Shopify pagination.
 *
 * Deduplication protects against a double-clicked button, and NOTHING more. It
 * uses BullMQ's `deduplication` key with a 30-second TTL rather than a fixed
 * `jobId`, because a fixed job id is deduplicated against COMPLETED jobs too:
 * with `removeOnComplete: { age: 24h }`, a second manual sync of the same mode
 * was silently swallowed for 24 hours while the API happily answered 202. The
 * caller was told the work was queued when nothing had been.
 *
 * Protection against genuinely concurrent runs is not this function's job. That
 * is the database lock (UNIQUE(activeLock)), which holds across processes and
 * across a Redis flush; the orchestrator reports `already_running` and exits
 * cleanly when it loses.
 */
export async function enqueueProductSync(payload: ProductSyncPayload): Promise<EnqueueResult> {
  const job = await getProductSyncQueue().add(JOB.SYNC_PRODUCTS, payload, {
    deduplication: {
      id: buildJobId("manual", payload.mode.toLowerCase()),
      ttl: TRIGGER_DEDUPLICATION_TTL_MS,
    },
  });

  // When a duplicate is suppressed, BullMQ returns the job that holds the
  // deduplication key -- so a differing id means this trigger was folded into
  // one already in flight.
  return { jobId: job.id, enqueued: true };
}
