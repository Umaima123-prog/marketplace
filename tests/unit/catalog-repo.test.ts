/**
 * Upsert races and the sweep, against a fake Prisma client.
 *
 * A fake rather than a real database because the behaviour under test is the
 * repository's REACTION to what the database says: P2002 on a race, and the
 * exact shape of the sweep predicate. Both are decided in TypeScript, and both
 * are hard to provoke deterministically against real MySQL.
 */
import { describe, expect, it, vi } from "vitest";

import {
  sweepMissingProducts,
  upsertProduct,
  withUniqueRetry,
} from "@/src/lib/sync/catalog-repo";
import { mapProduct } from "@/src/lib/sync/product-mapper";
import type { Db } from "@/src/lib/sync/catalog-repo";

import { productNode } from "./fixtures";

/** Reads the `create` payload from the first prisma.upsert call. */
function upsertCreateArg(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const first = mock.mock.calls[0]?.[0];
  if (typeof first !== "object" || first === null || !("create" in first)) {
    throw new Error("upsert was not called with a create payload");
  }
  return (first as { create: Record<string, unknown> }).create;
}

/** Prisma's shape for a unique-constraint violation. */
function p2002(target = "shopifyProductId") {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: { target: [target] },
  });
}

describe("withUniqueRetry", () => {
  it("returns the first result when there is no race", async () => {
    const operation = vi.fn().mockResolvedValue("created");
    const onConflict = vi.fn();
    await expect(withUniqueRetry(operation, onConflict)).resolves.toBe("created");
    expect(onConflict).not.toHaveBeenCalled();
  });

  it("falls back to the update path when it loses a P2002 race", async () => {
    // Two page jobs raced the same new product; we lost. The row now exists,
    // so the correct action is the update we would have done anyway.
    const operation = vi.fn().mockRejectedValue(p2002());
    const onConflict = vi.fn().mockResolvedValue("updated");
    await expect(withUniqueRetry(operation, onConflict)).resolves.toBe("updated");
    expect(onConflict).toHaveBeenCalledTimes(1);
  });

  it("rethrows anything that is not a unique-constraint violation", async () => {
    const boom = Object.assign(new Error("deadlock"), { code: "P2034" });
    const onConflict = vi.fn();
    await expect(withUniqueRetry(() => Promise.reject(boom), onConflict)).rejects.toThrow("deadlock");
    expect(onConflict).not.toHaveBeenCalled();
  });

  it("does not loop: a second P2002 surfaces instead of retrying forever", async () => {
    // If the fallback also collides, the constraint being violated is not the
    // one we think it is -- looping would hide a schema bug behind retries.
    const onConflict = vi.fn().mockRejectedValue(p2002("someOtherUniqueKey"));
    await expect(withUniqueRetry(() => Promise.reject(p2002()), onConflict)).rejects.toMatchObject({
      code: "P2002",
    });
    expect(onConflict).toHaveBeenCalledTimes(1);
  });
});

// --------------------------------------------------------------------------
// a fake Prisma client, just enough for upsertProduct
// --------------------------------------------------------------------------

interface FakeOptions {
  existingProduct?: { id: string; shopifyUpdatedAt: Date } | null;
  /** Make the first product.upsert throw P2002, as a lost race does. */
  productUpsertRaces?: boolean;
}

function fakeDb(options: FakeOptions = {}) {
  const calls = {
    productUpsert: 0,
    productUpdate: 0,
    variantUpsert: 0,
    imageDeleteMany: 0,
    productUpdateData: [] as unknown[],
    variantDeactivateWhere: [] as unknown[],
  };

  const db = {
    product: {
      findUnique: vi.fn().mockResolvedValue(options.existingProduct ?? null),
      upsert: vi.fn(async () => {
        calls.productUpsert += 1;
        if (options.productUpsertRaces && calls.productUpsert === 1) throw p2002();
        return { id: "prod-1" };
      }),
      update: vi.fn(async ({ data }: { data: unknown }) => {
        calls.productUpdate += 1;
        calls.productUpdateData.push(data);
        return { id: "prod-1" };
      }),
    },
    productVariant: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(async () => {
        calls.variantUpsert += 1;
        return { id: "var-1" };
      }),
      update: vi.fn().mockResolvedValue({ id: "var-1" }),
      // Used by the reconcile that deactivates variants Shopify no longer reports.
      // Recorded so a test can assert whether reconciliation ran and what it
      // targeted; the real behaviour is covered against MySQL in the integration
      // suite, since it is a `notIn` query.
      updateMany: vi.fn(async (args: { where: unknown }) => {
        calls.variantDeactivateWhere.push(args.where);
        return { count: 0 };
      }),
    },
    productImage: {
      upsert: vi.fn().mockResolvedValue({ id: "img-1" }),
      update: vi.fn().mockResolvedValue({ id: "img-1" }),
      deleteMany: vi.fn(async () => {
        calls.imageDeleteMany += 1;
        return { count: 0 };
      }),
    },
  };

  return { db: db as unknown as Db, calls, raw: db };
}

