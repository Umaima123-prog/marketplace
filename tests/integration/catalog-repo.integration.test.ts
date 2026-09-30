/**
 * The sync repository against real MySQL.
 *
 * These cover what a fake Prisma client cannot: that the field names are right,
 * that the unique constraints exist and fire, that a real P2002 is raised and
 * handled, that DECIMAL round-trips without touching a float, and that the
 * NULL-safe sweep predicate actually selects never-stamped rows in SQL.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  markVariantSyncComplete,
  saveVariantCursor,
  sweepMissingProducts,
  upsertProduct,
  upsertVariants,
  withUniqueRetry,
} from "@/src/lib/sync/catalog-repo";
import { mapProduct } from "@/src/lib/sync/product-mapper";
import type { MappedProduct } from "@/src/lib/sync/product-mapper";

import { productNode, variantNode } from "../unit/fixtures";
import { disconnect, resetDatabase, testPrisma } from "./setup";

const db = testPrisma;

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnect();
});

/** A run row to stamp rows with; the FK is not enforced but the id must be real. */
async function createRun(overrides: Partial<{ mode: "FULL" | "INCREMENTAL" }> = {}) {
  return db.syncRun.create({
    data: {
      mode: overrides.mode ?? "FULL",
      status: "RUNNING",
      activeLock: "ACTIVE",
      triggeredBy: "MANUAL",
    },
    select: { id: true },
  });
}

function product(overrides: Record<string, unknown> = {}): MappedProduct {
  return mapProduct(productNode(overrides), "p");
}

describe("product create and upsert", () => {
  it("creates a product with its variants and images", async () => {
    const run = await createRun();
    const result = await upsertProduct(db, product(), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });

    expect(result.applied).toBe(true);

    const stored = await db.product.findUniqueOrThrow({
      where: { shopifyProductId: "gid://shopify/Product/100" },
      include: { variants: true, images: true },
    });

    expect(stored.title).toBe("A Product");
    expect(stored.handle).toBe("a-product");
    expect(stored.descriptionHtml).toBe("<p>Nice</p>");
    expect(stored.status).toBe("ACTIVE");
    expect(stored.isActive).toBe(true);
    expect(stored.lastSyncRunId).toBe(run.id);
    expect(stored.variants).toHaveLength(1);
    expect(stored.images).toHaveLength(1);
    expect(stored.variantSyncComplete).toBe(true);
  });

  it("round-trips money through DECIMAL(18,4) without a float", async () => {
    const run = await createRun();
    await upsertProduct(
      db,
      product({
        variants: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [variantNode({ price: "0.1", compareAtPrice: "1234567890123.4567" })],
        },
      }),
      { syncRunId: run.id, currencyCode: "PKR" },
    );

    const variant = await db.productVariant.findFirstOrThrow();
    // 0.1 is not representable in binary floating point; it survives here
    // because it was never converted to one.
    expect(variant.price.toString()).toBe("0.1");
    expect(variant.compareAtPrice?.toString()).toBe("1234567890123.4567");
  });

  it("is idempotent: a repeated upsert changes nothing and creates no duplicate", async () => {
    const run = await createRun();
    const mapped = product();

    await upsertProduct(db, mapped, { syncRunId: run.id, currencyCode: "PKR" });
    const first = await db.product.findUniqueOrThrow({
      where: { shopifyProductId: mapped.shopifyProductId },
    });

    await upsertProduct(db, mapped, { syncRunId: run.id, currencyCode: "PKR" });
    await upsertProduct(db, mapped, { syncRunId: run.id, currencyCode: "PKR" });

    const all = await db.product.findMany();
    const variants = await db.productVariant.findMany();
    expect(all).toHaveLength(1);
    expect(variants).toHaveLength(1);
    expect(all[0].id).toBe(first.id);
    expect(all[0].shopifyUpdatedAt.toISOString()).toBe(first.shopifyUpdatedAt.toISOString());
  });

  it("applies a newer payload and ignores an older one", async () => {
    const run = await createRun();
    await upsertProduct(db, product(), { syncRunId: run.id, currencyCode: "PKR" });

    await upsertProduct(
      db,
      product({ title: "Newer", updatedAt: "2026-09-21T10:00:00Z" }),
      { syncRunId: run.id, currencyCode: "PKR" },
    );
    expect((await db.product.findFirstOrThrow()).title).toBe("Newer");

    // An older page arriving late must not clobber the newer row.
    const stale = await upsertProduct(
      db,
      product({ title: "Older", updatedAt: "2026-09-19T10:00:00Z" }),
      { syncRunId: run.id, currencyCode: "PKR" },
    );
    expect(stale.applied).toBe(false);
    expect((await db.product.findFirstOrThrow()).title).toBe("Newer");
  });

  it("still stamps the run id when it skips a stale payload", async () => {
    // The run SAW the product, so a later sweep must not treat it as missing.
    const first = await createRun();
    await upsertProduct(db, product(), { syncRunId: first.id, currencyCode: "PKR" });

    // Release the first lock BEFORE starting the second run: UNIQUE(activeLock)
    // is real here, so two RUNNING rows cannot coexist -- which is the whole
    // point of the constraint.
    await db.syncRun.update({ where: { id: first.id }, data: { activeLock: null, status: "COMPLETED" } });
    const second = await createRun();

    await upsertProduct(db, product({ updatedAt: "2026-09-01T00:00:00Z" }), {
      syncRunId: second.id,
      currencyCode: "PKR",
    });

    expect((await db.product.findFirstOrThrow()).lastSyncRunId).toBe(second.id);
  });

  it("reconciles images: new ones appear, removed ones disappear", async () => {
    const run = await createRun();
    await upsertProduct(
      db,
      product({
        media: {
          nodes: [
            { id: "m1", image: { url: "https://cdn/1.jpg", altText: "one" } },
            { id: "m2", image: { url: "https://cdn/2.jpg", altText: null } },
          ],
        },
      }),
      { syncRunId: run.id, currencyCode: "PKR" },
    );
    expect(await db.productImage.count()).toBe(2);

    await upsertProduct(
      db,
      product({
        updatedAt: "2026-09-22T10:00:00Z",
        media: { nodes: [{ id: "m2", image: { url: "https://cdn/2b.jpg", altText: "two" } }] },
      }),
      { syncRunId: run.id, currencyCode: "PKR" },
    );

    const images = await db.productImage.findMany();
    expect(images).toHaveLength(1);
    expect(images[0].shopifyImageId).toBe("m2");
    expect(images[0].url).toBe("https://cdn/2b.jpg");
  });
});

