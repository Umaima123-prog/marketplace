/**
 * COD checkout, against real MySQL.
 *
 * These are the tests that matter most in the project. Everything here is a claim
 * about money or about not charging a customer twice, and neither can be verified
 * against a fake: the `UNIQUE(idempotencyKey)` index, `DECIMAL(18,4)` arithmetic
 * and transactional rollback are all database behaviour.
 *
 * What is being proved:
 *   - the browser cannot influence a price, a subtotal or a total;
 *   - an unsellable line is refused, not quietly ordered;
 *   - Order and OrderItems appear together or not at all;
 *   - one idempotency key yields one order, even under a genuine race;
 *   - the same key with a different request is refused rather than answered;
 *   - the submit job is enqueued only after the order is durably committed.
 *
 * `checkout.service.ts` uses the app's Prisma singleton, so DATABASE_URL is
 * pointed at the test database before it is imported. Seeding and assertions use
 * the explicit test client, which is a second connection -- so a row it can see is
 * a row that is genuinely committed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { disconnect, resetDatabase, testPrisma } from "./setup";

// Must happen before checkout.service (and therefore src/lib/prisma) is loaded.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { getOrderByPublicToken, placeOrder } = await import("@/src/server/checkout/checkout.service");
// Real BullMQ, for the one test that asserts the queue is untouched by a refused
// checkout. Closed in afterAll so the suite leaves no Redis connection behind.
const { enqueueSubmitOrder, getSubmitOrderQueue } = await import("@/src/lib/queues");

const db = testPrisma;

let seq = 0;

interface SeedVariant {
  price: string;
  title?: string;
  sku?: string | null;
  isActive?: boolean;
  inventoryQuantity?: number;
  inventoryTracked?: boolean;
  inventoryPolicy?: "DENY" | "CONTINUE";
}

async function seedProduct(options: {
  title?: string;
  status?: "ACTIVE" | "ARCHIVED" | "DRAFT";
  isActive?: boolean;
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
      variants: {
        create: options.variants.map((variant, index) => ({
          shopifyVariantId: `gid://shopify/ProductVariant/${seq}-${index}`,
          title: variant.title ?? `Option ${index + 1}`,
          sku: variant.sku === undefined ? `SKU-${seq}-${index}` : variant.sku,
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

/** A complete, valid checkout body. Note there is no money in it -- there cannot be. */
function checkoutBody(
  items: Array<{ variantId: string; quantity: number }>,
  overrides: Record<string, unknown> = {},
) {
  seq += 1;
  return {
    idempotencyKey: `key-${seq}-${"0".repeat(8)}`,
    items,
    customerName: "Ayesha Khan",
    customerPhone: "+92 300 1234567",
    customerEmail: "ayesha@example.com",
    addressLine1: "12 Jinnah Road",
    addressLine2: "Flat 4",
    city: "Lahore",
    province: "Punjab",
    postalCode: "54000",
    countryCode: "PK",
    customerNote: "Call on arrival",
    ...overrides,
  };
}

/** Records what was enqueued, and whether the order was committed when it was. */
function recordingEnqueuer() {
  const calls: Array<{ orderId: string; orderWasVisible: boolean }> = [];
  return {
    calls,
    enqueueSubmit: async (orderId: string) => {
      // A different connection: if this finds the row, the transaction committed.
      const found = await db.order.findUnique({ where: { id: orderId }, select: { id: true } });
      calls.push({ orderId, orderWasVisible: found !== null });
    },
  };
}

beforeAll(resetDatabase);
beforeEach(resetDatabase);
afterAll(async () => {
  await getSubmitOrderQueue().close();
  await disconnect();
});