describe("upsertProduct", () => {
  const mapped = mapProduct(productNode(), "p");

  it("writes a new product with its variants and images", async () => {
    const { db, calls } = fakeDb();
    const result = await upsertProduct(db, mapped, { syncRunId: "run-1", currencyCode: "PKR" });

    expect(result.applied).toBe(true);
    expect(calls.productUpsert).toBe(1);
    expect(calls.variantUpsert).toBe(1);
    // Images are reconciled: anything absent from the payload is removed.
    expect(calls.imageDeleteMany).toBe(1);
  });

  it("survives a P2002 race without failing the page", async () => {
    const { db, calls } = fakeDb({ productUpsertRaces: true });
    const result = await upsertProduct(db, mapped, { syncRunId: "run-1", currencyCode: "PKR" });

    expect(result.applied).toBe(true);
    expect(calls.productUpsert).toBe(1);
    expect(calls.productUpdate).toBe(1); // the fallback ran
  });

  it("skips a stale payload but still stamps the run id", async () => {
    // Older than what is stored: a slow page arriving after a webhook. The row
    // must not be overwritten, but the run DID see the product, so the sweep
    // must not later treat it as missing.
    const { db, calls, raw } = fakeDb({
      existingProduct: { id: "prod-1", shopifyUpdatedAt: new Date("2026-09-25T00:00:00Z") },
    });

    const result = await upsertProduct(db, mapped, { syncRunId: "run-9", currencyCode: "PKR" });

    expect(result.applied).toBe(false);
    expect(calls.productUpsert).toBe(0);
    expect(raw.product.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastSyncRunId: "run-9" }) }),
    );
  });

  it("marks a non-ACTIVE product inactive with the Shopify reason", async () => {
    const { db, raw } = fakeDb();
    await upsertProduct(db, mapProduct(productNode({ status: "ARCHIVED" }), "p"), {
      syncRunId: "run-1",
      currencyCode: "PKR",
    });

    const create = upsertCreateArg(raw.product.upsert);
    expect(create.isActive).toBe(false);
    expect(create.deactivationReason).toBe("SHOPIFY_STATUS");
  });

  it("records a truncated variant set as incomplete, with its cursor", async () => {
    const { db, raw } = fakeDb();
    await upsertProduct(
      db,
      mapProduct(
        productNode({
          variants: { pageInfo: { hasNextPage: true, endCursor: "V100" }, nodes: [] },
        }),
        "p",
      ),
      { syncRunId: "run-1", currencyCode: "PKR" },
    );

    const create = upsertCreateArg(raw.product.upsert);
    expect(create.variantSyncComplete).toBe(false);
    expect(create.variantSyncCursor).toBe("V100");
  });
});

// --------------------------------------------------------------------------
// sweep
// --------------------------------------------------------------------------

function fakeSweepDb(staleIds: string[]) {
  const where: { product?: unknown; variant?: unknown } = {};
  const db = {
    product: {
      findMany: vi.fn(async (args: { where: unknown }) => {
        where.product = args.where;
        return staleIds.map((id) => ({ id }));
      }),
      updateMany: vi.fn(async () => ({ count: staleIds.length })),
    },
    productVariant: {
      updateMany: vi.fn(async (args: { where: unknown }) => {
        where.variant = args.where;
        return { count: staleIds.length * 2 };
      }),
    },
  };
  return { db: db as unknown as Db, where, raw: db };
}

describe("sweepMissingProducts", () => {
  it("deactivates products the run did not stamp, and their variants with them", async () => {
    const { db, raw } = fakeSweepDb(["p1", "p2"]);
    const result = await sweepMissingProducts(db, "run-1", new Date("2026-09-29T12:00:00Z"));

    expect(result).toEqual({ productsDeactivated: 2, variantsDeactivated: 4 });
    // The invariant "inactive product => inactive variants" is upheld here, not
    // left to a later job.
    expect(raw.productVariant.updateMany).toHaveBeenCalled();
  });

  it("uses a NULL-safe predicate, so never-stamped rows are not skipped", async () => {
    const { db, where } = fakeSweepDb(["p1"]);
    await sweepMissingProducts(db, "run-1");

    // `lastSyncRunId != 'run-1'` alone evaluates to NULL for a NULL column and
    // silently misses the row. The OR is required for correctness.
    expect(where.product).toMatchObject({
      isActive: true,
      OR: [{ lastSyncRunId: null }, { lastSyncRunId: { not: "run-1" } }],
    });
  });

  it("writes MISSING_FROM_SYNC, never a hard delete", async () => {
    const { db, raw } = fakeSweepDb(["p1"]);
    await sweepMissingProducts(db, "run-1");

    expect(raw.product.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isActive: false, deactivationReason: "MISSING_FROM_SYNC" }),
      }),
    );
    expect("delete" in raw.product).toBe(false);
  });

  it("does nothing when every product was seen", async () => {
    const { db, raw } = fakeSweepDb([]);
    const result = await sweepMissingProducts(db, "run-1");

    expect(result).toEqual({ productsDeactivated: 0, variantsDeactivated: 0 });
    expect(raw.product.updateMany).not.toHaveBeenCalled();
  });
});
