/**
 * Shopify response fixtures.
 *
 * Hand-built to the shape of the queries in src/lib/shopify/queries.ts. They are
 * fixtures for automated tests, never evidence about the real API -- no claim
 * anywhere in the documentation rests on them.
 */

export function variantNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/ProductVariant/1",
    title: "Default Title",
    sku: "SKU-1",
    position: 1,
    price: "19.99",
    compareAtPrice: null,
    inventoryQuantity: 5,
    inventoryPolicy: "DENY",
    updatedAt: "2026-09-20T10:00:00Z",
    selectedOptions: [{ name: "Title", value: "Default Title" }],
    inventoryItem: { tracked: true },
    ...overrides,
  };
}

export function productNode(overrides: Record<string, unknown> = {}) {
  const variants = (overrides.variants as unknown) ?? {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [variantNode()],
  };

  return {
    id: "gid://shopify/Product/100",
    legacyResourceId: "100",
    title: "A Product",
    handle: "a-product",
    descriptionHtml: "<p>Nice</p>",
    vendor: "Acme",
    productType: "Widget",
    status: "ACTIVE",
    publishedAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-20T10:00:00Z",
    options: [{ id: "gid://shopify/ProductOption/1", name: "Title", position: 1, values: ["Default Title"] }],
    media: {
      nodes: [
        {
          id: "gid://shopify/MediaImage/1",
          image: { url: "https://cdn.example/img1.jpg", altText: "front" },
        },
      ],
    },
    ...overrides,
    variants,
  };
}

export function productsPage(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
) {
  return { products: { pageInfo, nodes } };
}

export function variantsPage(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
  product: { id?: string; updatedAt?: string } = {},
) {
  return {
    product: {
      id: product.id ?? "gid://shopify/Product/100",
      updatedAt: product.updatedAt ?? "2026-09-20T10:00:00Z",
      variants: { pageInfo, nodes },
    },
  };
}

/** N variants with distinct ids, for exercising >100 pagination. */
export function manyVariants(count: number, startIndex = 0): unknown[] {
  return Array.from({ length: count }, (_, i) =>
    variantNode({
      id: `gid://shopify/ProductVariant/${startIndex + i + 1}`,
      title: `Variant ${startIndex + i + 1}`,
      sku: `SKU-${startIndex + i + 1}`,
      position: startIndex + i + 1,
    }),
  );
}
