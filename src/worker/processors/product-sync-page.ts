/**
 * One page of the product connection.
 *
 * Refresh heartbeat -> fetch one page -> write it -> enqueue the next page, or
 * finalise. The chain is the unit of recovery: a crash loses one page, and the
 * next page job resumes from a cursor that is already durable in
 * `SyncRun.lastCursor`.
 */
import type { Job } from "bullmq";

import { prisma } from "@/src/lib/prisma";
import { jobLogger } from "@/src/lib/logger";
import { withJobLog } from "@/src/lib/jobs/job-log";
import {
  JOB,
  QUEUE,
  getProductSyncPageQueue,
  getVariantSyncQueue,
  type ProductSyncPagePayload,
} from "@/src/lib/queues";
import { shopifyGraphQL } from "@/src/lib/shopify/client";
import {
  IMAGES_PER_PRODUCT,
  PRODUCTS_PAGE_QUERY,
  PRODUCTS_PER_PAGE,
  SHOP_CURRENCY_QUERY,
  VARIANTS_PER_PAGE,
} from "@/src/lib/shopify/queries";
import { mapProductsPage } from "@/src/lib/sync/product-mapper";
import { buildProductQueryFilter, canSweep } from "@/src/lib/sync/decisions";
import { upsertProduct, sweepMissingProducts } from "@/src/lib/sync/catalog-repo";
import {
  countIncompleteVariantProducts,
  failSyncRun,
  finishSyncRun,
  getRun,
  heartbeat,
} from "@/src/lib/sync/sync-run";

export interface PageResult {
  syncRunId: string;
  pageIndex: number;
  productsSeen: number;
  productsApplied: number;
  variantsUpserted: number;
  variantChainsEnqueued: number;
  hasNextPage: boolean;
  finalised?: "COMPLETED" | "PARTIAL";
  productsDeactivated?: number;
  /**
   * True when this page did no work because the run had already ended. The job
   * succeeds (retrying cannot help) but it is NOT progress, and the field says
   * so rather than letting an empty success look like a completed page.
   */
  abandoned?: boolean;
  /** Products this run left with a truncated variant set. */
  productsWithIncompleteVariants?: number;
}

/**
 * Cached per process. The shop's currency does not change between pages, and
 * re-asking on every page spends query cost on a constant.
 */
let cachedCurrency: string | null = null;

async function shopCurrency(): Promise<string> {
  if (cachedCurrency) return cachedCurrency;
  const { data } = await shopifyGraphQL<{ shop: { currencyCode: string } }>(SHOP_CURRENCY_QUERY, {
    operation: "ShopCurrency",
  });
  cachedCurrency = data.shop.currencyCode;
  return cachedCurrency;
}

