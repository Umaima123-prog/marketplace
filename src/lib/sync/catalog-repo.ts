/**
 * Every database write the catalog sync performs. Prisma only (ARCHITECTURE §8).
 *
 * Two hazards shape this file:
 *
 * 1. `prisma.upsert` is NOT atomic on MySQL. It can compile to SELECT then
 *    INSERT/UPDATE, so two page jobs racing the same new product both attempt
 *    the INSERT and one gets P2002. That is a *race*, not a bug, and it must not
 *    fail the page -- `withUniqueRetry` converts it into the update that the
 *    loser of the race should have done.
 *
 * 2. Shopify does not guarantee ordering. Every write is guarded by
 *    `shouldApplyUpdate`, so an older payload arriving late cannot clobber
 *    newer data.
 */
import type { Prisma, PrismaClient } from "@/src/generated/prisma";

import { isUniqueConstraintError } from "../prisma";
import type { Logger } from "../logger";

import { shouldApplyUpdate, variantSyncState } from "./decisions";
import type { MappedProduct, MappedVariant } from "./product-mapper";

export type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Run a write, and if it loses a unique-constraint race, run the fallback.
 *
 * Bounded at one retry on purpose: the second attempt takes the "row exists"
 * path, and if THAT hits P2002 the constraint being violated is not the one we
 * think it is -- looping would hide a real schema problem behind retries.
 */
export async function withUniqueRetry<T>(
  operation: () => Promise<T>,
  onConflict: () => Promise<T>,
  log?: Logger,
  context?: Record<string, unknown>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    log?.debug({ ...context, outcome: "p2002_race_resolved" }, "unique constraint race, retrying as update");
    return await onConflict();
  }
}

export interface UpsertProductResult {
  productId: string;
  applied: boolean;
  variantsUpserted: number;
  imagesUpserted: number;
}

/**
 * Upsert one product with its inline variants and images.
 *
 * Caller supplies `db`, which is a transaction client when the page is written
 * transactionally. The whole product is one unit: a product row without its
 * variants is a product the storefront would render as unbuyable.
 */
export async function upsertProduct(
  db: Db,
  mapped: MappedProduct,
  options: { syncRunId: string; currencyCode: string; now?: Date; log?: Logger },
): Promise<UpsertProductResult> {
  const now = options.now ?? new Date();
  const { log } = options;

  const existing = await db.product.findUnique({
    where: { shopifyProductId: mapped.shopifyProductId },
    select: { id: true, shopifyUpdatedAt: true },
  });

  // Ordering guard: an older page must not overwrite a newer webhook write.
  // The row is still stamped with this run id, because the run DID see the
  // product and the sweep must not deactivate it.
  if (existing && !shouldApplyUpdate(mapped.shopifyUpdatedAt, existing.shopifyUpdatedAt)) {
    await db.product.update({
      where: { id: existing.id },
      data: { lastSyncRunId: options.syncRunId, syncedAt: now },
    });
    log?.debug(
      { shopifyProductId: mapped.shopifyProductId, outcome: "skipped_stale" },
      "skipped stale product payload",
    );
    return { productId: existing.id, applied: false, variantsUpserted: 0, imagesUpserted: 0 };
  }

  const variantState = variantSyncState(mapped.variantsHasNextPage, mapped.variantsEndCursor);

  const writable = {
    handle: mapped.handle,
    title: mapped.title,
    descriptionHtml: mapped.descriptionHtml,
    vendor: mapped.vendor,
    productType: mapped.productType,
    status: mapped.status,
    // A product is visible only when Shopify says ACTIVE. A sync never
    // resurrects something an operator archived.
    isActive: mapped.status === "ACTIVE",
    deactivatedAt: mapped.status === "ACTIVE" ? null : now,
    deactivationReason: mapped.status === "ACTIVE" ? null : ("SHOPIFY_STATUS" as const),
    publishedAt: mapped.publishedAt,
    shopifyUpdatedAt: mapped.shopifyUpdatedAt,
    lastSyncRunId: options.syncRunId,
    syncedAt: now,
    variantSyncComplete: variantState.variantSyncComplete,
    variantSyncCursor: variantState.variantSyncCursor,
  };

  const product = await withUniqueRetry(
    () =>
      db.product.upsert({
        where: { shopifyProductId: mapped.shopifyProductId },
        create: { shopifyProductId: mapped.shopifyProductId, ...writable },
        update: writable,
        select: { id: true },
      }),
    () =>
      db.product.update({
        where: { shopifyProductId: mapped.shopifyProductId },
        data: writable,
        select: { id: true },
      }),
    log,
    { shopifyProductId: mapped.shopifyProductId, entity: "product" },
  );

  const variantsUpserted = await upsertVariants(db, product.id, mapped.variants, {
    syncRunId: options.syncRunId,
    currencyCode: options.currencyCode,
    now,
    log,
  });

  const imagesUpserted = await reconcileImages(db, product.id, mapped.images);

  return { productId: product.id, applied: true, variantsUpserted, imagesUpserted };
}