describe("placeOrder: the happy path", () => {
  it("creates one order with its items, priced from the database", async () => {
    const product = await seedProduct({ title: "Snowboard", variants: [{ price: "19.99" }] });
    const variant = product.variants[0];

    const result = await placeOrder(checkoutBody([{ variantId: variant.id, quantity: 3 }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const order = await db.order.findUnique({
      where: { reference: result.order.reference },
      include: { items: true },
    });

    expect(order).not.toBeNull();
    if (!order) return;

    expect(order.status).toBe("PENDING_SYNC");
    expect(order.paymentMethod).toBe("COD");
    expect(order.currencyCode).toBe("USD");

    // 19.99 * 3 = 59.97. A float would produce 59.969999999999999.
    expect(order.subtotal.toString()).toBe("59.97");
    expect(order.shippingTotal.toString()).toBe("0");
    expect(order.taxTotal.toString()).toBe("0");
    expect(order.grandTotal.toString()).toBe("59.97");

    expect(order.items).toHaveLength(1);
    const item = order.items[0];
    expect(item.variantId).toBe(variant.id);
    expect(item.shopifyVariantId).toBe(variant.shopifyVariantId);
    expect(item.shopifyProductId).toBe(product.shopifyProductId);
    // Snapshots, not joins: the order must still read correctly after the catalog
    // moves on.
    expect(item.productTitle).toBe("Snowboard");
    expect(item.variantTitle).toBe(variant.title);
    expect(item.sku).toBe(variant.sku);
    expect(item.unitPrice.toString()).toBe("19.99");
    expect(item.quantity).toBe(3);
    expect(item.lineTotal.toString()).toBe("59.97");
  });

  it("stores the customer's details and an unguessable confirmation token", async () => {
    const product = await seedProduct({ variants: [{ price: "5.00" }] });

    const result = await placeOrder(checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const order = await db.order.findUnique({ where: { reference: result.order.reference } });
    expect(order?.customerName).toBe("Ayesha Khan");
    // Stored in E.164, not as typed: the fixture sends "+92 300 1234567" and the
    // schema normalises it, so what reaches Shopify is settled here rather than
    // depending on a shopper's spacing.
    expect(order?.customerPhone).toBe("+923001234567");
    expect(order?.city).toBe("Lahore");
    expect(order?.countryCode).toBe("PK");
    expect(order?.customerNote).toBe("Call on arrival");

    // The token addresses the confirmation page. It must not be derivable from
    // the reference, which is short, spoken aloud, and therefore guessable.
    expect(result.order.publicToken.length).toBeGreaterThanOrEqual(24);
    expect(result.order.publicToken).not.toContain(result.order.reference);
    expect(order?.submissionKey.length).toBeGreaterThan(0);
  });

  it("sums several lines, each at its own database price", async () => {
    const product = await seedProduct({
      variants: [{ price: "19.99" }, { price: "0.10" }, { price: "1000.5000" }],
    });

    const result = await placeOrder(
      checkoutBody([
        { variantId: product.variants[0].id, quantity: 2 },
        { variantId: product.variants[1].id, quantity: 3 },
        { variantId: product.variants[2].id, quantity: 1 },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 39.98 + 0.30 + 1000.50. In floating point, 0.10 * 3 is 0.30000000000000004
    // and the total comes out as 1040.7800000000002.
    const order = await db.order.findUnique({
      where: { reference: result.order.reference },
      include: { items: true },
    });
    expect(order?.grandTotal.toString()).toBe("1040.78");
    expect(order?.items).toHaveLength(3);
  });

  it("keeps four decimal places when a price has them", async () => {
    // DECIMAL(18,4) is the column; a price of 0.3333 must not be rounded at
    // checkout, only ever when it is displayed.
    const product = await seedProduct({ variants: [{ price: "0.3333" }] });

    const result = await placeOrder(checkoutBody([{ variantId: product.variants[0].id, quantity: 3 }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const order = await db.order.findUnique({ where: { reference: result.order.reference } });
    expect(order?.grandTotal.toString()).toBe("0.9999");
  });

  it("survives a value far beyond what a float can represent", async () => {
    const product = await seedProduct({ variants: [{ price: "99999999999.9999" }] });

    const result = await placeOrder(checkoutBody([{ variantId: product.variants[0].id, quantity: 2 }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const order = await db.order.findUnique({ where: { reference: result.order.reference } });
    expect(order?.grandTotal.toString()).toBe("199999999999.9998");
  });
});

describe("placeOrder: the browser cannot set a price", () => {
  it("rejects a request carrying a line price", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99" }] });

    const result = await placeOrder({
      ...checkoutBody([]),
      items: [{ variantId: product.variants[0].id, quantity: 1, price: "0.01" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation_failed");
    // Nothing was written: a tampered request is not a cheaper order, it is no
    // order.
    expect(await db.order.count()).toBe(0);
  });

  it("rejects a request carrying a subtotal or a grand total", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99" }] });
    const items = [{ variantId: product.variants[0].id, quantity: 1 }];

    for (const tampering of [{ subtotal: "0.01" }, { grandTotal: "0.01" }, { shippingTotal: "-50.00" }]) {
      const result = await placeOrder({ ...checkoutBody(items), ...tampering });
      expect(result.ok).toBe(false);
    }
    expect(await db.order.count()).toBe(0);
  });

  it("prices the order from the database even when the catalog changed mid-checkout", async () => {
    // The shopper saw 19.99 on the product page. The price then rose. The order
    // is created at the price that is in MySQL when the order is placed, which is
    // the only number anyone can defend.
    const product = await seedProduct({ variants: [{ price: "19.99" }] });
    const variant = product.variants[0];

    await db.productVariant.update({ where: { id: variant.id }, data: { price: "24.50" } });

    const result = await placeOrder(checkoutBody([{ variantId: variant.id, quantity: 2 }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const order = await db.order.findUnique({
      where: { reference: result.order.reference },
      include: { items: true },
    });
    // "24.5" and "49", not "24.50" and "49.00": Decimal.toString() drops trailing
    // zeros, which is why `normalizeMoney` exists for anything a shopper reads.
    // These assertions are on the stored VALUE, so they use its exact form.
    expect(order?.items[0].unitPrice.toString()).toBe("24.5");
    expect(order?.grandTotal.toString()).toBe("49");

    // What the confirmation page actually renders.
    const view = await getOrderByPublicToken(result.order.publicToken);
    expect(view?.items[0].unitPrice).toBe("24.50");
    expect(view?.grandTotal).toBe("49.00");
  });

  it("ignores a quantity that disagrees with anything but the request itself", async () => {
    // Belt and braces on the arithmetic: the line total is unitPrice * quantity
    // computed server-side, not a number the client could have supplied.
    const product = await seedProduct({ variants: [{ price: "7.35" }] });

    const result = await placeOrder(checkoutBody([{ variantId: product.variants[0].id, quantity: 7 }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const order = await db.order.findUnique({
      where: { reference: result.order.reference },
      include: { items: true },
    });
    expect(order?.items[0].lineTotal.toString()).toBe("51.45");
    expect(order?.subtotal.toString()).toBe("51.45");
  });
});

describe("placeOrder: unsellable lines are refused", () => {
  it("blocks an inactive variant", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99", isActive: false }] });

    const result = await placeOrder(checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("cart_invalid");
    if (result.code !== "cart_invalid") return;
    expect(result.lineErrors[0].problem).toBe("variant_inactive");
    expect(await db.order.count()).toBe(0);
  });

  it("blocks a variant whose product is archived or a draft", async () => {
    for (const status of ["ARCHIVED", "DRAFT"] as const) {
      const product = await seedProduct({ status, variants: [{ price: "19.99", isActive: true }] });

      const result = await placeOrder(checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }]));
      expect(result.ok).toBe(false);
      if (result.ok || result.code !== "cart_invalid") continue;
      expect(result.lineErrors[0].problem).toBe("product_unavailable");
    }
    expect(await db.order.count()).toBe(0);
  });

  it("blocks an out-of-stock variant", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99", inventoryQuantity: 0 }] });

    const result = await placeOrder(checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }]));
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== "cart_invalid") return;
    expect(result.lineErrors[0].problem).toBe("out_of_stock");
    expect(await db.order.count()).toBe(0);
  });

  it("blocks a quantity larger than the stock on hand", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99", inventoryQuantity: 2 }] });

    const result = await placeOrder(checkoutBody([{ variantId: product.variants[0].id, quantity: 5 }]));
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== "cart_invalid") return;
    expect(result.lineErrors[0].problem).toBe("insufficient_stock");
    expect(await db.order.count()).toBe(0);
  });

  it("allows exactly the stock on hand", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99", inventoryQuantity: 4 }] });

    const result = await placeOrder(checkoutBody([{ variantId: product.variants[0].id, quantity: 4 }]));
    expect(result.ok).toBe(true);
  });

  it("allows an untracked or oversellable variant with no stock", async () => {
    const product = await seedProduct({
      variants: [
        { price: "19.99", inventoryQuantity: 0, inventoryTracked: false },
        { price: "5.00", inventoryQuantity: 0, inventoryPolicy: "CONTINUE" },
      ],
    });

    const result = await placeOrder(
      checkoutBody([
        { variantId: product.variants[0].id, quantity: 3 },
        { variantId: product.variants[1].id, quantity: 2 },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a variant id that is not in the catalog", async () => {
    const result = await placeOrder(checkoutBody([{ variantId: "not-a-real-variant", quantity: 1 }]));
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== "cart_invalid") return;
    expect(result.lineErrors[0].problem).toBe("variant_not_found");
    expect(await db.order.count()).toBe(0);
  });

  it("refuses the whole order when one line of several is bad", async () => {
    // All or nothing. Silently dropping the bad line would charge the customer
    // for an order they did not place.
    const product = await seedProduct({
      variants: [{ price: "19.99" }, { price: "9.99", inventoryQuantity: 0 }],
    });

    const result = await placeOrder(
      checkoutBody([
        { variantId: product.variants[0].id, quantity: 1 },
        { variantId: product.variants[1].id, quantity: 1 },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(await db.order.count()).toBe(0);
  });

  it("reports every bad line, not just the first", async () => {
    const product = await seedProduct({
      variants: [
        { price: "19.99", isActive: false },
        { price: "9.99", inventoryQuantity: 0 },
      ],
    });

    const result = await placeOrder(
      checkoutBody([
        { variantId: product.variants[0].id, quantity: 1 },
        { variantId: product.variants[1].id, quantity: 1 },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== "cart_invalid") return;
    expect(result.lineErrors).toHaveLength(2);
  });
});

describe("placeOrder: idempotency", () => {
  it("returns the same order for the same key and the same request", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99" }] });
    const body = checkoutBody([{ variantId: product.variants[0].id, quantity: 2 }]);

    const first = await placeOrder(body);
    const second = await placeOrder(body);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.order.reference).toBe(first.order.reference);
    expect(second.order.publicToken).toBe(first.order.publicToken);
    expect(first.order.replayed).toBe(false);
    expect(second.order.replayed).toBe(true);

    // The point of the whole mechanism: one order, one set of items, one delivery.
    expect(await db.order.count()).toBe(1);
    expect(await db.orderItem.count()).toBe(1);
  });

  it("replays regardless of harmless formatting differences", async () => {
    // Autofill re-submits "+923001234567" where the customer typed
    // "+92 300 1234567". Same order, and it must not become a second one.
    const product = await seedProduct({ variants: [{ price: "19.99" }] });
    const body = checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }]);

    const first = await placeOrder(body);
    const second = await placeOrder({
      ...body,
      customerPhone: "+923001234567",
      customerName: "  ayesha   khan ",
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.order.reference).toBe(first.order.reference);
    expect(await db.order.count()).toBe(1);
  });

  it("refuses the same key with a genuinely different request", async () => {
    // The key is browser-supplied, so this is a security boundary, not a
    // convenience: answering would hand back another request's order, PII and all.
    const product = await seedProduct({ variants: [{ price: "19.99" }] });
    const body = checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }]);

    const first = await placeOrder(body);
    expect(first.ok).toBe(true);

    const conflicting = await placeOrder({ ...body, customerName: "Someone Else" });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.code).toBe("idempotency_conflict");

    expect(await db.order.count()).toBe(1);
  });

  it("refuses the same key when only the cart differs", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99" }] });
    const body = checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }]);

    await placeOrder(body);
    const conflicting = await placeOrder({
      ...body,
      items: [{ variantId: product.variants[0].id, quantity: 9 }],
    });

    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.code).toBe("idempotency_conflict");
    expect(await db.order.count()).toBe(1);
  });

  it("creates one order when two identical requests race", async () => {
    // The pre-flight lookup narrows the window; UNIQUE(idempotencyKey) closes it.
    // This is the test that proves the constraint -- not the lookup -- is the
    // protection, because both callers pass the lookup before either inserts.
    const product = await seedProduct({ variants: [{ price: "19.99", inventoryQuantity: 100 }] });
    const body = checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }]);

    const [a, b] = await Promise.all([placeOrder(body), placeOrder(body)]);

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.order.reference).toBe(b.order.reference);
    // Exactly one of them created it.
    expect([a.order.replayed, b.order.replayed].filter(Boolean)).toHaveLength(1);

    expect(await db.order.count()).toBe(1);
    expect(await db.orderItem.count()).toBe(1);
  });

  it("creates one order when five identical requests race", async () => {
    const product = await seedProduct({ variants: [{ price: "3.00", inventoryQuantity: 100 }] });
    const body = checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }]);

    const results = await Promise.all(Array.from({ length: 5 }, () => placeOrder(body)));

    expect(results.every((result) => result.ok)).toBe(true);
    const references = new Set(
      results.flatMap((result) => (result.ok ? [result.order.reference] : [])),
    );
    expect(references.size).toBe(1);
    expect(await db.order.count()).toBe(1);
  });

  it("lets different keys create different orders", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99", inventoryQuantity: 100 }] });
    const items = [{ variantId: product.variants[0].id, quantity: 1 }];

    const first = await placeOrder(checkoutBody(items));
    const second = await placeOrder(checkoutBody(items));

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.order.reference).not.toBe(first.order.reference);
    expect(await db.order.count()).toBe(2);
  });

  it("gives every order a distinct reference, token and submission key", async () => {
    const product = await seedProduct({ variants: [{ price: "1.00", inventoryQuantity: 100 }] });
    const items = [{ variantId: product.variants[0].id, quantity: 1 }];

    for (let index = 0; index < 5; index += 1) await placeOrder(checkoutBody(items));

    const orders = await db.order.findMany({
      select: { reference: true, publicToken: true, submissionKey: true },
    });
    expect(orders).toHaveLength(5);
    expect(new Set(orders.map((order) => order.reference)).size).toBe(5);
    expect(new Set(orders.map((order) => order.publicToken)).size).toBe(5);
    expect(new Set(orders.map((order) => order.submissionKey)).size).toBe(5);
  });
});

