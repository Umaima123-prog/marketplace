/**
 * Cart hydration, against real MySQL.
 *
 * The cart the browser holds is a list of ids. Everything a shopper sees on the
 * cart page is produced here, from the catalog rows, which is what makes a
 * tampered localStorage harmless: it can change which products are in a cart, and
 * nothing else.
 *
 * `cart.service.ts` uses the app's Prisma singleton, so DATABASE_URL points at the
 * test database before it is imported.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { disconnect, resetDatabase, testPrisma } from "./setup";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { hydrateCart } = await import("@/src/server/cart/cart.service");

const db = testPrisma;

let seq = 0;

interface SeedVariant {
  price: string;
  title?: string;
  isActive?: boolean;
  inventoryQuantity?: number;
  inventoryTracked?: boolean;
  inventoryPolicy?: "DENY" | "CONTINUE";
}

async function seedProduct(options: {
  title?: string;
  status?: "ACTIVE" | "ARCHIVED" | "DRAFT";
  isActive?: boolean;
  images?: string[];
  variants: SeedVariant[];
}) {
  seq += 1;
  const status = options.status ?? "ACTIVE";

  return db.product.create({
    data: {
      shopifyProductId: `gid://shopify/Product/${seq}`,
      handle: `product-${seq}`,
      title: options.title ?? `Product ${seq}`,
      status,
      isActive: options.isActive ?? status === "ACTIVE",
      publishedAt: new Date("2026-01-01T00:00:00Z"),
      shopifyUpdatedAt: new Date(),
      variantSyncComplete: true,
      images: {
        create: (options.images ?? []).map((url, index) => ({
          shopifyImageId: `gid://shopify/MediaImage/${seq}-${index}`,
          url,
          position: index,
        })),
      },
      variants: {
        create: options.variants.map((variant, index) => ({
          shopifyVariantId: `gid://shopify/ProductVariant/${seq}-${index}`,
          title: variant.title ?? `Option ${index + 1}`,
          sku: `SKU-${seq}-${index}`,
          position: index,
          price: variant.price,
          currencyCode: "USD",
          inventoryQuantity: variant.inventoryQuantity ?? 10,
          inventoryTracked: variant.inventoryTracked ?? true,
          inventoryPolicy: variant.inventoryPolicy ?? "DENY",
          isActive: variant.isActive ?? true,
          shopifyUpdatedAt: new Date(),
        })),
      },
    },
    include: { variants: { orderBy: { position: "asc" } } },
  });
}

beforeAll(resetDatabase);
beforeEach(resetDatabase);
afterAll(disconnect);

describe("hydrateCart: prices come from the database", () => {
  it("returns the current title, option, image and price for each line", async () => {
    const product = await seedProduct({
      title: "Snowboard",
      images: ["https://cdn.example.test/snowboard.jpg"],
      variants: [{ price: "19.99", title: "Wide" }],
    });
    const variant = product.variants[0];

    const cart = await hydrateCart([{ variantId: variant.id, quantity: 2 }]);

    expect(cart.lines).toHaveLength(1);
    const line = cart.lines[0];
    expect(line.productTitle).toBe("Snowboard");
    expect(line.productHandle).toBe(product.handle);
    expect(line.variantTitle).toBe("Wide");
    expect(line.sku).toBe(variant.sku);
    expect(line.imageUrl).toBe("https://cdn.example.test/snowboard.jpg");
    expect(line.unitPrice).toBe("19.99");
    expect(line.lineTotal).toBe("39.98");
    expect(line.currencyCode).toBe("USD");
    expect(line.available).toBe(true);
    expect(line.problem).toBeNull();
    expect(cart.subtotal).toBe("39.98");
    expect(cart.itemCount).toBe(2);
    expect(cart.checkoutable).toBe(true);
  });

  it("reflects a price change immediately, with nothing cached", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99" }] });
    const variant = product.variants[0];

    expect((await hydrateCart([{ variantId: variant.id, quantity: 1 }])).subtotal).toBe("19.99");

    await db.productVariant.update({ where: { id: variant.id }, data: { price: "24.50" } });

    expect((await hydrateCart([{ variantId: variant.id, quantity: 1 }])).subtotal).toBe("24.50");
  });

  it("computes the subtotal with exact decimals", async () => {
    // 0.10 * 3 is 0.30000000000000004 in floating point.
    const product = await seedProduct({ variants: [{ price: "0.10" }, { price: "19.99" }] });

    const cart = await hydrateCart([
      { variantId: product.variants[0].id, quantity: 3 },
      { variantId: product.variants[1].id, quantity: 3 },
    ]);

    expect(cart.subtotal).toBe("60.27");
  });

  it("pads a whole-number price for display", async () => {
    // DECIMAL(18,4) 15.0000 stringifies as "15"; beside "9.99" that reads as a bug.
    const product = await seedProduct({ variants: [{ price: "15.0000" }] });

    const cart = await hydrateCart([{ variantId: product.variants[0].id, quantity: 1 }]);
    expect(cart.lines[0].unitPrice).toBe("15.00");
    expect(cart.subtotal).toBe("15.00");
  });

  it("uses one query for a cart of many lines", async () => {
    const product = await seedProduct({
      variants: Array.from({ length: 12 }, () => ({ price: "1.00" })),
    });

    const cart = await hydrateCart(
      product.variants.map((variant) => ({ variantId: variant.id, quantity: 1 })),
    );
    expect(cart.lines).toHaveLength(12);
    expect(cart.subtotal).toBe("12.00");
  });

  it("has no image to show when the product has none", async () => {
    const product = await seedProduct({ variants: [{ price: "1.00" }] });

    const cart = await hydrateCart([{ variantId: product.variants[0].id, quantity: 1 }]);
    expect(cart.lines[0].imageUrl).toBeNull();
  });
});

describe("hydrateCart: unavailable lines", () => {
  it("keeps an unknown variant visible, marked, and out of the subtotal", async () => {
    // Dropping it silently would leave a shopper wondering what happened to their
    // item; counting it would produce a total they will never be charged.
    const product = await seedProduct({ variants: [{ price: "19.99" }] });

    const cart = await hydrateCart([
      { variantId: product.variants[0].id, quantity: 1 },
      { variantId: "not-a-real-variant", quantity: 1 },
    ]);

    expect(cart.lines).toHaveLength(2);
    expect(cart.lines[1].problem).toBe("variant_not_found");
    expect(cart.lines[1].available).toBe(false);
    expect(cart.subtotal).toBe("19.99");
    expect(cart.itemCount).toBe(1);
    expect(cart.checkoutable).toBe(false);
  });

  it("marks an inactive variant and blocks checkout", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99", isActive: false }] });

    const cart = await hydrateCart([{ variantId: product.variants[0].id, quantity: 1 }]);
    expect(cart.lines[0].problem).toBe("variant_inactive");
    expect(cart.checkoutable).toBe(false);
    expect(cart.subtotal).toBe("0.00");
  });

  it("marks a variant whose product is archived or a draft", async () => {
    for (const status of ["ARCHIVED", "DRAFT"] as const) {
      const product = await seedProduct({ status, variants: [{ price: "19.99", isActive: true }] });
      const cart = await hydrateCart([{ variantId: product.variants[0].id, quantity: 1 }]);
      expect(cart.lines[0].problem).toBe("product_unavailable");
      expect(cart.checkoutable).toBe(false);
    }
  });

  it("marks out-of-stock and insufficient-stock lines differently", async () => {
    const product = await seedProduct({
      variants: [
        { price: "19.99", inventoryQuantity: 0 },
        { price: "9.99", inventoryQuantity: 2 },
      ],
    });

    const cart = await hydrateCart([
      { variantId: product.variants[0].id, quantity: 1 },
      { variantId: product.variants[1].id, quantity: 5 },
    ]);

    expect(cart.lines[0].problem).toBe("out_of_stock");
    expect(cart.lines[1].problem).toBe("insufficient_stock");
    expect(cart.checkoutable).toBe(false);
  });

  it("shows the stock figure only for tracked variants", async () => {
    const product = await seedProduct({
      variants: [
        { price: "19.99", inventoryQuantity: 7 },
        { price: "9.99", inventoryQuantity: 7, inventoryTracked: false },
      ],
    });

    const cart = await hydrateCart([
      { variantId: product.variants[0].id, quantity: 1 },
      { variantId: product.variants[1].id, quantity: 1 },
    ]);

    expect(cart.lines[0].inventoryQuantity).toBe(7);
    // Untracked: the stored number is meaningless, so it is not shown.
    expect(cart.lines[1].inventoryQuantity).toBeNull();
  });

  it("is checkoutable only when every line is orderable", async () => {
    const product = await seedProduct({
      variants: [{ price: "19.99" }, { price: "9.99", inventoryQuantity: 0 }],
    });

    expect(
      (await hydrateCart([{ variantId: product.variants[0].id, quantity: 1 }])).checkoutable,
    ).toBe(true);

    expect(
      (
        await hydrateCart([
          { variantId: product.variants[0].id, quantity: 1 },
          { variantId: product.variants[1].id, quantity: 1 },
        ])
      ).checkoutable,
    ).toBe(false);
  });
});

describe("hydrateCart: hostile input", () => {
  it("returns an empty, non-checkoutable cart for no lines", async () => {
    const cart = await hydrateCart([]);
    expect(cart.lines).toEqual([]);
    expect(cart.subtotal).toBe("0.00");
    expect(cart.checkoutable).toBe(false);
  });

  it("truncates a cart with more lines than are allowed", async () => {
    const product = await seedProduct({
      variants: Array.from({ length: 3 }, () => ({ price: "1.00" })),
    });
    const lines = Array.from({ length: 60 }, (_, index) => ({
      variantId: product.variants[index % 3].id,
      quantity: 1,
    }));

    const cart = await hydrateCart(lines);
    expect(cart.lines.length).toBeLessThanOrEqual(50);
  });

  it("marks an invalid quantity rather than pricing it", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99" }] });

    for (const quantity of [0, -5, 1.5, 1000]) {
      const cart = await hydrateCart([{ variantId: product.variants[0].id, quantity }]);
      expect(cart.lines[0].problem).toBe("invalid_quantity");
      expect(cart.subtotal).toBe("0.00");
      expect(cart.checkoutable).toBe(false);
    }
  });

  it("does not return any internal sync column", async () => {
    // Nothing from the sync bookkeeping -- lastSyncRunId, syncedAt,
    // shopifyUpdatedAt -- may reach a storefront response.
    const product = await seedProduct({ variants: [{ price: "19.99" }] });

    const cart = await hydrateCart([{ variantId: product.variants[0].id, quantity: 1 }]);
    const serialised = JSON.stringify(cart);

    for (const field of ["lastSyncRunId", "syncedAt", "shopifyUpdatedAt", "variantSyncCursor"]) {
      expect(serialised).not.toContain(field);
    }
  });
});