export async function upsertVariants(
  db: Db,
  productId: string,
  variants: MappedVariant[],
  options: { syncRunId: string; currencyCode: string; now?: Date; log?: Logger },
): Promise<number> {
  const now = options.now ?? new Date();
  let count = 0;

  for (const variant of variants) {
    const existing = await db.productVariant.findUnique({
      where: { shopifyVariantId: variant.shopifyVariantId },
      select: { id: true, shopifyUpdatedAt: true },
    });

    if (existing && !shouldApplyUpdate(variant.shopifyUpdatedAt, existing.shopifyUpdatedAt)) {
      await db.productVariant.update({
        where: { id: existing.id },
        data: { lastSyncRunId: options.syncRunId, syncedAt: now },
      });
      continue;
    }

    const writable = {
      productId,
      title: variant.title,
      sku: variant.sku,
      position: variant.position,
      // Strings, straight into DECIMAL(18,4). Prisma accepts a decimal string
      // and never routes it through a float.
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
      currencyCode: options.currencyCode,
      inventoryQuantity: variant.inventoryQuantity,
      inventoryTracked: variant.inventoryTracked,
      inventoryPolicy: variant.inventoryPolicy,
      isActive: true,
      deactivatedAt: null,
      deactivationReason: null,
      shopifyUpdatedAt: variant.shopifyUpdatedAt,
      lastSyncRunId: options.syncRunId,
      syncedAt: now,
    };

    await withUniqueRetry(
      () =>
        db.productVariant.upsert({
          where: { shopifyVariantId: variant.shopifyVariantId },
          create: { shopifyVariantId: variant.shopifyVariantId, ...writable },
          update: writable,
          select: { id: true },
        }),
      () =>
        db.productVariant.update({
          where: { shopifyVariantId: variant.shopifyVariantId },
          data: writable,
          select: { id: true },
        }),
      options.log,
      { shopifyVariantId: variant.shopifyVariantId, entity: "variant" },
    );

    count += 1;
  }

  return count;
}

/**
 * Images are reconciled, not merely upserted: an image removed in Shopify must
 * disappear locally, and images are not referenced by order history, so a hard
 * delete is safe here in a way it never is for a variant.
 */
async function reconcileImages(
  db: Db,
  productId: string,
  images: MappedProduct["images"],
): Promise<number> {
  for (const image of images) {
    const writable = {
      productId,
      url: image.url,
      altText: image.altText,
      position: image.position,
    };
    await withUniqueRetry(
      () =>
        db.productImage.upsert({
          where: { shopifyImageId: image.shopifyImageId },
          create: { shopifyImageId: image.shopifyImageId, ...writable },
          update: writable,
          select: { id: true },
        }),
      () =>
        db.productImage.update({
          where: { shopifyImageId: image.shopifyImageId },
          data: writable,
          select: { id: true },
        }),
    );
  }

  const keep = images.map((image) => image.shopifyImageId);
  await db.productImage.deleteMany({
    where: { productId, shopifyImageId: keep.length > 0 ? { notIn: keep } : undefined },
  });

  return images.length;
}

/** Marks a variant chain finished: the stored variant set is now complete. */
export async function markVariantSyncComplete(db: Db, productId: string): Promise<void> {
  await db.product.update({
    where: { id: productId },
    data: { variantSyncComplete: true, variantSyncCursor: null },
  });
}

/** Records progress through a variant chain so a crash resumes, not restarts. */
export async function saveVariantCursor(
  db: Db,
  productId: string,
  cursor: string | null,
): Promise<void> {
  await db.product.update({
    where: { id: productId },
    data: { variantSyncComplete: false, variantSyncCursor: cursor },
  });
}

export interface SweepResult {
  productsDeactivated: number;
  variantsDeactivated: number;
}

/**
 * Deactivate everything the completed FULL run did not stamp.
 *
 * NOT hard deletion: `OrderItem.variantId` points at variants, and a catalog
 * change must never cascade into financial history (ARCHITECTURE §5).
 *
 * The NULL-safe predicate is required, not stylistic -- see `isStaleAfterRun`.
 * Variants are deactivated alongside their product so the invariant
 * "Product.isActive = false => all its variants are inactive" holds; leaving a
 * live variant under a dead product is exactly the bug that produces an
 * orderable item nobody can find.
 *
 * Callers MUST gate this with `canSweep`.
 */
export async function sweepMissingProducts(
  db: Db,
  syncRunId: string,
  now: Date = new Date(),
): Promise<SweepResult> {
  const stale = {
    isActive: true,
    OR: [{ lastSyncRunId: null }, { lastSyncRunId: { not: syncRunId } }],
  };

  const doomed = await db.product.findMany({ where: stale, select: { id: true } });
  if (doomed.length === 0) return { productsDeactivated: 0, variantsDeactivated: 0 };

  const ids = doomed.map((p) => p.id);

  const variants = await db.productVariant.updateMany({
    where: { productId: { in: ids }, isActive: true },
    data: { isActive: false, deactivatedAt: now, deactivationReason: "MISSING_FROM_SYNC" },
  });

  const products = await db.product.updateMany({
    where: { id: { in: ids } },
    data: { isActive: false, deactivatedAt: now, deactivationReason: "MISSING_FROM_SYNC" },
  });

  return { productsDeactivated: products.count, variantsDeactivated: variants.count };
}