export async function processProductSyncPage(job: Job<ProductSyncPagePayload>): Promise<PageResult> {
  const attempt = job.attemptsMade + 1;
  const { syncRunId, cursor, pageIndex } = job.data;
  const log = jobLogger({
    queue: QUEUE.PRODUCT_SYNC_PAGE,
    jobName: JOB.SYNC_PRODUCTS_PAGE,
    jobId: String(job.id),
    attempt,
    syncRunId,
  });

  return withJobLog(
    prisma,
    log,
    {
      queueName: QUEUE.PRODUCT_SYNC_PAGE,
      jobName: JOB.SYNC_PRODUCTS_PAGE,
      bullJobId: String(job.id),
      attempt,
      maxAttempts: job.opts.attempts ?? 1,
      entityType: "SYNC_RUN",
      entityId: syncRunId,
    },
    async () => {
      const run = await getRun(prisma, syncRunId);
      if (!run) throw new Error(`sync run ${syncRunId} not found`);

      // A run that is no longer RUNNING was reclaimed or finalised while this
      // page sat in the queue. Writing now would stamp rows with a dead run id
      // and could make a later sweep deactivate live products.
      if (run.status !== "RUNNING") {
        log.warn(
          { runStatus: run.status, event: "page_abandoned" },
          "sync run is no longer running, abandoning page",
        );
        return {
          syncRunId,
          pageIndex,
          productsSeen: 0,
          productsApplied: 0,
          variantsUpserted: 0,
          variantChainsEnqueued: 0,
          hasNextPage: false,
          abandoned: true,
        };
      }

      // Prove liveness BEFORE the slow part, not after.
      await heartbeat(prisma, syncRunId, { lastCursor: cursor });

      const currencyCode = await shopCurrency();
      const filter = buildProductQueryFilter(run.watermarkFrom);

      const { data, cost } = await shopifyGraphQL<unknown>(PRODUCTS_PAGE_QUERY, {
        operation: "ProductsPage",
        variables: {
          first: PRODUCTS_PER_PAGE,
          after: cursor,
          query: filter,
          variantsFirst: VARIANTS_PER_PAGE,
          imagesFirst: IMAGES_PER_PRODUCT,
        },
        log,
      });

      const page = mapProductsPage(data);

      let productsApplied = 0;
      let variantsUpserted = 0;
      const variantChains: Array<{ productId: string; shopifyProductId: string; cursor: string | null }> = [];

      // One transaction per page: the product rows, their variants and images
      // commit together, so a crash mid-page leaves either a whole page applied
      // or none of it -- never a product without its variants.
      await prisma.$transaction(
        async (tx) => {
          for (const product of page.products) {
            const result = await upsertProduct(tx, product, { syncRunId, currencyCode, log });
            if (result.applied) productsApplied += 1;
            variantsUpserted += result.variantsUpserted;

            if (product.variantsHasNextPage) {
              variantChains.push({
                productId: result.productId,
                shopifyProductId: product.shopifyProductId,
                cursor: product.variantsEndCursor,
              });
            }
          }
        },
        // A page of 50 products with variants and images is a few hundred
        // statements; the default 5s timeout is not enough on a cold cache.
        { timeout: 60_000, maxWait: 15_000 },
      );

      // Enqueued AFTER the transaction commits. Enqueuing inside would publish
      // work referencing rows that a rollback then removes.
      for (const chain of variantChains) {
        await getVariantSyncQueue().add(
          JOB.SYNC_VARIANTS,
          { syncRunId, productId: chain.productId, shopifyProductId: chain.shopifyProductId, cursor: chain.cursor },
          { jobId: `${syncRunId}:variants:${chain.shopifyProductId}:${chain.cursor ?? "start"}` },
        );
      }

      await heartbeat(prisma, syncRunId, {
        pagesProcessed: 1,
        productsUpserted: productsApplied,
        variantsUpserted,
        lastCursor: page.endCursor,
      });

      log.info(
        {
          pageIndex,
          productsSeen: page.products.length,
          productsApplied,
          variantsUpserted,
          variantChainsEnqueued: variantChains.length,
          hasNextPage: page.hasNextPage,
          requestedCost: cost?.requestedQueryCost,
          availableCost: cost?.throttleStatus.currentlyAvailable,
          event: "page_complete",
        },
        "product page written",
      );

      if (page.hasNextPage) {
        await getProductSyncPageQueue().add(
          JOB.SYNC_PRODUCTS_PAGE,
          { syncRunId, cursor: page.endCursor, pageIndex: pageIndex + 1 },
          { jobId: `${syncRunId}:page:${pageIndex + 1}` },
        );

        return {
          syncRunId,
          pageIndex,
          productsSeen: page.products.length,
          productsApplied,
          variantsUpserted,
          variantChainsEnqueued: variantChains.length,
          hasNextPage: true,
        };
      }

      // ---- last page: finalise -------------------------------------------
      //
      // A run reaches COMPLETED only if ALL of these hold:
      //   1. every page before this one succeeded (a permanently failed page
      //      called failSyncRun, which ends the run -- so reaching here with a
      //      RUNNING status already implies it),
      //   2. this page's transaction committed (we are past it),
      //   3. the sweep, if allowed, completed without throwing,
      //   4. nothing else finalised or reclaimed the run underneath us.
      //
      // Anything else must not report success.
      const finalRun = await getRun(prisma, syncRunId);

      if (!finalRun || finalRun.status !== "RUNNING") {
        // Reclaimed or already finalised while this page ran. Do NOT sweep and
        // do NOT overwrite whatever status the other party recorded.
        log.warn(
          { runStatus: finalRun?.status ?? "missing", event: "finalise_skipped" },
          "run is no longer RUNNING at finalisation, leaving its recorded status alone",
        );
        return {
          syncRunId,
          pageIndex,
          productsSeen: page.products.length,
          productsApplied,
          variantsUpserted,
          variantChainsEnqueued: variantChains.length,
          hasNextPage: false,
          abandoned: true,
        };
      }

      // Variant chains may still be in flight. That does not block COMPLETED:
      // every product they cover is durably marked `variantSyncComplete = false`
      // (ARCHITECTURE §3.3), which is an explicit statement of incompleteness
      // rather than a silent one. It is counted and logged so "COMPLETED" is
      // never read as a stronger claim than it is.
      const productsWithIncompleteVariants = await countIncompleteVariantProducts(
        prisma,
        syncRunId,
      );

      const sweepAllowed = canSweep({
        mode: run.mode,
        status: "COMPLETED",
        failures: 0,
        reachedLastPage: true,
      });

      let productsDeactivated = 0;

      if (sweepAllowed) {
        // Before the status is written: if the sweep throws, this job fails,
        // the run stays RUNNING, and BullMQ retries the page. A run must never
        // be COMPLETED with an unfinished sweep.
        const swept = await sweepMissingProducts(prisma, syncRunId);
        productsDeactivated = swept.productsDeactivated;
        log.info(
          {
            productsDeactivated: swept.productsDeactivated,
            variantsDeactivated: swept.variantsDeactivated,
            event: "sweep_complete",
          },
          "deactivated products missing from a complete full sync",
        );
      } else {
        log.info(
          { mode: run.mode, event: "sweep_skipped" },
          "sweep skipped: not a FULL run",
        );
      }

      await finishSyncRun(prisma, syncRunId, { status: "COMPLETED", productsDeactivated });

      log.info(
        {
          finalised: "COMPLETED",
          productsDeactivated,
          productsWithIncompleteVariants,
          event: "sync_completed",
        },
        productsWithIncompleteVariants > 0
          ? "sync completed; some products carry a truncated variant set"
          : "sync completed",
      );

      return {
        syncRunId,
        pageIndex,
        productsSeen: page.products.length,
        productsApplied,
        variantsUpserted,
        variantChainsEnqueued: variantChains.length,
        hasNextPage: false,
        finalised: "COMPLETED" as const,
        productsDeactivated,
        productsWithIncompleteVariants,
      };
    },
  ).catch(async (error: unknown) => {
    // The chain IS the run: this page is what would have enqueued the next one.
    // When the last attempt fails, no further page job will ever exist, so the
    // run cannot finalise itself and must be ended here -- otherwise it sits
    // RUNNING holding the lock until the heartbeat goes stale, blocking every
    // sync in the meantime and reporting a state that is not true.
    //
    // Ending it PARTIAL also blocks the sweep, which is the point: a run that
    // did not see the whole catalog must never deactivate anything.
    const isFinalAttempt = attempt >= (job.opts.attempts ?? 1);

    if (isFinalAttempt) {
      const message = error instanceof Error ? error.message : String(error);
      const ended = await failSyncRun(
        prisma,
        syncRunId,
        `page ${pageIndex} exhausted ${attempt} attempts: ${message}`,
      ).catch(() => false);

      log.error(
        {
          pageIndex,
          runEnded: ended,
          finalised: "PARTIAL",
          event: "sync_failed",
        },
        ended
          ? "page exhausted its attempts; run ended PARTIAL and the sweep will not run"
          : "page exhausted its attempts; run was already finalised elsewhere",
      );
    }

    // Rethrow either way: BullMQ owns the retry decision, and swallowing this
    // would report a failed page as a successful job.
    throw error;
  });
}