describe("placeOrder: the transaction", () => {
  it("writes the order and all of its items together", async () => {
    const product = await seedProduct({
      variants: [{ price: "19.99" }, { price: "5.00" }, { price: "1.25" }],
    });

    const result = await placeOrder(
      checkoutBody(product.variants.map((variant) => ({ variantId: variant.id, quantity: 2 }))),
    );
    expect(result.ok).toBe(true);

    const orders = await db.order.findMany({ include: { items: true } });
    expect(orders).toHaveLength(1);
    expect(orders[0].items).toHaveLength(3);
    // No item may be parented by a different order.
    expect(orders[0].items.every((item) => item.orderId === orders[0].id)).toBe(true);
  });

  it("leaves nothing behind when the transaction fails", async () => {
    // The atomicity claim, tested directly against MySQL: this is the same write
    // shape placeOrder uses, aborted after the items are created.
    const product = await seedProduct({ variants: [{ price: "19.99" }] });
    const variant = product.variants[0];

    await expect(
      db.$transaction(async (tx) => {
        await tx.order.create({
          data: {
            reference: "COD-ROLLBACK",
            publicToken: "token-rollback",
            idempotencyKey: "key-rollback-00000000",
            requestFingerprint: "f".repeat(64),
            submissionKey: "submission-rollback",
            status: "PENDING_SYNC",
            paymentMethod: "COD",
            currencyCode: "USD",
            subtotal: "19.99",
            grandTotal: "19.99",
            customerName: "Ayesha Khan",
            customerPhone: "+923001234567",
            addressLine1: "12 Jinnah Road",
            city: "Lahore",
            countryCode: "PK",
            items: {
              create: [
                {
                  variantId: variant.id,
                  shopifyVariantId: variant.shopifyVariantId,
                  shopifyProductId: product.shopifyProductId,
                  productTitle: product.title,
                  variantTitle: variant.title,
                  sku: variant.sku,
                  unitPrice: "19.99",
                  quantity: 1,
                  lineTotal: "19.99",
                },
              ],
            },
          },
        });

        throw new Error("aborting after the writes, before the commit");
      }),
    ).rejects.toThrow("aborting after the writes");

    // An order with no items is unfulfillable; items with no order are
    // unreachable. Neither may exist.
    expect(await db.order.count()).toBe(0);
    expect(await db.orderItem.count()).toBe(0);
  });
});

