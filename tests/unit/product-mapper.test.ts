import { describe, expect, it } from "vitest";

import {
  MappingError,
  mapProduct,
  mapProductsPage,
  mapVariant,
  mapVariantsPage,
} from "@/src/lib/sync/product-mapper";

import { manyVariants, productNode, productsPage, variantNode, variantsPage } from "./fixtures";

describe("mapVariant", () => {
  it("keeps money as a string, never a number", () => {
    const variant = mapVariant(variantNode({ price: "1234.5600" }), "v", 0);
    expect(variant.price).toBe("1234.5600");
    expect(typeof variant.price).toBe("string");
  });

  it("maps compareAtPrice when present and null when absent", () => {
    expect(mapVariant(variantNode({ compareAtPrice: "29.99" }), "v", 0).compareAtPrice).toBe("29.99");
    expect(mapVariant(variantNode({ compareAtPrice: null }), "v", 0).compareAtPrice).toBeNull();
    expect(mapVariant(variantNode({ compareAtPrice: "" }), "v", 0).compareAtPrice).toBeNull();
  });

  it("maps sku, inventory quantity, tracking and policy", () => {
    const variant = mapVariant(
      variantNode({
        sku: "ABC-1",
        inventoryQuantity: 42,
        inventoryPolicy: "CONTINUE",
        inventoryItem: { tracked: false },
      }),
      "v",
      0,
    );
    expect(variant.sku).toBe("ABC-1");
    expect(variant.inventoryQuantity).toBe(42);
    expect(variant.inventoryPolicy).toBe("CONTINUE");
    expect(variant.inventoryTracked).toBe(false);
  });

  it("treats a null inventoryQuantity as 0 rather than failing", () => {
    // Untracked variants report null. 0 is the honest projection, and
    // inventoryTracked is what the storefront branches on.
    expect(mapVariant(variantNode({ inventoryQuantity: null }), "v", 0).inventoryQuantity).toBe(0);
  });

  it("falls back to array order when position is missing", () => {
    expect(mapVariant(variantNode({ position: null }), "v", 4).position).toBe(5);
  });

  it("maps selectedOptions", () => {
    const variant = mapVariant(
      variantNode({
        selectedOptions: [
          { name: "Size", value: "L" },
          { name: "Colour", value: "Red" },
        ],
      }),
      "v",
      0,
    );
    expect(variant.selectedOptions).toEqual([
      { name: "Size", value: "L" },
      { name: "Colour", value: "Red" },
    ]);
  });

  it("rejects a non-decimal price with the field path in the message", () => {
    expect(() => mapVariant(variantNode({ price: "19,99" }), "variants.nodes[0]", 0)).toThrow(
      MappingError,
    );
    expect(() => mapVariant(variantNode({ price: "19,99" }), "variants.nodes[0]", 0)).toThrow(
      /variants\.nodes\[0\]\.price/,
    );
  });

  it("rejects an unknown inventoryPolicy instead of coercing it", () => {
    expect(() => mapVariant(variantNode({ inventoryPolicy: "MAYBE" }), "v", 0)).toThrow(
      /inventoryPolicy/,
    );
  });
});

describe("mapProduct", () => {
  it("maps every field the storefront needs", () => {
    const product = mapProduct(productNode(), "p");
    expect(product).toMatchObject({
      shopifyProductId: "gid://shopify/Product/100",
      title: "A Product",
      handle: "a-product",
      descriptionHtml: "<p>Nice</p>",
      vendor: "Acme",
      productType: "Widget",
      status: "ACTIVE",
    });
    expect(product.publishedAt).toBeInstanceOf(Date);
    expect(product.shopifyUpdatedAt.toISOString()).toBe("2026-09-20T10:00:00.000Z");
  });

  it("maps options with their values", () => {
    const product = mapProduct(
      productNode({
        options: [{ id: "o1", name: "Size", position: 1, values: ["S", "M", "L"] }],
      }),
      "p",
    );
    expect(product.options).toEqual([{ name: "Size", position: 1, values: ["S", "M", "L"] }]);
  });

  it("maps images from media and numbers them by position", () => {
    const product = mapProduct(
      productNode({
        media: {
          nodes: [
            { id: "m1", image: { url: "https://cdn.example/1.jpg", altText: "one" } },
            { id: "m2", image: { url: "https://cdn.example/2.jpg", altText: null } },
          ],
        },
      }),
      "p",
    );
    expect(product.images).toEqual([
      { shopifyImageId: "m1", url: "https://cdn.example/1.jpg", altText: "one", position: 1 },
      { shopifyImageId: "m2", url: "https://cdn.example/2.jpg", altText: null, position: 2 },
    ]);
  });

  it("skips non-image media instead of failing the product", () => {
    const product = mapProduct(
      productNode({
        media: {
          nodes: [
            { id: "m1", image: { url: "https://cdn.example/1.jpg", altText: null } },
            {}, // a video: no id, no image
          ],
        },
      }),
      "p",
    );
    expect(product.images).toHaveLength(1);
  });

  it("reports a truncated variant set with its resume cursor", () => {
    const product = mapProduct(
      productNode({
        variants: {
          pageInfo: { hasNextPage: true, endCursor: "CURSOR-100" },
          nodes: manyVariants(100),
        },
      }),
      "p",
    );
    expect(product.variants).toHaveLength(100);
    expect(product.variantsHasNextPage).toBe(true);
    expect(product.variantsEndCursor).toBe("CURSOR-100");
  });

  it("does not keep a variant cursor when the set is complete", () => {
    // A resume point for a chain that never runs is a lie in the database.
    const product = mapProduct(
      productNode({
        variants: { pageInfo: { hasNextPage: false, endCursor: "STALE" }, nodes: [variantNode()] },
      }),
      "p",
    );
    expect(product.variantsHasNextPage).toBe(false);
    expect(product.variantsEndCursor).toBeNull();
  });
});

describe("mapProductsPage", () => {
  it("maps a page and its cursor", () => {
    const page = mapProductsPage(
      productsPage([productNode(), productNode({ id: "gid://shopify/Product/101", handle: "b" })], {
        hasNextPage: true,
        endCursor: "PAGE-2",
      }),
    );
    expect(page.products).toHaveLength(2);
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe("PAGE-2");
  });

  it("returns a null cursor on the last page", () => {
    const page = mapProductsPage(productsPage([productNode()], { hasNextPage: false, endCursor: "X" }));
    expect(page.hasNextPage).toBe(false);
    expect(page.endCursor).toBeNull();
  });

  it("maps an empty page without throwing", () => {
    const page = mapProductsPage(productsPage([], { hasNextPage: false, endCursor: null }));
    expect(page.products).toEqual([]);
  });
});

describe("mapVariantsPage", () => {
  it("maps a continuation page", () => {
    const page = mapVariantsPage(
      variantsPage(manyVariants(100, 100), { hasNextPage: true, endCursor: "CURSOR-200" }),
      100,
    );
    expect(page.variants).toHaveLength(100);
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe("CURSOR-200");
    expect(page.shopifyProductId).toBe("gid://shopify/Product/100");
  });

  it("fails loudly when the product vanished between pages", () => {
    expect(() => mapVariantsPage({ product: null })).toThrow(/product not found/);
  });
});
