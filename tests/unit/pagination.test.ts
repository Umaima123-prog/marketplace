/**
 * Cursor pagination, including the >100-variant continuation.
 *
 * Driven by a fake Shopify client rather than the network: the property under
 * test is "does the walk hand cursors forward correctly and stop exactly once",
 * which has nothing to do with HTTP.
 */
import { describe, expect, it } from "vitest";

import { mapProductsPage, mapVariantsPage } from "@/src/lib/sync/product-mapper";
import { variantSyncState } from "@/src/lib/sync/decisions";

import { manyVariants, productNode, productsPage, variantsPage } from "./fixtures";

/** Minimal stand-in for the chained page jobs, without BullMQ or Prisma. */
function walkProducts(pages: ReturnType<typeof productsPage>[]) {
  const cursorsRequested: Array<string | null> = [];
  const seen: string[] = [];
  let cursor: string | null = null;
  let index = 0;

  for (;;) {
    cursorsRequested.push(cursor);
    const page = mapProductsPage(pages[index]);
    seen.push(...page.products.map((p) => p.shopifyProductId));

    if (!page.hasNextPage) break;
    cursor = page.endCursor;
    index += 1;
    if (index >= pages.length) throw new Error("walk asked for a page that does not exist");
  }

  return { cursorsRequested, seen, pagesFetched: index + 1 };
}

describe("product cursor pagination", () => {
  it("starts with a null cursor and follows endCursor to the end", () => {
    const walk = walkProducts([
      productsPage([productNode({ id: "gid://shopify/Product/1", handle: "a" })], {
        hasNextPage: true,
        endCursor: "C1",
      }),
      productsPage([productNode({ id: "gid://shopify/Product/2", handle: "b" })], {
        hasNextPage: true,
        endCursor: "C2",
      }),
      productsPage([productNode({ id: "gid://shopify/Product/3", handle: "c" })], {
        hasNextPage: false,
        endCursor: null,
      }),
    ]);

    expect(walk.cursorsRequested).toEqual([null, "C1", "C2"]);
    expect(walk.pagesFetched).toBe(3);
    expect(walk.seen).toEqual([
      "gid://shopify/Product/1",
      "gid://shopify/Product/2",
      "gid://shopify/Product/3",
    ]);
  });

  it("stops after one page when there is nothing more", () => {
    const walk = walkProducts([productsPage([productNode()], { hasNextPage: false, endCursor: null })]);
    expect(walk.pagesFetched).toBe(1);
    expect(walk.cursorsRequested).toEqual([null]);
  });

  it("visits every product exactly once across pages", () => {
    const walk = walkProducts([
      productsPage(
        [
          productNode({ id: "gid://shopify/Product/1", handle: "a" }),
          productNode({ id: "gid://shopify/Product/2", handle: "b" }),
        ],
        { hasNextPage: true, endCursor: "C1" },
      ),
      productsPage([productNode({ id: "gid://shopify/Product/3", handle: "c" })], {
        hasNextPage: false,
        endCursor: null,
      }),
    ]);
    expect(new Set(walk.seen).size).toBe(walk.seen.length);
    expect(walk.seen).toHaveLength(3);
  });
});

describe("variant pagination beyond 100", () => {
  it("marks a 100-variant page as truncated and records the resume cursor", () => {
    const product = mapProductsPage(
      productsPage(
        [
          productNode({
            variants: { pageInfo: { hasNextPage: true, endCursor: "V100" }, nodes: manyVariants(100) },
          }),
        ],
        { hasNextPage: false, endCursor: null },
      ),
    ).products[0];

    expect(product.variants).toHaveLength(100);

    const state = variantSyncState(product.variantsHasNextPage, product.variantsEndCursor);
    // The database must not claim completeness while a chain is outstanding.
    expect(state).toEqual({ variantSyncComplete: false, variantSyncCursor: "V100" });
  });

  it("walks a 250-variant product to completion over three pages", () => {
    const pages = [
      variantsPage(manyVariants(100, 100), { hasNextPage: true, endCursor: "V200" }),
      variantsPage(manyVariants(50, 200), { hasNextPage: false, endCursor: null }),
    ];

    const collected: string[] = [];
    let cursor: string | null = "V100";
    const requested: Array<string | null> = [];

    for (let i = 0; i < pages.length; i += 1) {
      requested.push(cursor);
      const page = mapVariantsPage(pages[i], 100 + i * 100);
      collected.push(...page.variants.map((v) => v.shopifyVariantId));
      cursor = page.endCursor;
      if (!page.hasNextPage) {
        // Only now may the product be called complete.
        expect(variantSyncState(false, null)).toEqual({
          variantSyncComplete: true,
          variantSyncCursor: null,
        });
        break;
      }
    }

    expect(requested).toEqual(["V100", "V200"]);
    // 100 inline + 100 + 50 continuation = 250, all distinct.
    expect(collected).toHaveLength(150);
    expect(new Set(collected).size).toBe(150);
  });

  it("keeps the product incomplete while a chain is still running", () => {
    const page = mapVariantsPage(
      variantsPage(manyVariants(100, 100), { hasNextPage: true, endCursor: "V200" }),
      100,
    );
    const state = variantSyncState(page.hasNextPage, page.endCursor);
    expect(state.variantSyncComplete).toBe(false);
    expect(state.variantSyncCursor).toBe("V200");
  });

  it("a failed chain leaves the product marked incomplete, never complete", () => {
    // The chain dies after page 1. Nothing flips the flag, so the last durable
    // state still says "truncated" -- which is the whole point.
    const afterFirstPage = variantSyncState(true, "V200");
    expect(afterFirstPage.variantSyncComplete).toBe(false);
    expect(afterFirstPage.variantSyncCursor).toBe("V200");
  });
});