/**
 * Phone validation, which exists because of a verified production failure: a
 * number Shopify refuses used to pass checkout, so the order committed, the
 * shopper saw a confirmation page, and the submission went `FAILED` in a
 * background worker where nobody saw it (VERIFICATION.md 5a).
 *
 * The claim under test is therefore not "the schema rejects it" -- that is a unit
 * test -- but that **nothing is written and nothing is queued** when it does.
 */
describe("placeOrder: an unusable phone number is refused before anything is written", () => {
  /** Shapes a real shopper produces, all refused by Shopify's own validation. */
  const UNUSABLE = ["03001234567", "(042) 111-222-333", "0300-1234567", "+92", "none"];

  it("rejects it as a validation failure, naming the phone field", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99" }] });

    for (const phone of UNUSABLE) {
      const result = await placeOrder(
        checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }], {
          customerPhone: phone,
        }),
      );

      expect(result.ok, phone).toBe(false);
      if (result.ok) return;
      expect(result.code, phone).toBe("validation_failed");
      if (result.code !== "validation_failed") return;
      // The key the form reads. A nested key would render nothing, which is the
      // same silent failure in a different place.
      expect(result.fieldErrors.customerPhone, phone).toContain("+923001234567");
    }
  });

  it("creates no Order and no OrderItem", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99" }] });

    for (const phone of UNUSABLE) {
      await placeOrder(
        checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }], {
          customerPhone: phone,
        }),
      );
    }

    // Counted on the second connection, so this is about committed rows.
    expect(await db.order.count()).toBe(0);
    expect(await db.orderItem.count()).toBe(0);
  });

  it("enqueues no submit-order job", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99" }] });
    const enqueuer = recordingEnqueuer();

    await placeOrder(
      checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }], {
        customerPhone: "03001234567",
      }),
      { enqueueSubmit: enqueuer.enqueueSubmit },
    );

    expect(enqueuer.calls).toHaveLength(0);
  });

  it("adds nothing to the real BullMQ queue", async () => {
    // The injected enqueuer above proves the service never called it. This proves
    // the queue itself is untouched, against real Redis -- the two together rule
    // out both "we called it" and "something else queued it".
    const product = await seedProduct({ variants: [{ price: "19.99" }] });
    const queue = getSubmitOrderQueue();
    await queue.waitUntilReady();

    const before = await queue.getJobCounts();

    const result = await placeOrder(
      checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }], {
        customerPhone: "03001234567",
      }),
      { enqueueSubmit: async (orderId) => { await enqueueSubmitOrder(orderId); } },
    );
    expect(result.ok).toBe(false);

    expect(await queue.getJobCounts()).toEqual(before);
    expect(await db.order.count()).toBe(0);
  });

  it("accepts a valid international number and stores it in E.164", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99" }] });

    // Three spellings of one number, each placed as its own order.
    for (const phone of ["+923001234567", "+92 300 1234567", "0092-300-1234567"]) {
      const result = await placeOrder(
        checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }], {
          customerPhone: phone,
        }),
      );

      expect(result.ok, phone).toBe(true);
      if (!result.ok) return;

      const order = await db.order.findUnique({
        where: { reference: result.order.reference },
        select: { customerPhone: true, status: true },
      });
      expect(order?.customerPhone, phone).toBe("+923001234567");
      expect(order?.status, phone).toBe("PENDING_SYNC");
    }
  });

  it("still refuses an over-long value on the column width, before format", async () => {
    // VARCHAR(32). The width check must not be lost behind the format check.
    const product = await seedProduct({ variants: [{ price: "19.99" }] });

    const result = await placeOrder(
      checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }], {
        customerPhone: `+${"9".repeat(40)}`,
      }),
    );

    expect(result.ok).toBe(false);
    expect(await db.order.count()).toBe(0);
  });
});

