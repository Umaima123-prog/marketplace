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
  loadImageIndex,
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
          shopifyImageId: null,
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

describe("variants removed in Shopify are reconciled", () => {
  /**
   * Variants used to be upserted and never reconciled, so a variant DELETED in
   * Shopify stayed active locally forever. The storefront would keep offering it and
   * the checkout would accept it -- it passes every condition in `evaluateLine` --
   * and submission would then hand Shopify a `variantId` that no longer exists,
   * which fails PERMANENTLY after the customer has seen a confirmation page.
   *
   * Deactivated rather than deleted: `OrderItem.variantId` may point at the row.
   */

  /** A product node carrying exactly these variant ids, with a movable timestamp. */
  function withVariants(ids: string[], updatedAt: string, hasNextPage = false) {
    return product({
      updatedAt,
      variants: {
        pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor-1" : null },
        nodes: ids.map((id, index) =>
          variantNode({ id: `gid://shopify/ProductVariant/${id}`, sku: `SKU-${id}`, position: index + 1 }),
        ),
      },
    });
  }

  it("deactivates a variant Shopify no longer reports", async () => {
    const run = await createRun();
    await upsertProduct(db, withVariants(["A", "B"], "2026-09-01T00:00:00Z"), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });

    const before = await db.productVariant.findMany({ orderBy: { sku: "asc" } });
    expect(before.map((v) => v.sku)).toEqual(["SKU-A", "SKU-B"]);
    expect(before.every((v) => v.isActive)).toBe(true);

    // B has been deleted upstream. The product itself is unchanged and still ACTIVE.
    const result = await upsertProduct(db, withVariants(["A"], "2026-10-01T00:00:00Z"), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });

    expect(result.variantsDeactivated).toBe(1);

    const after = await db.productVariant.findMany({ orderBy: { sku: "asc" } });
    // Not deleted: the row survives so OrderItem.variantId keeps pointing at it.
    expect(after.map((v) => v.sku)).toEqual(["SKU-A", "SKU-B"]);

    const gone = after.find((v) => v.sku === "SKU-B")!;
    expect(gone.isActive).toBe(false);
    expect(gone.deactivationReason).toBe("MISSING_FROM_SYNC");
    expect(gone.deactivatedAt).not.toBeNull();
  });

  it("leaves the variants that are still present completely untouched", async () => {
    const run = await createRun();
    await upsertProduct(db, withVariants(["A", "B"], "2026-09-01T00:00:00Z"), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });

    const before = await db.productVariant.findFirstOrThrow({ where: { sku: "SKU-A" } });

    await upsertProduct(db, withVariants(["A"], "2026-10-01T00:00:00Z"), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });

    const after = await db.productVariant.findFirstOrThrow({ where: { sku: "SKU-A" } });
    expect(after.isActive).toBe(true);
    expect(after.deactivatedAt).toBeNull();
    expect(after.deactivationReason).toBeNull();
    // Price, stock and identity are the survivor's own and must not move.
    expect(after.price.toString()).toBe(before.price.toString());
    expect(after.inventoryQuantity).toBe(before.inventoryQuantity);
    expect(after.title).toBe(before.title);
    expect(after.id).toBe(before.id);
  });

  it("deactivates nothing while variant pagination is incomplete", async () => {
    // The dangerous case. A >100-variant product arrives as page 1 only; reconciling
    // against that payload would deactivate pages 2..n on every single sync.
    const run = await createRun();
    await upsertProduct(db, withVariants(["A", "B", "C"], "2026-09-01T00:00:00Z"), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });

    const result = await upsertProduct(
      db,
      withVariants(["A"], "2026-10-01T00:00:00Z", /* hasNextPage */ true),
      { syncRunId: run.id, currencyCode: "PKR" },
    );

    expect(result.variantsDeactivated).toBe(0);

    const after = await db.productVariant.findMany({ orderBy: { sku: "asc" } });
    expect(after.every((v) => v.isActive)).toBe(true);
    // And the product is correctly marked as mid-chain.
    const p = await db.product.findFirstOrThrow();
    expect(p.variantSyncComplete).toBe(false);
  });

  it("reconciles once pagination completes", async () => {
    // The other half of the gate: when the chain finishes and the payload is whole,
    // the missing variant must finally be deactivated.
    const run = await createRun();
    await upsertProduct(db, withVariants(["A", "B"], "2026-09-01T00:00:00Z"), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });
    await upsertProduct(db, withVariants(["A"], "2026-10-01T00:00:00Z", true), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });
    expect((await db.productVariant.findMany()).every((v) => v.isActive)).toBe(true);

    const result = await upsertProduct(db, withVariants(["A"], "2026-10-02T00:00:00Z", false), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });

    expect(result.variantsDeactivated).toBe(1);
    expect((await db.productVariant.findFirstOrThrow({ where: { sku: "SKU-B" } })).isActive).toBe(false);
  });

  it("keeps an OrderItem's link to a deactivated variant", async () => {
    // Why deactivate instead of delete: a variant that has been ordered is still
    // referenced by financial history.
    const run = await createRun();
    await upsertProduct(db, withVariants(["A", "B"], "2026-09-01T00:00:00Z"), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });
    const ordered = await db.productVariant.findFirstOrThrow({ where: { sku: "SKU-B" } });

    await db.order.create({
      data: {
        reference: "COD-RECONCILE",
        publicToken: "token-reconcile-xxxxxxxxxxxx",
        idempotencyKey: "key-reconcile-0000000000",
        requestFingerprint: "f".repeat(64),
        submissionKey: "submission-reconcile",
        status: "SYNCED",
        paymentMethod: "COD",
        currencyCode: "PKR",
        subtotal: "10.00",
        grandTotal: "10.00",
        customerName: "Test Person",
        customerPhone: "+920000000000",
        addressLine1: "1 Test Road",
        city: "Testville",
        countryCode: "PK",
        items: {
          create: [
            {
              variantId: ordered.id,
              shopifyVariantId: ordered.shopifyVariantId,
              shopifyProductId: "gid://shopify/Product/1",
              productTitle: "Test",
              variantTitle: ordered.title,
              sku: ordered.sku,
              unitPrice: "10.00",
              quantity: 1,
              lineTotal: "10.00",
            },
          ],
        },
      },
    });

    await upsertProduct(db, withVariants(["A"], "2026-10-01T00:00:00Z"), {
      syncRunId: run.id,
      currencyCode: "PKR",
    });

    const item = await db.orderItem.findFirstOrThrow();
    // The link survives, and so do the snapshots that make the order readable.
    expect(item.variantId).toBe(ordered.id);
    expect(item.sku).toBe(ordered.sku);
    expect(item.unitPrice.toString()).toBe("10");
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

/**
 * Variant-specific images, end to end through the repository.
 *
 * The mapping is a foreign key to the product's own ProductImage rows, so these
 * tests are about referential behaviour only a real database shows: that the id
 * resolves, that re-running duplicates no image rows, that an image Shopify
 * drops clears the reference instead of blocking its own delete, and that a
 * partial variant payload cannot corrupt it.
 */
describe("variant image mapping", () => {
  /**
   * A second run. sync_runs.activeLock is UNIQUE, so the first run has to be
   * finalised before another can exist -- the same constraint that caught an
   * earlier test trying to hold two.
   */
  async function nextRun() {
    await db.syncRun.updateMany({
      where: { activeLock: "ACTIVE" },
      data: { activeLock: null, status: "COMPLETED", finishedAt: new Date() },
    });
    return createRun();
  }

  const MEDIA_BLACK = { id: "gid://shopify/MediaImage/1", image: { url: "https://cdn/black.jpg", altText: "black" } };
  const MEDIA_WHITE = { id: "gid://shopify/MediaImage/2", image: { url: "https://cdn/white.jpg", altText: "white" } };

  /** Two product media; two variants assigned one each, and a third with none. */
  function withVariantImages(overrides: Record<string, unknown> = {}) {
    return product({
      media: { nodes: [MEDIA_BLACK, MEDIA_WHITE] },
      variants: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          variantNode({
            id: "gid://shopify/ProductVariant/1",
            sku: "BLACK",
            media: { nodes: [{ id: MEDIA_BLACK.id }] },
          }),
          variantNode({
            id: "gid://shopify/ProductVariant/2",
            sku: "WHITE",
            position: 2,
            media: { nodes: [{ id: MEDIA_WHITE.id }] },
          }),
          // No assigned image: the fallback case, and the majority in the real
          // catalog (11 of 19).
          variantNode({ id: "gid://shopify/ProductVariant/3", sku: "NOIMAGE", position: 3 }),
        ],
      },
      ...overrides,
    });
  }

  function storedVariants() {
    return db.productVariant.findMany({
      orderBy: { position: "asc" },
      select: { sku: true, imageId: true, image: { select: { shopifyImageId: true, url: true } } },
    });
  }

  it("syncs the variant to image mapping from the Shopify payload", async () => {
    const run = await createRun();
    await upsertProduct(db, withVariantImages(), { syncRunId: run.id, currencyCode: "PKR" });

    const variants = await storedVariants();
    expect(variants.map((v) => [v.sku, v.image?.url ?? null])).toEqual([
      ["BLACK", "https://cdn/black.jpg"],
      ["WHITE", "https://cdn/white.jpg"],
      ["NOIMAGE", null],
    ]);

    // Every mapping points at one of this product's own image rows.
    const imageIds = new Set((await db.productImage.findMany({ select: { id: true } })).map((i) => i.id));
    for (const v of variants) {
      if (v.imageId) expect(imageIds.has(v.imageId)).toBe(true);
    }
  });

  it("stores no mapping for a variant with no assigned image", async () => {
    const run = await createRun();
    await upsertProduct(db, withVariantImages(), { syncRunId: run.id, currencyCode: "PKR" });

    const noImage = await db.productVariant.findFirstOrThrow({ where: { sku: "NOIMAGE" } });
    expect(noImage.imageId).toBeNull();
  });

  it("maps images on the run that CREATES the product, not one sync later", async () => {
    // Regression guard: variants used to be written before the images existed,
    // so a new product's mapping stayed null until the following sync.
    const run = await createRun();
    await upsertProduct(db, withVariantImages(), { syncRunId: run.id, currencyCode: "PKR" });

    const black = await db.productVariant.findFirstOrThrow({
      where: { sku: "BLACK" },
      select: { image: { select: { url: true } } },
    });
    expect(black.image?.url).toBe("https://cdn/black.jpg");
  });

  it("re-running the sync duplicates no image rows and keeps the mapping stable", async () => {
    const run = await createRun();
    await upsertProduct(db, withVariantImages(), { syncRunId: run.id, currencyCode: "PKR" });
    const firstVariants = await storedVariants();
    const firstImages = await db.productImage.findMany({ orderBy: { position: "asc" } });

    const run2 = await nextRun();
    await upsertProduct(db, withVariantImages(), { syncRunId: run2.id, currencyCode: "PKR" });

    const secondVariants = await storedVariants();
    const secondImages = await db.productImage.findMany({ orderBy: { position: "asc" } });

    // Upserted by shopifyImageId, not re-created: same count, same row ids, and
    // the variants still reference those same rows.
    expect(await db.productImage.count()).toBe(2);
    expect(secondImages.map((i) => i.id)).toEqual(firstImages.map((i) => i.id));
    expect(secondVariants.map((v) => v.imageId)).toEqual(firstVariants.map((v) => v.imageId));
  });

  it("clears the mapping when Shopify stops assigning an image", async () => {
    const run = await createRun();
    await upsertProduct(db, withVariantImages(), { syncRunId: run.id, currencyCode: "PKR" });

    // Same images, but the variant no longer has media. A newer updatedAt, or
    // the payload would be skipped as stale.
    const run2 = await nextRun();
    await upsertProduct(
      db,
      product({
        updatedAt: "2026-09-25T10:00:00Z",
        media: { nodes: [MEDIA_BLACK, MEDIA_WHITE] },
        variants: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            variantNode({
              id: "gid://shopify/ProductVariant/1",
              sku: "BLACK",
              updatedAt: "2026-09-25T10:00:00Z",
            }),
          ],
        },
      }),
      { syncRunId: run2.id, currencyCode: "PKR" },
    );

    const black = await db.productVariant.findFirstOrThrow({ where: { sku: "BLACK" } });
    expect(black.imageId).toBeNull();
  });

  it("survives the image it references being deleted by the reconcile", async () => {
    const run = await createRun();
    await upsertProduct(db, withVariantImages(), { syncRunId: run.id, currencyCode: "PKR" });

    // Shopify drops the white image. reconcileImages hard-deletes it, and the FK
    // is ON DELETE SET NULL -- so the variant survives and degrades to the
    // fallback rather than blocking the delete or being deleted with it.
    const run2 = await nextRun();
    await upsertProduct(
      db,
      product({
        updatedAt: "2026-09-25T10:00:00Z",
        media: { nodes: [MEDIA_BLACK] },
        variants: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            variantNode({
              id: "gid://shopify/ProductVariant/2",
              sku: "WHITE",
              position: 2,
              updatedAt: "2026-09-25T10:00:00Z",
              media: { nodes: [{ id: MEDIA_WHITE.id }] },
            }),
          ],
        },
      }),
      { syncRunId: run2.id, currencyCode: "PKR" },
    );

    const white = await db.productVariant.findFirstOrThrow({ where: { sku: "WHITE" } });
    expect(white.imageId).toBeNull();
    expect(await db.productImage.count()).toBe(1);
  });

  it("does not corrupt the mapping when variant pagination is incomplete", async () => {
    // The continuation chain writes no images, so it supplies no index, and
    // upsertVariants must then leave imageId exactly as it was.
    const run = await createRun();
    await upsertProduct(db, withVariantImages(), { syncRunId: run.id, currencyCode: "PKR" });

    const before = await storedVariants();
    expect(before.find((v) => v.sku === "BLACK")?.image?.url).toBe("https://cdn/black.jpg");

    const created = await db.product.findFirstOrThrow({ select: { id: true } });
    const run2 = await nextRun();

    await upsertVariants(
      db,
      created.id,
      [
        {
          shopifyVariantId: "gid://shopify/ProductVariant/1",
          title: "Black",
          sku: "BLACK",
          position: 1,
          price: "19.99",
          compareAtPrice: null,
          inventoryQuantity: 5,
          inventoryTracked: true,
          inventoryPolicy: "DENY",
          shopifyUpdatedAt: new Date("2026-09-26T00:00:00Z"),
          selectedOptions: [],
          // Even an explicit null must not clear it, because no index was given.
          shopifyImageId: null,
        },
      ],
      { syncRunId: run2.id, currencyCode: "PKR", productIsActive: true },
    );

    const after = await storedVariants();
    expect(after.find((v) => v.sku === "BLACK")?.image?.url).toBe("https://cdn/black.jpg");
    expect(after.map((v) => v.imageId)).toEqual(before.map((v) => v.imageId));
  });

  it("maps a continuation page once the index is supplied, as the worker does", async () => {
    const run = await createRun();
    await upsertProduct(db, withVariantImages(), { syncRunId: run.id, currencyCode: "PKR" });
    const created = await db.product.findFirstOrThrow({ select: { id: true } });

    // Exactly what processVariantSync does: read the index the page job stored,
    // then upsert the continuation page with it.
    const index = await loadImageIndex(db, created.id);
    expect(index.size).toBe(2);
    expect(index.get(MEDIA_WHITE.id)).toBeDefined();

    const run2 = await nextRun();
    await upsertVariants(
      db,
      created.id,
      [
        {
          shopifyVariantId: "gid://shopify/ProductVariant/4",
          title: "Page two",
          sku: "PAGE2",
          position: 4,
          price: "19.99",
          compareAtPrice: null,
          inventoryQuantity: 5,
          inventoryTracked: true,
          inventoryPolicy: "DENY",
          shopifyUpdatedAt: new Date("2026-09-26T00:00:00Z"),
          selectedOptions: [],
          shopifyImageId: MEDIA_WHITE.id,
        },
      ],
      {
        syncRunId: run2.id,
        currencyCode: "PKR",
        productIsActive: true,
        imageIdByShopifyImageId: index,
      },
    );

    const page2 = await db.productVariant.findFirstOrThrow({
      where: { sku: "PAGE2" },
      select: { image: { select: { url: true } } },
    });
    expect(page2.image?.url).toBe("https://cdn/white.jpg");
  });
});