describe("variant create and upsert", () => {
  it("creates variants and updates them in place", async () => {
    const run = await createRun();
    const created = await upsertProduct(db, product(), { syncRunId: run.id, currencyCode: "PKR" });

    await upsertVariants(
      db,
      created.productId,
      [
        {
          shopifyVariantId: "gid://shopify/ProductVariant/1",
          title: "Renamed",
          sku: "SKU-NEW",
          position: 1,
          price: "24.50",
          compareAtPrice: "30.00",
          inventoryQuantity: 7,
          inventoryTracked: false,
          inventoryPolicy: "CONTINUE",
          shopifyUpdatedAt: new Date("2026-09-22T00:00:00Z"),
          selectedOptions: [],
        },
      ],
      { syncRunId: run.id, currencyCode: "PKR", productIsActive: true },
    );

    const variants = await db.productVariant.findMany();
    expect(variants).toHaveLength(1);
    expect(variants[0].title).toBe("Renamed");
    expect(variants[0].sku).toBe("SKU-NEW");
    expect(variants[0].price.toString()).toBe("24.5");
    expect(variants[0].inventoryQuantity).toBe(7);
    expect(variants[0].inventoryTracked).toBe(false);
    expect(variants[0].inventoryPolicy).toBe("CONTINUE");
  });

  it("enforces one row per Shopify variant id", async () => {
    const run = await createRun();
    const created = await upsertProduct(db, product(), { syncRunId: run.id, currencyCode: "PKR" });

    await expect(
      db.productVariant.create({
        data: {
          productId: created.productId,
          shopifyVariantId: "gid://shopify/ProductVariant/1", // already exists
          title: "Duplicate",
          price: "1.00",
          currencyCode: "PKR",
          shopifyUpdatedAt: new Date(),
          syncedAt: new Date(),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("tracks variant pagination state across a chain", async () => {
    const run = await createRun();
    const created = await upsertProduct(
      db,
      product({ variants: { pageInfo: { hasNextPage: true, endCursor: "V100" }, nodes: [variantNode()] } }),
      { syncRunId: run.id, currencyCode: "PKR" },
    );

    let stored = await db.product.findUniqueOrThrow({ where: { id: created.productId } });
    expect(stored.variantSyncComplete).toBe(false);
    expect(stored.variantSyncCursor).toBe("V100");

    await saveVariantCursor(db, created.productId, "V200");
    stored = await db.product.findUniqueOrThrow({ where: { id: created.productId } });
    expect(stored.variantSyncComplete).toBe(false);
    expect(stored.variantSyncCursor).toBe("V200");

    await markVariantSyncComplete(db, created.productId);
    stored = await db.product.findUniqueOrThrow({ where: { id: created.productId } });
    expect(stored.variantSyncComplete).toBe(true);
    expect(stored.variantSyncCursor).toBeNull();
  });
});

describe("variant visibility follows the parent product", () => {
  /**
   * The invariant: `Product.isActive = false` implies every one of its variants is
   * inactive. The sweep path always honoured it; the STATUS path did not, because
   * the variant upsert hard-coded `isActive: true`. Archiving a product in Shopify
   * therefore left live variants under a dead product -- 26 of them in the
   * development database -- which is exactly the "orderable item nobody can find"
   * this file's sweep comment warns about.
   *
   * Nothing customer-facing depended on it (both the storefront filter and
   * `evaluateLine` check the parent as well), so these tests pin the database
   * state rather than a user-visible symptom.
   */

  it("keeps variants active for an ACTIVE product", async () => {
    const run = await createRun();
    await upsertProduct(db, product({ status: "ACTIVE" }), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });

    const p = await db.product.findFirstOrThrow({ include: { variants: true } });
    expect(p.isActive).toBe(true);
    expect(p.variants.length).toBeGreaterThan(0);
    for (const v of p.variants) {
      expect(v.isActive).toBe(true);
      expect(v.deactivatedAt).toBeNull();
      expect(v.deactivationReason).toBeNull();
    }
  });

  it("deactivates variants when a product goes ACTIVE -> ARCHIVED", async () => {
    const run = await createRun();
    await upsertProduct(db, product({ status: "ACTIVE" }), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });

    const before = await db.product.findFirstOrThrow({ include: { variants: true } });
    expect(before.variants.every((v) => v.isActive)).toBe(true);

    // The same product, now archived upstream. `updatedAt` moves forward so the
    // shopifyUpdatedAt guard does not skip the write.
    await upsertProduct(
      db,
      product({ status: "ARCHIVED", updatedAt: "2026-10-01T00:00:00Z" }),
      { syncRunId: run.id, currencyCode: "PKR" },
    );

    const after = await db.product.findFirstOrThrow({ include: { variants: true } });
    expect(after.status).toBe("ARCHIVED");
    expect(after.isActive).toBe(false);
    expect(after.variants.length).toBe(before.variants.length);
    for (const v of after.variants) {
      expect(v.isActive).toBe(false);
      expect(v.deactivatedAt).not.toBeNull();
      expect(v.deactivationReason).toBe("SHOPIFY_STATUS");
    }
  });

  it("deactivates variants when a product goes ACTIVE -> DRAFT", async () => {
    const run = await createRun();
    await upsertProduct(db, product({ status: "ACTIVE" }), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });

    await upsertProduct(db, product({ status: "DRAFT", updatedAt: "2026-10-01T00:00:00Z" }), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });

    const after = await db.product.findFirstOrThrow({ include: { variants: true } });
    expect(after.status).toBe("DRAFT");
    expect(after.isActive).toBe(false);
    for (const v of after.variants) {
      expect(v.isActive).toBe(false);
      expect(v.deactivationReason).toBe("SHOPIFY_STATUS");
    }
  });

  it("reactivates variants when a product returns to ACTIVE", async () => {
    // The mirror case: the derivation must work in both directions, or a product
    // un-archived in Shopify would come back unsellable.
    const run = await createRun();
    await upsertProduct(db, product({ status: "ARCHIVED" }), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });

    const archived = await db.product.findFirstOrThrow({ include: { variants: true } });
    expect(archived.variants.every((v) => !v.isActive)).toBe(true);

    await upsertProduct(db, product({ status: "ACTIVE", updatedAt: "2026-10-01T00:00:00Z" }), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });

    const revived = await db.product.findFirstOrThrow({ include: { variants: true } });
    expect(revived.isActive).toBe(true);
    for (const v of revived.variants) {
      expect(v.isActive).toBe(true);
      expect(v.deactivatedAt).toBeNull();
      expect(v.deactivationReason).toBeNull();
    }
  });

  it("writes inactive variants for a product that is archived on first sight", async () => {
    // How the development store's seed data arrived: already ARCHIVED before the
    // first sync ever ran, so no transition was ever observed.
    const run = await createRun();
    await upsertProduct(db, product({ status: "ARCHIVED" }), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });

    const p = await db.product.findFirstOrThrow({ include: { variants: true } });
    expect(p.isActive).toBe(false);
    expect(p.variants.length).toBeGreaterThan(0);
    expect(p.variants.every((v) => v.isActive === false)).toBe(true);
  });

  it("leaves the sweep's own deactivation reason intact", async () => {
    // The sweep path was already correct and must stay distinguishable: a variant
    // removed upstream is MISSING_FROM_SYNC, not SHOPIFY_STATUS.
    const first = await createRun();
    await upsertProduct(db, product({ status: "ACTIVE" }), {
      syncRunId: first.id,
      currencyCode: "PKR",
    });

    // `activeLock` is UNIQUE -- one run holds it at a time -- so the first run is
    // finalised before the next begins, exactly as the worker does.
    await db.syncRun.update({
      where: { id: first.id },
      data: { activeLock: null, status: "COMPLETED" },
    });

    const second = await createRun();
    await sweepMissingProducts(db, second.id);

    const p = await db.product.findFirstOrThrow({ include: { variants: true } });
    expect(p.isActive).toBe(false);
    for (const v of p.variants) {
      expect(v.isActive).toBe(false);
      expect(v.deactivationReason).toBe("MISSING_FROM_SYNC");
    }
  });
});