describe("placeOrder: the queue handoff", () => {
  it("enqueues exactly one job, and only after the order is committed", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99" }] });
    const enqueuer = recordingEnqueuer();

    const result = await placeOrder(
      checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }]),
      { enqueueSubmit: enqueuer.enqueueSubmit },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(enqueuer.calls).toHaveLength(1);
    // Read on a second connection: visible means committed. Enqueuing inside the
    // transaction would publish a job for a row a rollback then removes.
    expect(enqueuer.calls[0].orderWasVisible).toBe(true);

    const order = await db.order.findUnique({ where: { reference: result.order.reference } });
    expect(enqueuer.calls[0].orderId).toBe(order?.id);
  });

  it("does not enqueue a second job when a request is replayed", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99" }] });
    const body = checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }]);
    const enqueuer = recordingEnqueuer();

    await placeOrder(body, { enqueueSubmit: enqueuer.enqueueSubmit });
    await placeOrder(body, { enqueueSubmit: enqueuer.enqueueSubmit });

    expect(enqueuer.calls).toHaveLength(1);
  });

  it("does not enqueue anything when the cart is refused", async () => {
    const product = await seedProduct({ variants: [{ price: "19.99", isActive: false }] });
    const enqueuer = recordingEnqueuer();

    await placeOrder(checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }]), {
      enqueueSubmit: enqueuer.enqueueSubmit,
    });

    expect(enqueuer.calls).toHaveLength(0);
  });

  it("keeps the order when enqueuing fails, and does not duplicate it on retry", async () => {
    // Redis is down. The order is committed and PENDING_SYNC, which is the outbox:
    // the recovery sweep re-enqueues it. Failing the request instead would invite
    // a retry, and a retry with a fresh key would place a SECOND order for one
    // delivery.
    const product = await seedProduct({ variants: [{ price: "19.99" }] });
    const body = checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }]);

    const result = await placeOrder(body, {
      enqueueSubmit: async () => {
        throw new Error("redis unavailable");
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const order = await db.order.findUnique({ where: { reference: result.order.reference } });
    expect(order?.status).toBe("PENDING_SYNC");
    // Recoverable: the row carries everything the sweep needs.
    expect(order?.submissionKey.length).toBeGreaterThan(0);
    expect(order?.shopifyDraftOrderId).toBeNull();

    // The retry the customer's browser makes replays rather than duplicating.
    const retry = await placeOrder(body, { enqueueSubmit: async () => undefined });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.order.reference).toBe(result.order.reference);
    expect(retry.order.replayed).toBe(true);
    expect(await db.order.count()).toBe(1);
  });
});

