/**
 * Variant continuation for products with more than 100 variants.
 *
 * The inline `variants(first: 100)` on the products page covers almost
 * everything. When it does not, that product is marked INCOMPLETE
 * (`variantSyncComplete = false`) with a durable resume cursor, and this chain
 * walks the rest one page at a time, re-enqueuing itself.
 *
 * The important property: the database never claims a truncated variant set is
 * complete. `variantSyncComplete` flips to true only when Shopify reports
 * `hasNextPage: false`, so a chain that dies halfway leaves the product visibly
 * incomplete rather than quietly wrong.
 */
import type { Job } from "bullmq";

import { prisma } from "@/src/lib/prisma";
import { jobLogger } from "@/src/lib/logger";
import { withJobLog } from "@/src/lib/jobs/job-log";
import {
  JOB,
  QUEUE,
  buildJobId,
  getVariantSyncQueue,
  shortDigest,
  type VariantSyncPayload,
} from "@/src/lib/queues";
import { shopifyGraphQL } from "@/src/lib/shopify/client";
import { PRODUCT_VARIANTS_PAGE_QUERY, VARIANTS_PER_PAGE } from "@/src/lib/shopify/queries";
import { mapVariantsPage } from "@/src/lib/sync/product-mapper";
import {
  markVariantSyncComplete,
  saveVariantCursor,
  upsertVariants,
} from "@/src/lib/sync/catalog-repo";
import { heartbeat } from "@/src/lib/sync/sync-run";

export interface VariantPageResult {
  productId: string;
  variantsUpserted: number;
  hasNextPage: boolean;
  complete: boolean;
}

export async function processVariantSync(job: Job<VariantSyncPayload>): Promise<VariantPageResult> {
  const attempt = job.attemptsMade + 1;
  const { syncRunId, productId, shopifyProductId, cursor } = job.data;
  const log = jobLogger({
    queue: QUEUE.VARIANT_SYNC,
    jobName: JOB.SYNC_VARIANTS,
    jobId: String(job.id),
    attempt,
    syncRunId,
    productGid: shopifyProductId,
  });

  return withJobLog(
    prisma,
    log,
    {
      queueName: QUEUE.VARIANT_SYNC,
      jobName: JOB.SYNC_VARIANTS,
      bullJobId: String(job.id),
      jobInstance: String(job.timestamp),
      attempt,
      maxAttempts: job.opts.attempts ?? 1,
      entityType: "PRODUCT",
      entityId: productId,
    },
    async () => {
      const product = await prisma.product.findUnique({
        where: { id: productId },
        // `isActive` as well as the id: a continuation page must write its
        // variants with the PARENT's visibility, or a chain that spans an archive
        // in Shopify would leave live variants under a dead product.
        select: { id: true, isActive: true },
      });

      // The product row can disappear between pages only by hard deletion,
      // which this system never does -- but a wrong productId in a stale queued
      // job would otherwise write variants attached to nothing.
      if (!product) {
        log.warn({ event: "variant_chain_abandoned" }, "product row missing, abandoning chain");
        return { productId, variantsUpserted: 0, hasNextPage: false, complete: false };
      }

      // A long chain is exactly when a run looks dead to the reclaimer.
      await heartbeat(prisma, syncRunId).catch(() => undefined);

      const anyVariant = await prisma.productVariant.findFirst({
        where: { productId },
        select: { currencyCode: true },
      });
      // Inherited from the variants already written by the page job; a variant
      // chain never runs for a product with no inline variants.
      const currencyCode = anyVariant?.currencyCode ?? "USD";

      const { data } = await shopifyGraphQL<unknown>(PRODUCT_VARIANTS_PAGE_QUERY, {
        operation: "ProductVariantsPage",
        variables: { productId: shopifyProductId, first: VARIANTS_PER_PAGE, after: cursor },
        log,
      });

      const page = mapVariantsPage(data);

      const variantsUpserted = await prisma.$transaction(
        async (tx) => {
          const count = await upsertVariants(tx, productId, page.variants, {
            syncRunId,
            currencyCode,
            // The product row was written by the page job from Shopify's status,
            // so it is the authority on visibility for this chain.
            productIsActive: product.isActive,
            log,
          });

          if (page.hasNextPage) {
            await saveVariantCursor(tx, productId, page.endCursor);
          } else {
            await markVariantSyncComplete(tx, productId);
          }

          return count;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );

      await heartbeat(prisma, syncRunId, { variantsUpserted }).catch(() => undefined);

      if (page.hasNextPage) {
        await getVariantSyncQueue().add(
          JOB.SYNC_VARIANTS,
          { syncRunId, productId, shopifyProductId, cursor: page.endCursor },
          {
            jobId: buildJobId(
              syncRunId,
              "variants",
              shopifyProductId.split("/").pop(),
              shortDigest(page.endCursor),
            ),
          },
        );
      }

      log.info(
        {
          variantsUpserted,
          hasNextPage: page.hasNextPage,
          complete: !page.hasNextPage,
          event: "variant_page_complete",
        },
        page.hasNextPage ? "variant page written, chain continues" : "variant chain complete",
      );

      return {
        productId,
        variantsUpserted,
        hasNextPage: page.hasNextPage,
        complete: !page.hasNextPage,
      };
    },
  );
}