describe("P2002 race handling against real MySQL", () => {
  it("resolves a genuine unique-constraint collision into an update", async () => {
    const run = await createRun();
    const mapped = product();

    // Pre-create the row so the upsert's INSERT path collides for real, which
    // is what the losing side of a two-page race experiences.
    await db.product.create({
      data: {
        shopifyProductId: mapped.shopifyProductId,
        handle: mapped.handle,
        title: "Created by the other page",
        status: "ACTIVE",
        shopifyUpdatedAt: new Date("2026-09-01T00:00:00Z"),
        syncedAt: new Date(),
      },
    });

    let collided = false;
    const result = await withUniqueRetry(
      async () => {
        collided = true;
        return db.product.create({
          data: {
            shopifyProductId: mapped.shopifyProductId,
            handle: `${mapped.handle}-2`,
            title: "Loser of the race",
            status: "ACTIVE",
            shopifyUpdatedAt: new Date(),
            syncedAt: new Date(),
          },
          select: { id: true },
        });
      },
      () =>
        db.product.update({
          where: { shopifyProductId: mapped.shopifyProductId },
          data: { title: "Resolved as update", lastSyncRunId: run.id },
          select: { id: true },
        }),
    );

    expect(collided).toBe(true);
    expect(result.id).toBeTruthy();
    expect(await db.product.count()).toBe(1);
    expect((await db.product.findFirstOrThrow()).title).toBe("Resolved as update");
  });

  it("upsertProduct survives a concurrent insert of the same product", async () => {
    const run = await createRun();
    const mapped = product();

    // Two writers, same new product, no coordination -- the exact race two page
    // jobs hit. Both must succeed and exactly one row must exist.
    const [a, b] = await Promise.allSettled([
      upsertProduct(db, mapped, { syncRunId: run.id, currencyCode: "PKR" }),
      upsertProduct(db, mapped, { syncRunId: run.id, currencyCode: "PKR" }),
    ]);

    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    expect(await db.product.count()).toBe(1);
    expect(await db.productVariant.count()).toBe(1);
  });
});