describe("getOrderByPublicToken", () => {
  it("finds an order by its token and totals it from the stored row", async () => {
    const product = await seedProduct({ title: "Snowboard", variants: [{ price: "19.99" }] });

    const placed = await placeOrder(checkoutBody([{ variantId: product.variants[0].id, quantity: 3 }]));
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;

    const view = await getOrderByPublicToken(placed.order.publicToken);
    expect(view).not.toBeNull();
    if (!view) return;

    expect(view.reference).toBe(placed.order.reference);
    expect(view.status).toBe("PENDING_SYNC");
    // Normalised for display: Decimal.toString() would render 59.9700 as "59.97"
    // but 15.0000 as "15", which looks wrong beside other prices.
    expect(view.grandTotal).toBe("59.97");
    expect(view.subtotal).toBe("59.97");
    expect(view.shippingTotal).toBe("0.00");
    expect(view.taxTotal).toBe("0.00");
    expect(view.itemCount).toBe(3);
    expect(view.items[0].productTitle).toBe("Snowboard");
    expect(view.items[0].unitPrice).toBe("19.99");
  });

  it("exposes only the identity a confirmation page needs", async () => {
    // Anyone holding the link can open this page, including whoever finds it in a
    // shared browser's history. It shows a first name and a city; it must not show
    // a phone number, an email or a street address.
    const product = await seedProduct({ variants: [{ price: "5.00" }] });

    const placed = await placeOrder(checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }]));
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;

    const view = await getOrderByPublicToken(placed.order.publicToken);
    expect(view?.customerFirstName).toBe("Ayesha");

    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain("1234567");
    expect(serialised).not.toContain("ayesha@example.com");
    expect(serialised).not.toContain("Jinnah Road");
    expect(serialised).not.toContain("Flat 4");
    expect(serialised).not.toContain("Khan");
  });

  it("returns null for an unknown, malformed or empty token", async () => {
    for (const token of ["", "short", "x".repeat(65), "does-not-exist-but-is-long-enough"]) {
      expect(await getOrderByPublicToken(token)).toBeNull();
    }
  });

  it("cannot be addressed by the order's reference", async () => {
    // The reference is the guessable identifier. If it worked here, the order
    // table would be enumerable.
    const product = await seedProduct({ variants: [{ price: "5.00" }] });

    const placed = await placeOrder(checkoutBody([{ variantId: product.variants[0].id, quantity: 1 }]));
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;

    expect(await getOrderByPublicToken(placed.order.reference)).toBeNull();
  });
});
