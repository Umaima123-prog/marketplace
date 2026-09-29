/**
 * The storefront read path, against real MySQL.
 *
 * These matter more than most: the listing query decides what a shopper is
 * allowed to see, and a wrong predicate publishes an archived product or hides
 * a live one. That is not something to verify against a fake client.
 *
 * `catalog.service.ts` is `server-only` and uses the app's Prisma singleton, so
 * these tests point that singleton at the test database via DATABASE_URL before
 * importing it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { disconnect, resetDatabase, testPrisma } from "./setup";

// Must happen before catalog.service (and therefore src/lib/prisma) is loaded.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const {
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  getProductByHandle,
  keysetWhere,
  listProducts,
} = await import("@/src/server/catalog/catalog.service");

const db = testPrisma;

interface SeedOptions {
  handle: string;
  title?: string;
  status?: "ACTIVE" | "ARCHIVED" | "DRAFT";
  isActive?: boolean;
  publishedAt?: Date | null;
  images?: Array<{ url: string; altText?: string | null }>;
  variants?: Array<{
    price: string;
    compareAtPrice?: string | null;
    isActive?: boolean;
    inventoryQuantity?: number;
    inventoryTracked?: boolean;
    inventoryPolicy?: "DENY" | "CONTINUE";
    title?: string;
  }>;
  variantSyncComplete?: boolean;
  descriptionHtml?: string | null;
}

let seq = 0;

async function seedProduct(options: SeedOptions) {
  seq += 1;
  const gid = `gid://shopify/Product/${seq}`;

  return db.product.create({
    data: {
      shopifyProductId: gid,
      handle: options.handle,
      title: options.title ?? options.handle,
      descriptionHtml: options.descriptionHtml ?? null,
      status: options.status ?? "ACTIVE",
      isActive: options.isActive ?? (options.status ?? "ACTIVE") === "ACTIVE",
      publishedAt: options.publishedAt === undefined ? new Date("2026-01-01T00:00:00Z") : options.publishedAt,
      shopifyUpdatedAt: new Date(),
      syncedAt: new Date(),
      variantSyncComplete: options.variantSyncComplete ?? true,
      images: {
        create: (options.images ?? []).map((image, index) => ({
          shopifyImageId: `gid://shopify/MediaImage/${seq}-${index}`,
          url: image.url,
          altText: image.altText ?? null,
          position: index + 1,
        })),
      },
      variants: {
        create: (options.variants ?? [{ price: "10.00" }]).map((variant, index) => ({
          shopifyVariantId: `gid://shopify/ProductVariant/${seq}-${index}`,
          title: variant.title ?? `Variant ${index + 1}`,
          position: index + 1,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice ?? null,
          currencyCode: "USD",
          inventoryQuantity: variant.inventoryQuantity ?? 5,
          inventoryTracked: variant.inventoryTracked ?? true,
          inventoryPolicy: variant.inventoryPolicy ?? "DENY",
          isActive: variant.isActive ?? true,
          shopifyUpdatedAt: new Date(),
          syncedAt: new Date(),
        })),
      },
    },
  });
}

beforeAll(() => {
  expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnect();
});

describe("listing visibility", () => {
  it("returns active products", async () => {
    await seedProduct({ handle: "visible-one" });
    await seedProduct({ handle: "visible-two" });

    const { products } = await listProducts();
    expect(products.map((p) => p.handle).sort()).toEqual(["visible-one", "visible-two"]);
  });

  it("hides a product deactivated locally", async () => {
    await seedProduct({ handle: "gone", isActive: false });
    const { products } = await listProducts();
    expect(products).toHaveLength(0);
  });

  it("hides ARCHIVED and DRAFT products even if isActive were wrong", async () => {
    // Both conditions are required: a bug in one must not publish a product.
    await seedProduct({ handle: "archived", status: "ARCHIVED", isActive: true });
    await seedProduct({ handle: "draft", status: "DRAFT", isActive: true });

    const { products } = await listProducts();
    expect(products).toHaveLength(0);
  });

  it("omits a product whose variants are all inactive", async () => {
    // Nothing to price and nothing to sell, so it is not a card.
    await seedProduct({
      handle: "no-active-variants",
      variants: [{ price: "10.00", isActive: false }, { price: "12.00", isActive: false }],
    });

    const { products } = await listProducts();
    expect(products).toHaveLength(0);
  });

  it("includes a product with no image, with image null", async () => {
    await seedProduct({ handle: "imageless", images: [] });

    const { products } = await listProducts();
    expect(products).toHaveLength(1);
    expect(products[0].image).toBeNull();
  });
});

describe("listing price", () => {
  it("shows the lowest active variant price", async () => {
    await seedProduct({
      handle: "multi",
      variants: [{ price: "29.99" }, { price: "9.99" }, { price: "19.99" }],
    });

    const { products } = await listProducts();
    expect(products[0].fromPrice).toBe("9.99");
    expect(products[0].variantCount).toBe(3);
  });

  it("ignores inactive variants when choosing the lowest price", async () => {
    await seedProduct({
      handle: "mixed",
      variants: [{ price: "5.00", isActive: false }, { price: "15.00" }],
    });

    const { products } = await listProducts();
    expect(products[0].fromPrice).toBe("15.00");
    expect(products[0].variantCount).toBe(1);
  });

  it("returns prices as exact decimal strings, never numbers", async () => {
    await seedProduct({ handle: "precise", variants: [{ price: "0.1", compareAtPrice: "1234567890123.4567" }] });

    const { products } = await listProducts();
    expect(typeof products[0].fromPrice).toBe("string");
    // Padded to a consistent scale, not rounded: the stored 0.1000 keeps its
    // value and gains the minimum two places.
    expect(products[0].fromPrice).toBe("0.10");
    // Beyond float precision, and preserved exactly.
    expect(products[0].compareAtPrice).toBe("1234567890123.4567");
  });

  it("suppresses a compare-at price that is not actually higher", async () => {
    // Struck-through text claiming a discount that does not exist is a lie.
    await seedProduct({ handle: "fake-sale", variants: [{ price: "10.00", compareAtPrice: "10.00" }] });
    await seedProduct({ handle: "real-sale", variants: [{ price: "8.00", compareAtPrice: "10.00" }] });

    const { products } = await listProducts();
    const byHandle = Object.fromEntries(products.map((p) => [p.handle, p]));
    expect(byHandle["fake-sale"].compareAtPrice).toBeNull();
    expect(byHandle["real-sale"].compareAtPrice).toBe("10.00");
  });
});

describe("listing availability", () => {
  it("marks a tracked, out-of-stock product unavailable", async () => {
    await seedProduct({ handle: "sold-out", variants: [{ price: "10.00", inventoryQuantity: 0 }] });
    const { products } = await listProducts();
    expect(products[0].available).toBe(false);
  });

  it("treats an untracked variant as available", async () => {
    await seedProduct({
      handle: "untracked",
      variants: [{ price: "10.00", inventoryQuantity: 0, inventoryTracked: false }],
    });
    const { products } = await listProducts();
    expect(products[0].available).toBe(true);
  });

  it("treats CONTINUE as available even at zero", async () => {
    await seedProduct({
      handle: "oversell",
      variants: [{ price: "10.00", inventoryQuantity: 0, inventoryPolicy: "CONTINUE" }],
    });
    const { products } = await listProducts();
    expect(products[0].available).toBe(true);
  });

  it("is available when any one variant is", async () => {
    await seedProduct({
      handle: "partly",
      variants: [{ price: "10.00", inventoryQuantity: 0 }, { price: "12.00", inventoryQuantity: 3 }],
    });
    const { products } = await listProducts();
    expect(products[0].available).toBe(true);
  });
});

describe("listing does not leak internal fields", () => {
  it("returns only view-model keys", async () => {
    await seedProduct({ handle: "clean", images: [{ url: "https://cdn/a.jpg" }] });
    const { products } = await listProducts();

    expect(Object.keys(products[0]).sort()).toEqual(
      [
        "available",
        "compareAtPrice",
        "currencyCode",
        "fromPrice",
        "handle",
        "image",
        "title",
        "variantCount",
        "vendor",
      ].sort(),
    );
    // No database id, no sync bookkeeping, no Shopify identifiers.
    const serialised = JSON.stringify(products[0]);
    for (const leak of ["lastSyncRunId", "syncedAt", "shopifyProductId", "variantSyncCursor", "id"]) {
      expect(serialised).not.toContain(leak);
    }
  });
});

describe("pagination", () => {
  it("pages with a keyset cursor and stops at the end", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedProduct({
        handle: `p-${i}`,
        publishedAt: new Date(Date.UTC(2026, 0, i + 1)),
      });
    }

    const first = await listProducts({ limit: 2 });
    expect(first.products).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listProducts({ limit: 2, cursor: first.nextCursor });
    expect(second.products).toHaveLength(2);

    const third = await listProducts({ limit: 2, cursor: second.nextCursor });
    expect(third.products).toHaveLength(1);
    expect(third.nextCursor).toBeNull();

    const seen = [...first.products, ...second.products, ...third.products].map((p) => p.handle);
    // Newest first, and every product exactly once.
    expect(seen).toEqual(["p-4", "p-3", "p-2", "p-1", "p-0"]);
    expect(new Set(seen).size).toBe(5);
  });

  it("includes never-published products, after the published ones", async () => {
    // publishedAt IS NULL sorts last under DESC, and the keyset predicate has
    // to say so explicitly -- `publishedAt < x` is NULL, not true, for those rows.
    await seedProduct({ handle: "published", publishedAt: new Date("2026-01-05T00:00:00Z") });
    await seedProduct({ handle: "never-published", publishedAt: null });

    const first = await listProducts({ limit: 1 });
    expect(first.products[0].handle).toBe("published");

    const second = await listProducts({ limit: 1, cursor: first.nextCursor });
    expect(second.products[0].handle).toBe("never-published");
  });

  it("treats a malformed cursor as page one rather than failing", async () => {
    await seedProduct({ handle: "only" });
    const { products } = await listProducts({ cursor: "not-a-cursor" });
    expect(products).toHaveLength(1);
  });

  it("round-trips a cursor", () => {
    const cursor = { publishedAtMs: 1_767_225_600_000, id: "abc123" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("%%%")).toBeNull();
  });

  it("builds an empty predicate for the first page", () => {
    expect(keysetWhere(null)).toEqual({});
  });

  it("caps the page size", async () => {
    for (let i = 0; i < 3; i += 1) await seedProduct({ handle: `cap-${i}` });
    const { products } = await listProducts({ limit: 10_000 });
    expect(products.length).toBeLessThanOrEqual(DEFAULT_PAGE_SIZE + 60);
  });
});

describe("product detail", () => {
  it("returns a product with its images and active variants", async () => {
    await seedProduct({
      handle: "detailed",
      title: "Detailed Product",
      descriptionHtml: "<p>Good</p>",
      images: [{ url: "https://cdn/1.jpg", altText: "front" }, { url: "https://cdn/2.jpg" }],
      variants: [
        { price: "10.00", title: "Small" },
        { price: "12.00", compareAtPrice: "20.00", title: "Large" },
      ],
    });

    const product = await getProductByHandle("detailed");
    expect(product).not.toBeNull();
    expect(product!.title).toBe("Detailed Product");
    expect(product!.descriptionHtml).toBe("<p>Good</p>");
    expect(product!.images.map((i) => i.url)).toEqual(["https://cdn/1.jpg", "https://cdn/2.jpg"]);
    expect(product!.variants).toHaveLength(2);
    expect(product!.variants[1].compareAtPrice).toBe("20.00");
    expect(product!.available).toBe(true);
    expect(product!.variantsMayBeIncomplete).toBe(false);
  });

  it("returns null for an inactive product, so the page 404s", async () => {
    await seedProduct({ handle: "hidden", isActive: false });
    expect(await getProductByHandle("hidden")).toBeNull();
  });

  it("returns null for an archived product", async () => {
    await seedProduct({ handle: "archived-detail", status: "ARCHIVED", isActive: true });
    expect(await getProductByHandle("archived-detail")).toBeNull();
  });

  it("returns null for an unknown handle", async () => {
    expect(await getProductByHandle("does-not-exist")).toBeNull();
  });

  it("returns null for absurd input instead of querying", async () => {
    expect(await getProductByHandle("")).toBeNull();
    expect(await getProductByHandle("x".repeat(500))).toBeNull();
  });

  it("returns a product with no active variants as unavailable, not missing", async () => {
    // Different from the listing: the detail page explains the situation
    // instead of pretending the product does not exist.
    await seedProduct({
      handle: "unbuyable",
      variants: [{ price: "10.00", isActive: false }],
    });

    const product = await getProductByHandle("unbuyable");
    expect(product).not.toBeNull();
    expect(product!.variants).toHaveLength(0);
    expect(product!.available).toBe(false);
  });

  it("reports a truncated variant set", async () => {
    await seedProduct({ handle: "truncated", variantSyncComplete: false });
    const product = await getProductByHandle("truncated");
    expect(product!.variantsMayBeIncomplete).toBe(true);
  });

  it("exposes inventory only for tracked variants", async () => {
    await seedProduct({
      handle: "inventory",
      variants: [
        { price: "10.00", inventoryQuantity: 7, inventoryTracked: true, title: "Tracked" },
        { price: "11.00", inventoryQuantity: 99, inventoryTracked: false, title: "Untracked" },
      ],
    });

    const product = await getProductByHandle("inventory");
    expect(product!.variants[0].inventoryQuantity).toBe(7);
    // Untracked: the stored number is meaningless, so it is not shown.
    expect(product!.variants[1].inventoryQuantity).toBeNull();
  });

  it("does not leak internal fields on the detail view", async () => {
    await seedProduct({ handle: "detail-clean" });
    const product = await getProductByHandle("detail-clean");
    const serialised = JSON.stringify(product);
    for (const leak of ["lastSyncRunId", "syncedAt", "shopifyProductId", "shopifyVariantId", "variantSyncCursor"]) {
      expect(serialised).not.toContain(leak);
    }
  });
});