describe("soft deactivation", () => {
  it("marks an archived product inactive with the Shopify reason", async () => {
    const run = await createRun();
    await upsertProduct(db, product(), { syncRunId: run.id, currencyCode: "PKR" });

    await upsertProduct(
      db,
      product({ status: "ARCHIVED", updatedAt: "2026-09-25T00:00:00Z" }),
      { syncRunId: run.id, currencyCode: "PKR" },
    );

    const stored = await db.product.findFirstOrThrow();
    expect(stored.isActive).toBe(false);
    expect(stored.status).toBe("ARCHIVED");
    expect(stored.deactivationReason).toBe("SHOPIFY_STATUS");
    expect(stored.deactivatedAt).not.toBeNull();
    // Never hard-deleted: OrderItem rows will reference these.
    expect(await db.product.count()).toBe(1);
  });
});

describe("the final sweep", () => {
  async function seedTwoProducts() {
    const oldRun = await createRun();
    await upsertProduct(db, product(), { syncRunId: oldRun.id, currencyCode: "PKR" });
    await upsertProduct(
      db,
      product({ id: "gid://shopify/Product/200", handle: "b", variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [variantNode({ id: "gid://shopify/ProductVariant/9" })] } }),
      { syncRunId: oldRun.id, currencyCode: "PKR" },
    );
    await db.syncRun.update({ where: { id: oldRun.id }, data: { activeLock: null, status: "COMPLETED" } });
    return oldRun;
  }

  it("deactivates only products the new run did not stamp", async () => {
    await seedTwoProducts();
    const newRun = await createRun();

    // The new run sees only the first product.
    await upsertProduct(db, product({ updatedAt: "2026-09-26T00:00:00Z" }), {
      syncRunId: newRun.id,
      currencyCode: "PKR",
    });

    const result = await sweepMissingProducts(db, newRun.id);

    expect(result.productsDeactivated).toBe(1);
    const survivor = await db.product.findUniqueOrThrow({
      where: { shopifyProductId: "gid://shopify/Product/100" },
    });
    const swept = await db.product.findUniqueOrThrow({
      where: { shopifyProductId: "gid://shopify/Product/200" },
    });
    expect(survivor.isActive).toBe(true);
    expect(swept.isActive).toBe(false);
    expect(swept.deactivationReason).toBe("MISSING_FROM_SYNC");
  });

  it("deactivates the variants of a swept product too", async () => {
    await seedTwoProducts();
    const newRun = await createRun();
    await upsertProduct(db, product({ updatedAt: "2026-09-26T00:00:00Z" }), {
      syncRunId: newRun.id,
      currencyCode: "PKR",
    });

    const result = await sweepMissingProducts(db, newRun.id);
    expect(result.variantsDeactivated).toBe(1);

    const sweptProduct = await db.product.findUniqueOrThrow({
      where: { shopifyProductId: "gid://shopify/Product/200" },
      include: { variants: true },
    });
    // The invariant "inactive product => inactive variants" holds in the
    // database, not just in intent.
    expect(sweptProduct.variants.every((v) => !v.isActive)).toBe(true);
  });

  it("catches never-stamped rows, which a naive `!=` predicate would skip in SQL", async () => {
    // lastSyncRunId IS NULL: `last_sync_run_id != 'run'` evaluates to NULL for
    // this row, and NULL is not TRUE, so the obvious query misses it entirely.
    await db.product.create({
      data: {
        shopifyProductId: "gid://shopify/Product/999",
        handle: "never-stamped",
        title: "Never stamped",
        status: "ACTIVE",
        isActive: true,
        shopifyUpdatedAt: new Date(),
        syncedAt: new Date(),
        lastSyncRunId: null,
      },
    });

    const run = await createRun();
    const result = await sweepMissingProducts(db, run.id);

    expect(result.productsDeactivated).toBe(1);
    expect((await db.product.findFirstOrThrow()).isActive).toBe(false);
  });

  it("does nothing when the run saw everything", async () => {
    const run = await createRun();
    await upsertProduct(db, product(), { syncRunId: run.id, currencyCode: "PKR" });

    const result = await sweepMissingProducts(db, run.id);
    expect(result).toEqual({ productsDeactivated: 0, variantsDeactivated: 0 });
    expect((await db.product.findFirstOrThrow()).isActive).toBe(true);
  });

  it("leaves already-inactive products alone rather than re-stamping them", async () => {
    const run = await createRun();
    await db.product.create({
      data: {
        shopifyProductId: "gid://shopify/Product/500",
        handle: "already-off",
        title: "Already off",
        status: "ARCHIVED",
        isActive: false,
        deactivatedAt: new Date("2026-01-01T00:00:00Z"),
        deactivationReason: "SHOPIFY_STATUS",
        shopifyUpdatedAt: new Date(),
        syncedAt: new Date(),
      },
    });

    const result = await sweepMissingProducts(db, run.id);
    expect(result.productsDeactivated).toBe(0);

    const stored = await db.product.findFirstOrThrow();
    expect(stored.deactivationReason).toBe("SHOPIFY_STATUS");
    expect(stored.deactivatedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});
