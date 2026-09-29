/**
 * The submit-order state machine, against real MySQL with a fake Shopify.
 *
 * Shopify is faked; the database is not. That split is deliberate: every claim
 * this phase makes is about what MySQL does under concurrent conditional updates
 * -- `UPDATE ... WHERE status = 'PENDING_SYNC'` affecting one row out of two
 * simultaneous attempts -- and a fake database would prove nothing about it. No
 * test here creates a Shopify draft or order.
 *
 * The fake port counts its calls, which is how "does not create a second draft"
 * is verified: not by inspecting our own logic, but by asserting that the
 * operation was never invoked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { disconnect, resetDatabase, testPrisma } from "./setup";

// Must happen before anything imports src/lib/prisma.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
// Short, explicit lease so expiry can be simulated by moving a timestamp rather
// than by waiting.
process.env.ORDER_CLAIM_LEASE_SECONDS = "60";
process.env.ORDER_RECOVERY_GRACE_SECONDS = "30";

const { Prisma } = await import("@/src/generated/prisma");
const orderRepo = await import("@/src/lib/orders/order-repo");
const submitModule = await import("@/src/lib/orders/submit-order");
const recoveryModule = await import("@/src/lib/orders/recovery");
const processor = await import("@/src/worker/processors/submit-order");
const { ShopifyError } = await import("@/src/lib/shopify/errors");
const { submissionTagQuery, MAX_TAG_LENGTH } = await import("@/src/lib/shopify/order-mutations");
const { logger } = await import("@/src/lib/logger");

const db = testPrisma;
const log = logger.child({ service: "test" });

let seq = 0;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

interface SeedOrderOptions {
  status?: "PENDING_SYNC" | "SYNCING" | "DRAFT_CREATED" | "SYNCED" | "FAILED";
  shopifyDraftOrderId?: string | null;
  shopifyOrderId?: string | null;
  claimedAt?: Date | null;
  createdAt?: Date;
  attempt?: number;
  items?: Array<{ unitPrice: string; quantity: number }>;
}

async function seedOrder(options: SeedOrderOptions = {}) {
  seq += 1;
  const items = options.items ?? [{ unitPrice: "19.99", quantity: 2 }];

  // The totals must satisfy the hand-written CHECK constraints -- lineTotal =
  // unitPrice * quantity, grandTotal = subtotal + shipping + tax -- so they are
  // computed with Decimal rather than written by hand. The first draft of this
  // fixture set lineTotal to the unit price and MySQL rejected it, which is the
  // constraint earning its place.
  const lineTotals = items.map((item) =>
    new Prisma.Decimal(item.unitPrice).mul(item.quantity),
  );
  const subtotal = lineTotals.reduce((total, line) => total.add(line), new Prisma.Decimal(0));

  const order = await db.order.create({
    data: {
      reference: `COD-TEST${seq}`,
      publicToken: `token-${seq}-${"x".repeat(20)}`,
      idempotencyKey: `key-${seq}-${"0".repeat(10)}`,
      requestFingerprint: "f".repeat(64),
      submissionKey: `submission-${seq}-0d9f1c3e`,
      status: options.status ?? "PENDING_SYNC",
      paymentMethod: "COD",
      currencyCode: "USD",
      subtotal,
      grandTotal: subtotal,
      customerName: "Ayesha Khan",
      customerPhone: "+923001234567",
      customerEmail: "ayesha@example.com",
      addressLine1: "12 Jinnah Road",
      city: "Lahore",
      province: "Punjab",
      postalCode: "54000",
      countryCode: "PK",
      shopifyDraftOrderId: options.shopifyDraftOrderId ?? null,
      shopifyOrderId: options.shopifyOrderId ?? null,
      claimedAt: options.claimedAt ?? null,
      attempt: options.attempt ?? 0,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      items: {
        create: items.map((item, index) => ({
          shopifyVariantId: `gid://shopify/ProductVariant/${seq}-${index}`,
          shopifyProductId: `gid://shopify/Product/${seq}`,
          productTitle: "Snowboard",
          variantTitle: "Default Title",
          sku: `SKU-${seq}-${index}`,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          lineTotal: lineTotals[index],
        })),
      },
    },
    select: { id: true, reference: true, submissionKey: true },
  });

  return order;
}

/**
 * A Shopify that records what it was asked to do.
 *
 * Every behaviour is overridable per test, and every call is counted -- the
 * counts are what prove "resumed without creating a second draft".
 */
function fakeShopify(
  overrides: Partial<import("@/src/lib/orders/submit-order").ShopifyPort> = {},
) {
  const calls = { create: 0, complete: 0, get: 0, find: 0, terms: 0 };
  const created: Array<import("@/src/lib/orders/draft-order-input").DraftOrderInput> = [];
  let draftSeq = 0;

  const port: import("@/src/lib/orders/submit-order").ShopifyPort = {
    async createDraftOrder(input) {
      calls.create += 1;
      draftSeq += 1;
      created.push(input);
      return {
        id: `gid://shopify/DraftOrder/${draftSeq}`,
        name: `#D${draftSeq}`,
        status: "OPEN",
        order: null,
      };
    },
    async completeDraftOrder(draftOrderId) {
      calls.complete += 1;
      return {
        id: draftOrderId,
        name: "#D1",
        status: "COMPLETED",
        order: { id: "gid://shopify/Order/555", name: "#1001" },
      };
    },
    async getDraftOrder(draftOrderId) {
      calls.get += 1;
      return { id: draftOrderId, name: "#D1", status: "OPEN", order: null };
    },
    async findDraftOrdersByQuery() {
      calls.find += 1;
      return [];
    },
    async resolvePaymentTermsTemplateId() {
      calls.terms += 1;
      return "gid://shopify/PaymentTermsTemplate/9";
    },
    ...overrides,
  };

  return { port, calls, created };
}

function context(
  shopify: import("@/src/lib/orders/submit-order").ShopifyPort,
  willRetry = true,
) {
  return { prisma: db as never, shopify, log, willRetry };
}

beforeAll(resetDatabase);
beforeEach(resetDatabase);
afterAll(disconnect);

// ---------------------------------------------------------------------------
// claim and lease
// ---------------------------------------------------------------------------

describe("claimOrderForSubmission", () => {
  it("claims a PENDING_SYNC order, moving it to SYNCING with a lease", async () => {
    const order = await seedOrder();
    const before = new Date();

    const outcome = await orderRepo.claimOrderForSubmission(db, order.id);

    expect(outcome.kind).toBe("claimed");
    const row = await db.order.findUnique({ where: { id: order.id } });
    expect(row?.status).toBe("SYNCING");
    expect(row?.claimedAt).not.toBeNull();
    expect(row!.claimedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    // The attempt counter records CLAIMS, so it survives a crash mid-submission.
    expect(row?.attempt).toBe(1);
  });

  it("reports the status the attempt started from", async () => {
    const pending = await seedOrder();
    const claimedPending = await orderRepo.claimOrderForSubmission(db, pending.id);
    expect(claimedPending.kind === "claimed" && claimedPending.order.startStatus).toBe("PENDING_SYNC");

    const resumable = await seedOrder({
      status: "DRAFT_CREATED",
      shopifyDraftOrderId: "gid://shopify/DraftOrder/9",
    });
    const claimedDraft = await orderRepo.claimOrderForSubmission(db, resumable.id);
    expect(claimedDraft.kind === "claimed" && claimedDraft.order.startStatus).toBe("DRAFT_CREATED");
  });

  it("claims a DRAFT_CREATED order, because completion is what remains", async () => {
    const order = await seedOrder({
      status: "DRAFT_CREATED",
      shopifyDraftOrderId: "gid://shopify/DraftOrder/7",
    });
    const outcome = await orderRepo.claimOrderForSubmission(db, order.id);
    expect(outcome.kind).toBe("claimed");
    expect(outcome.kind === "claimed" && outcome.order.shopifyDraftOrderId).toBe(
      "gid://shopify/DraftOrder/7",
    );
  });

  it("claims a FAILED order, so a retry needs no manual status edit", async () => {
    const order = await seedOrder({ status: "FAILED" });
    expect((await orderRepo.claimOrderForSubmission(db, order.id)).kind).toBe("claimed");
  });

  it("refuses to claim a SYNCED order", async () => {
    // The one status that is never claimable: there is nothing left to do, and a
    // claim would be the first step toward a duplicate order.
    const order = await seedOrder({ status: "SYNCED", shopifyOrderId: "gid://shopify/Order/1" });

    const outcome = await orderRepo.claimOrderForSubmission(db, order.id);

    expect(outcome.kind).toBe("already_synced");
    expect(outcome.kind === "already_synced" && outcome.shopifyOrderId).toBe("gid://shopify/Order/1");
    // Untouched: no status change, no attempt increment.
    const row = await db.order.findUnique({ where: { id: order.id } });
    expect(row?.status).toBe("SYNCED");
    expect(row?.attempt).toBe(0);
  });

  it("refuses a second claim while the lease is live", async () => {
    const order = await seedOrder();

    const first = await orderRepo.claimOrderForSubmission(db, order.id);
    const second = await orderRepo.claimOrderForSubmission(db, order.id);

    expect(first.kind).toBe("claimed");
    expect(second.kind).toBe("held_elsewhere");
    expect((await db.order.findUnique({ where: { id: order.id } }))?.attempt).toBe(1);
  });

  it("gives the claim to exactly one of many simultaneous claimers", async () => {
    // The real concurrency test: five callers issue the conditional UPDATE at
    // once. InnoDB serialises them on the row and only the first one's WHERE
    // still matches.
    const order = await seedOrder();

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => orderRepo.claimOrderForSubmission(db, order.id)),
    );

    expect(outcomes.filter((o) => o.kind === "claimed")).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "held_elsewhere")).toHaveLength(4);
    expect((await db.order.findUnique({ where: { id: order.id } }))?.attempt).toBe(1);
  });

  it("reclaims a SYNCING order whose lease has expired", async () => {
    // A worker died mid-submission. Without this the order is unreachable by any
    // retry, forever.
    const order = await seedOrder({
      status: "SYNCING",
      claimedAt: new Date(Date.now() - 120_000), // lease is 60s in this suite
    });

    const outcome = await orderRepo.claimOrderForSubmission(db, order.id);

    expect(outcome.kind).toBe("claimed");
    const row = await db.order.findUnique({ where: { id: order.id } });
    expect(row?.status).toBe("SYNCING");
    expect(row!.claimedAt!.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it("does not reclaim a SYNCING order whose lease is still valid", async () => {
    const order = await seedOrder({ status: "SYNCING", claimedAt: new Date(Date.now() - 5_000) });
    expect((await orderRepo.claimOrderForSubmission(db, order.id)).kind).toBe("held_elsewhere");
  });

  it("reports a missing order rather than throwing", async () => {
    expect((await orderRepo.claimOrderForSubmission(db, "does-not-exist")).kind).toBe("not_found");
  });

  it("loads the line items a submission needs, as exact decimal strings", async () => {
    const order = await seedOrder({
      items: [
        { unitPrice: "19.99", quantity: 2 },
        { unitPrice: "1000.5000", quantity: 1 },
      ],
    });

    const outcome = await orderRepo.claimOrderForSubmission(db, order.id);
    expect(outcome.kind).toBe("claimed");
    if (outcome.kind !== "claimed") return;

    expect(outcome.order.items).toHaveLength(2);
    expect(outcome.order.items.map((i) => i.unitPrice)).toEqual(["19.99", "1000.5"]);
    expect(outcome.order.items.every((i) => typeof i.unitPrice === "string")).toBe(true);
  });
});

describe("releaseClaim", () => {
  it("returns an order with no draft to PENDING_SYNC", async () => {
    const order = await seedOrder();
    const claimed = await orderRepo.claimOrderForSubmission(db, order.id);
    expect(claimed.kind).toBe("claimed");

    const row = await db.order.findUnique({ where: { id: order.id }, select: { claimedAt: true } });
    const released = await orderRepo.releaseClaim(db, order.id, row!.claimedAt!);

    expect(released).toBe("PENDING_SYNC");
    const after = await db.order.findUnique({ where: { id: order.id } });
    expect(after?.status).toBe("PENDING_SYNC");
    expect(after?.claimedAt).toBeNull();
  });

  it("returns an order that has a draft to DRAFT_CREATED, not PENDING_SYNC", async () => {
    // The status must describe how far the work actually got, or the next attempt
    // would think it has to create a draft.
    const order = await seedOrder({
      status: "DRAFT_CREATED",
      shopifyDraftOrderId: "gid://shopify/DraftOrder/3",
    });
    await orderRepo.claimOrderForSubmission(db, order.id);
    const row = await db.order.findUnique({ where: { id: order.id }, select: { claimedAt: true } });

    expect(await orderRepo.releaseClaim(db, order.id, row!.claimedAt!)).toBe("DRAFT_CREATED");
  });

  it("does nothing when the lease has already been taken over", async () => {
    const order = await seedOrder();
    await orderRepo.claimOrderForSubmission(db, order.id);

    // A stale timestamp: this worker's lease, already superseded.
    const released = await orderRepo.releaseClaim(db, order.id, new Date(Date.now() - 999_999));

    expect(released).toBeNull();
    expect((await db.order.findUnique({ where: { id: order.id } }))?.status).toBe("SYNCING");
  });
});

// ---------------------------------------------------------------------------
// the happy path and its checkpoint
// ---------------------------------------------------------------------------

describe("submitOrder: PENDING_SYNC -> SYNCED", () => {
  it("creates a draft, completes it, and persists both Shopify ids", async () => {
    const order = await seedOrder();
    const shopify = fakeShopify();

    const outcome = await submitModule.submitOrder(order.id, context(shopify.port));

    expect(outcome.kind).toBe("synced");
    expect(shopify.calls.create).toBe(1);
    expect(shopify.calls.complete).toBe(1);

    const row = await db.order.findUnique({ where: { id: order.id } });
    expect(row?.status).toBe("SYNCED");
    expect(row?.shopifyDraftOrderId).toBe("gid://shopify/DraftOrder/1");
    expect(row?.shopifyOrderId).toBe("gid://shopify/Order/555");
    expect(row?.shopifyOrderName).toBe("#1001");
    expect(row?.submittedAt).not.toBeNull();
    // The lease is released on success: a SYNCED row must not look claimed.
    expect(row?.claimedAt).toBeNull();
    expect(row?.failureReason).toBeNull();
  });

  it("sends the snapshot prices, not the catalog's", async () => {
    const order = await seedOrder({ items: [{ unitPrice: "19.99", quantity: 3 }] });
    const shopify = fakeShopify();

    await submitModule.submitOrder(order.id, context(shopify.port));

    const input = shopify.created[0];
    expect(input.lineItems[0].priceOverride).toEqual({ amount: "19.99", currencyCode: "USD" });
    expect(input.lineItems[0].quantity).toBe(3);
    expect(input.taxExempt).toBe(true);
    expect(input.shippingLine.priceWithCurrency.amount).toBe("0.00");
    expect(input.paymentTerms?.paymentTermsTemplateId).toBe("gid://shopify/PaymentTermsTemplate/9");
  });

  it("persists the draft id BEFORE attempting completion", async () => {
    // The single most important write in the phase. If completion fails, the draft
    // id must already be durable or the next attempt creates a second draft.
    const order = await seedOrder();
    const shopify = fakeShopify({
      async completeDraftOrder() {
        // Observed from inside the failure: what does the row say right now?
        const row = await db.order.findUnique({ where: { id: order.id } });
        expect(row?.status).toBe("DRAFT_CREATED");
        expect(row?.shopifyDraftOrderId).toBe("gid://shopify/DraftOrder/1");
        throw new ShopifyError("boom", { kind: "transport", retryable: true });
      },
    });

    await expect(submitModule.submitOrder(order.id, context(shopify.port))).rejects.toThrow("boom");

    const row = await db.order.findUnique({ where: { id: order.id } });
    expect(row?.status).toBe("DRAFT_CREATED");
    expect(row?.shopifyDraftOrderId).toBe("gid://shopify/DraftOrder/1");
  });
});

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

describe("submitOrder: idempotency", () => {
  it("resumes a DRAFT_CREATED order without creating a second draft", async () => {
    const order = await seedOrder({
      status: "DRAFT_CREATED",
      shopifyDraftOrderId: "gid://shopify/DraftOrder/42",
    });
    const shopify = fakeShopify();

    const outcome = await submitModule.submitOrder(order.id, context(shopify.port));

    expect(outcome.kind).toBe("synced");
    // The assertion that matters: no second draft, and no tag search either --
    // the stored id is trusted without a round trip.
    expect(shopify.calls.create).toBe(0);
    expect(shopify.calls.find).toBe(0);
    expect(shopify.calls.complete).toBe(1);

    const row = await db.order.findUnique({ where: { id: order.id } });
    expect(row?.shopifyDraftOrderId).toBe("gid://shopify/DraftOrder/42");
    expect(row?.status).toBe("SYNCED");
  });

  it("is a no-op for an order that is already SYNCED", async () => {
    const order = await seedOrder({ status: "SYNCED", shopifyOrderId: "gid://shopify/Order/99" });
    const shopify = fakeShopify();

    const outcome = await submitModule.submitOrder(order.id, context(shopify.port));

    expect(outcome.kind).toBe("already_synced");
    expect(shopify.calls).toEqual({ create: 0, complete: 0, get: 0, find: 0, terms: 0 });
    const row = await db.order.findUnique({ where: { id: order.id } });
    expect(row?.status).toBe("SYNCED");
    expect(row?.attempt).toBe(0);
  });

  it("creates ONE draft and ONE order when two workers submit at once", async () => {
    // Duplicate prevention, end to end. Both callers race; the claim decides.
    const order = await seedOrder();
    const shopify = fakeShopify();

    const outcomes = await Promise.all([
      submitModule.submitOrder(order.id, context(shopify.port)),
      submitModule.submitOrder(order.id, context(shopify.port)),
    ]);

    expect(shopify.calls.create).toBe(1);
    expect(shopify.calls.complete).toBe(1);
    expect(outcomes.filter((o) => o.kind === "synced")).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "held_elsewhere")).toHaveLength(1);

    const row = await db.order.findUnique({ where: { id: order.id } });
    expect(row?.status).toBe("SYNCED");
    expect(row?.shopifyOrderId).toBe("gid://shopify/Order/555");
  });

  it("adopts a draft found by its submission tag when the create response was lost", async () => {
    // The draft exists in Shopify but its id never reached MySQL. Creating another
    // would leave two drafts for one order.
    const order = await seedOrder();
    const shopify = fakeShopify({
      async findDraftOrdersByQuery() {
        return [
          { id: "gid://shopify/DraftOrder/lost", name: "#D-lost", status: "OPEN", order: null },
        ];
      },
    });

    const outcome = await submitModule.submitOrder(order.id, context(shopify.port));

    expect(outcome.kind).toBe("synced");
    expect(shopify.calls.create).toBe(0);
    expect((await db.order.findUnique({ where: { id: order.id } }))?.shopifyDraftOrderId).toBe(
      "gid://shopify/DraftOrder/lost",
    );
  });

  it("searches by the submission key, quoted so hyphens are not negations", async () => {
    const order = await seedOrder();
    let seenQuery = "";
    const shopify = fakeShopify({
      async findDraftOrdersByQuery(query) {
        seenQuery = query;
        return [];
      },
    });

    await submitModule.submitOrder(order.id, context(shopify.port));

    const row = await db.order.findUnique({
      where: { id: order.id },
      select: { submissionKey: true },
    });
    // Derived from the same function the writer uses, not hand-written: the tag
    // is compacted to stay inside Shopify's 40-character limit, and a literal
    // here is exactly what let the two sides drift apart once already.
    expect(seenQuery).toBe(submissionTagQuery(row!.submissionKey));
    expect(seenQuery.startsWith('tag:"')).toBe(true);
    // The tag inside the query must be within the limit, or draftOrderCreate
    // would have refused to write it in the first place and this search could
    // never match anything.
    expect(seenQuery.replace(/^tag:"|"$/g, "").length).toBeLessThanOrEqual(MAX_TAG_LENGTH);
  });

  it("refuses to guess when two drafts share one submission key", async () => {
    const order = await seedOrder();
    const shopify = fakeShopify({
      async findDraftOrdersByQuery() {
        return [
          { id: "gid://shopify/DraftOrder/a", name: "#A", status: "OPEN", order: null },
          { id: "gid://shopify/DraftOrder/b", name: "#B", status: "OPEN", order: null },
        ];
      },
    });

    const outcome = await submitModule.submitOrder(order.id, context(shopify.port));

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.reason).toBe("duplicate_submission_key");
    expect(shopify.calls.create).toBe(0);
    expect((await db.order.findUnique({ where: { id: order.id } }))?.status).toBe("FAILED");
  });

  it("adopts the order of a draft that was already completed", async () => {
    // draftOrderComplete succeeded and its response was lost. Completing again is
    // either an error or, worse, a second order.
    const order = await seedOrder({
      status: "DRAFT_CREATED",
      shopifyDraftOrderId: "gid://shopify/DraftOrder/done",
    });
    const shopify = fakeShopify({
      async getDraftOrder(id) {
        return {
          id,
          name: "#D",
          status: "COMPLETED",
          order: { id: "gid://shopify/Order/already", name: "#2002" },
        };
      },
    });

    const outcome = await submitModule.submitOrder(order.id, context(shopify.port));

    expect(outcome.kind).toBe("synced");
    expect(shopify.calls.complete).toBe(0);
    const row = await db.order.findUnique({ where: { id: order.id } });
    expect(row?.shopifyOrderId).toBe("gid://shopify/Order/already");
    expect(row?.status).toBe("SYNCED");
  });
});

// ---------------------------------------------------------------------------
// failure handling
// ---------------------------------------------------------------------------

describe("submitOrder: retryable failures", () => {
  it("releases the claim and rethrows, so BullMQ retries", async () => {
    const order = await seedOrder();
    const shopify = fakeShopify({
      async createDraftOrder() {
        throw new ShopifyError("socket hang up", { kind: "transport", retryable: true });
      },
    });

    await expect(submitModule.submitOrder(order.id, context(shopify.port, true))).rejects.toThrow(
      "socket hang up",
    );

    // Back to claimable immediately, rather than waiting out the lease.
    const row = await db.order.findUnique({ where: { id: order.id } });
    expect(row?.status).toBe("PENDING_SYNC");
    expect(row?.claimedAt).toBeNull();
    expect(row?.attempt).toBe(1);
  });

  it("does not mark the order FAILED while attempts remain", async () => {
    const order = await seedOrder();
    const shopify = fakeShopify({
      async createDraftOrder() {
        throw new ShopifyError("THROTTLED", { kind: "throttled", retryable: true });
      },
    });

    await expect(submitModule.submitOrder(order.id, context(shopify.port, true))).rejects.toThrow();

    const row = await db.order.findUnique({ where: { id: order.id } });
    expect(row?.status).not.toBe("FAILED");
    expect(row?.failureReason).toBeNull();
  });

  it("marks FAILED when the retryable failure was the last attempt", async () => {
    const order = await seedOrder();
    const shopify = fakeShopify({
      async createDraftOrder() {
        throw new ShopifyError("still down", { kind: "transport", retryable: true });
      },
    });

    const outcome = await submitModule.submitOrder(order.id, context(shopify.port, false));

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.reason).toBe("attempts_exhausted");
    const row = await db.order.findUnique({ where: { id: order.id } });
    expect(row?.status).toBe("FAILED");
    expect(row?.failureReason).toBe("attempts_exhausted");
    expect(row?.claimedAt).toBeNull();
  });

  it("succeeds on a retry after a transient failure", async () => {
    const order = await seedOrder();
    let attempts = 0;
    const shopify = fakeShopify({
      async createDraftOrder() {
        attempts += 1;
        if (attempts === 1) throw new ShopifyError("blip", { kind: "transport", retryable: true });
        return { id: "gid://shopify/DraftOrder/2nd", name: "#D2", status: "OPEN", order: null };
      },
    });

    await expect(submitModule.submitOrder(order.id, context(shopify.port))).rejects.toThrow("blip");
    const outcome = await submitModule.submitOrder(order.id, context(shopify.port));

    expect(outcome.kind).toBe("synced");
    const row = await db.order.findUnique({ where: { id: order.id } });
    expect(row?.status).toBe("SYNCED");
    expect(row?.attempt).toBe(2);
  });
});

describe("submitOrder: permanent failures", () => {
  it("marks FAILED immediately on a userError, without spending retries", async () => {
    const order = await seedOrder();
    const shopify = fakeShopify({
      async createDraftOrder() {
        throw new submitModule.PermanentSubmissionError(
          "draft_create_user_error",
          "lineItems.0.variantId: Variant does not exist",
        );
      },
    });

    const outcome = await submitModule.submitOrder(order.id, context(shopify.port, true));

    // willRetry was true and it still failed terminally: that is the point.
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.retryable).toBe(false);
    const row = await db.order.findUnique({ where: { id: order.id } });
    expect(row?.status).toBe("FAILED");
    expect(row?.failureReason).toBe("draft_create_user_error");
    expect(row?.lastError).toContain("Variant does not exist");
  });

  it("marks FAILED on a non-retryable Shopify error", async () => {
    const order = await seedOrder();
    const shopify = fakeShopify({
      async createDraftOrder() {
        throw new ShopifyError("403 missing scope", { kind: "auth", retryable: false, status: 403 });
      },
    });

    const outcome = await submitModule.submitOrder(order.id, context(shopify.port, true));

    expect(outcome.kind).toBe("failed");
    expect((await db.order.findUnique({ where: { id: order.id } }))?.failureReason).toBe("shopify_auth");
  });

  it("keeps the draft id on failure, so a retry resumes instead of duplicating", async () => {
    const order = await seedOrder();
    const shopify = fakeShopify({
      async completeDraftOrder() {
        throw new submitModule.PermanentSubmissionError("draft_complete_user_error", "refused");
      },
    });

    await submitModule.submitOrder(order.id, context(shopify.port, true));

    const row = await db.order.findUnique({ where: { id: order.id } });
    expect(row?.status).toBe("FAILED");
    // The draft exists in Shopify; forgetting its id would strand it and make the
    // operator retry create a second one.
    expect(row?.shopifyDraftOrderId).toBe("gid://shopify/DraftOrder/1");

    // And an operator retry does resume it.
    const retry = fakeShopify();
    const outcome = await submitModule.submitOrder(order.id, context(retry.port));
    expect(outcome.kind).toBe("synced");
    expect(retry.calls.create).toBe(0);
  });

  it("records no customer data in failureReason or lastError", async () => {
    const order = await seedOrder();
    const shopify = fakeShopify({
      async createDraftOrder() {
        throw new submitModule.PermanentSubmissionError("draft_create_user_error", "phone: is invalid");
      },
    });

    await submitModule.submitOrder(order.id, context(shopify.port, true));

    const row = await db.order.findUnique({ where: { id: order.id } });
    const stored = `${row?.failureReason} ${row?.lastError}`;
    expect(stored).not.toContain("+923001234567");
    expect(stored).not.toContain("Jinnah");
    expect(stored).not.toContain("Ayesha");
    expect(stored).not.toContain("ayesha@example.com");
  });

  it("treats a stored draft id that resolves to nothing as permanent", async () => {
    const order = await seedOrder({
      status: "DRAFT_CREATED",
      shopifyDraftOrderId: "gid://shopify/DraftOrder/deleted",
    });
    const shopify = fakeShopify({
      async getDraftOrder() {
        return null;
      },
    });

    const outcome = await submitModule.submitOrder(order.id, context(shopify.port, true));

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.reason).toBe("draft_not_found");
    expect(shopify.calls.complete).toBe(0);
  });

  it("treats a completion that reports no order as permanent", async () => {
    const order = await seedOrder({
      status: "DRAFT_CREATED",
      shopifyDraftOrderId: "gid://shopify/DraftOrder/x",
    });
    const shopify = fakeShopify({
      async completeDraftOrder(id) {
        return { id, name: "#D", status: "COMPLETED", order: null };
      },
    });

    const outcome = await submitModule.submitOrder(order.id, context(shopify.port, true));

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.reason).toBe("complete_without_order");
    // Nothing was marked SYNCED with no order to point at.
    expect((await db.order.findUnique({ where: { id: order.id } }))?.shopifyOrderId).toBeNull();
  });
});

describe("submitOrder: orders that are not this job's problem", () => {
  it("drops a job naming an order that does not exist", async () => {
    const shopify = fakeShopify();
    const outcome = await submitModule.submitOrder("no-such-order", context(shopify.port));
    expect(outcome.kind).toBe("not_found");
    expect(shopify.calls.create).toBe(0);
  });

  it("stands down when another worker holds a live claim", async () => {
    const order = await seedOrder({ status: "SYNCING", claimedAt: new Date() });
    const shopify = fakeShopify();

    const outcome = await submitModule.submitOrder(order.id, context(shopify.port));

    expect(outcome.kind).toBe("held_elsewhere");
    expect(shopify.calls.create).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// recovery
// ---------------------------------------------------------------------------

describe("findOrdersNeedingSubmission", () => {
  it("finds PENDING_SYNC orders older than the grace period", async () => {
    const old = await seedOrder({ createdAt: new Date(Date.now() - 600_000) });
    await seedOrder(); // just created -- its enqueue may still be in flight

    const found = await orderRepo.findOrdersNeedingSubmission(db);

    expect(found.map((o) => o.id)).toEqual([old.id]);
  });

  it("finds DRAFT_CREATED orders too: the process died between phases", async () => {
    const stuck = await seedOrder({
      status: "DRAFT_CREATED",
      shopifyDraftOrderId: "gid://shopify/DraftOrder/stuck",
      createdAt: new Date(Date.now() - 600_000),
    });

    const found = await orderRepo.findOrdersNeedingSubmission(db);
    expect(found.map((o) => o.id)).toContain(stuck.id);
  });

  it("ignores SYNCED, FAILED and freshly claimed orders", async () => {
    const past = new Date(Date.now() - 600_000);
    await seedOrder({ status: "SYNCED", shopifyOrderId: "gid://shopify/Order/1", createdAt: past });
    await seedOrder({ status: "FAILED", createdAt: past });
    await seedOrder({ status: "SYNCING", claimedAt: new Date(), createdAt: past });

    expect(await orderRepo.findOrdersNeedingSubmission(db)).toEqual([]);
  });

  it("serves the longest-waiting customer first", async () => {
    const newer = await seedOrder({ createdAt: new Date(Date.now() - 300_000) });
    const older = await seedOrder({ createdAt: new Date(Date.now() - 900_000) });

    const found = await orderRepo.findOrdersNeedingSubmission(db);
    expect(found.map((o) => o.id)).toEqual([older.id, newer.id]);
  });

  it("bounds the batch", async () => {
    for (let i = 0; i < 5; i += 1) await seedOrder({ createdAt: new Date(Date.now() - 600_000) });
    expect(await orderRepo.findOrdersNeedingSubmission(db, { limit: 2 })).toHaveLength(2);
  });
});

describe("findExpiredClaims", () => {
  it("finds SYNCING orders whose lease has expired, and no others", async () => {
    const dead = await seedOrder({ status: "SYNCING", claimedAt: new Date(Date.now() - 120_000) });
    await seedOrder({ status: "SYNCING", claimedAt: new Date(Date.now() - 5_000) });

    const found = await orderRepo.findExpiredClaims(db);
    expect(found.map((o) => o.id)).toEqual([dead.id]);
  });
});

describe("recoverPendingSubmissions", () => {
  it("re-enqueues a PENDING_SYNC order whose enqueue was lost", async () => {
    const order = await seedOrder({ createdAt: new Date(Date.now() - 600_000) });
    const enqueued: Array<{ orderId: string; replaceExisting?: boolean }> = [];

    const summary = await recoveryModule.recoverPendingSubmissions(db as never, log, {
      enqueue: async (orderId, options) => {
        enqueued.push({ orderId, replaceExisting: options?.replaceExisting });
        return { enqueued: true };
      },
    });

    expect(summary.pendingFound).toBe(1);
    expect(summary.enqueued).toBe(1);
    expect(enqueued).toEqual([{ orderId: order.id, replaceExisting: true }]);
  });

  it("passes replaceExisting, or a job that already failed would block recovery forever", async () => {
    // A fixed job id is deduplicated against COMPLETED and FAILED jobs too. Without
    // replaceExisting the sweep would find the order every five minutes, enqueue
    // nothing, and report success.
    await seedOrder({ createdAt: new Date(Date.now() - 600_000) });
    let sawReplace = false;

    await recoveryModule.recoverPendingSubmissions(db as never, log, {
      enqueue: async (_orderId, options) => {
        sawReplace = options?.replaceExisting === true;
        return { enqueued: true };
      },
    });

    expect(sawReplace).toBe(true);
  });

  it("recovers expired claims as well as un-enqueued orders", async () => {
    await seedOrder({ createdAt: new Date(Date.now() - 600_000) });
    await seedOrder({ status: "SYNCING", claimedAt: new Date(Date.now() - 120_000) });

    const summary = await recoveryModule.recoverPendingSubmissions(db as never, log, {
      enqueue: async () => ({ enqueued: true }),
    });

    expect(summary.pendingFound).toBe(1);
    expect(summary.expiredClaimsFound).toBe(1);
    expect(summary.enqueued).toBe(2);
  });

  it("survives Redis being down, and leaves the orders for the next sweep", async () => {
    const order = await seedOrder({ createdAt: new Date(Date.now() - 600_000) });

    const summary = await recoveryModule.recoverPendingSubmissions(db as never, log, {
      enqueue: async () => {
        throw new Error("redis unavailable");
      },
    });

    expect(summary.enqueueFailed).toBe(1);
    expect(summary.enqueued).toBe(0);
    // Untouched, so the next sweep finds it again.
    expect((await db.order.findUnique({ where: { id: order.id } }))?.status).toBe("PENDING_SYNC");
  });

  it("counts a failed job REPLACEMENT as a failure, not as work done", async () => {
    // The live-run bug. `replaceExisting` removes the retained terminal job before
    // adding an equivalent one; when that removal fails the add is deduplicated
    // against the old job and NOTHING is queued. The old code swallowed the remove
    // error and inferred success from the job id -- so the sweep reported a
    // re-enqueue it had not performed, and the order sat unsubmitted.
    const order = await seedOrder({ createdAt: new Date(Date.now() - 600_000) });

    const summary = await recoveryModule.recoverPendingSubmissions(db as never, log, {
      enqueue: async () => ({ enqueued: true, removeError: "connection is not ready" }),
    });

    expect(summary.enqueueFailed).toBe(1);
    expect(summary.enqueued).toBe(0);
    // Untouched, so the next sweep tries again rather than the order being lost.
    expect((await db.order.findUnique({ where: { id: order.id } }))?.status).toBe("PENDING_SYNC");
  });

  it("counts a genuine deduplication separately from a failure", async () => {
    // A job already waiting is fine: nothing to do, nothing wrong.
    await seedOrder({ createdAt: new Date(Date.now() - 600_000) });

    const summary = await recoveryModule.recoverPendingSubmissions(db as never, log, {
      enqueue: async () => ({ enqueued: false }),
    });

    expect(summary.alreadyQueued).toBe(1);
    expect(summary.enqueueFailed).toBe(0);
    expect(summary.enqueued).toBe(0);
  });

  it("keeps sweeping the rest when one order's replacement fails", async () => {
    const past = new Date(Date.now() - 600_000);
    const failing = await seedOrder({ createdAt: past });
    await seedOrder({ createdAt: past });
    await seedOrder({ createdAt: past });

    const summary = await recoveryModule.recoverPendingSubmissions(db as never, log, {
      enqueue: async (orderId) =>
        orderId === failing.id
          ? { enqueued: true, removeError: "connection is not ready" }
          : { enqueued: true },
    });

    expect(summary.pendingFound).toBe(3);
    expect(summary.enqueueFailed).toBe(1);
    expect(summary.enqueued).toBe(2);
  });

  it("does nothing when there is nothing to recover", async () => {
    let called = false;
    const summary = await recoveryModule.recoverPendingSubmissions(db as never, log, {
      enqueue: async () => {
        called = true;
        return { enqueued: true };
      },
    });

    expect(summary).toEqual({
      pendingFound: 0,
      expiredClaimsFound: 0,
      enqueued: 0,
      alreadyQueued: 0,
      enqueueFailed: 0,
    });
    expect(called).toBe(false);
  });

  it("recovers an order end to end: lost enqueue, sweep, submission", async () => {
    // The whole point of the recovery path, in one test.
    const order = await seedOrder({ createdAt: new Date(Date.now() - 600_000) });
    const shopify = fakeShopify();
    const queued: string[] = [];

    await recoveryModule.recoverPendingSubmissions(db as never, log, {
      enqueue: async (orderId) => {
        queued.push(orderId);
        return { enqueued: true };
      },
    });

    expect(queued).toEqual([order.id]);

    // The sweep enqueues; the worker submits.
    const outcome = await submitModule.submitOrder(queued[0], context(shopify.port));

    expect(outcome.kind).toBe("synced");
    expect((await db.order.findUnique({ where: { id: order.id } }))?.status).toBe("SYNCED");
  });
});

// ---------------------------------------------------------------------------
// job history
// ---------------------------------------------------------------------------

/**
 * A BullMQ job, reduced to the four fields the processor reads.
 *
 * Constructing a real Job would need a live queue and a Redis round trip to
 * assert something that is entirely about what the processor writes to MySQL.
 */
function fakeJob(
  orderId: string,
  options: { id?: string; attemptsMade?: number; attempts?: number; timestamp?: number } = {},
) {
  return {
    id: options.id ?? `order--${orderId}`,
    data: { orderId },
    attemptsMade: options.attemptsMade ?? 0,
    opts: { attempts: options.attempts ?? 5 },
    // BullMQ's enqueue time. It is what distinguishes one job instance from its
    // replacement under the same fixed job id.
    timestamp: options.timestamp ?? 1_000_000,
  } as never;
}

describe("processSubmitOrder: JobLog", () => {
  it("records the attempt with the order's status either side of it", async () => {
    const order = await seedOrder();
    const shopify = fakeShopify();

    await processor.processSubmitOrder(fakeJob(order.id), shopify.port);

    const logs = await db.jobLog.findMany({ where: { entityId: order.id } });
    expect(logs).toHaveLength(1);

    const row = logs[0];
    expect(row.queueName).toBe("submit-order");
    expect(row.jobName).toBe("submit-order");
    expect(row.bullJobId).toBe(`order--${order.id}`);
    expect(row.attempt).toBe(1);
    expect(row.entityType).toBe("ORDER");
    expect(row.entityId).toBe(order.id);
    expect(row.status).toBe("SUCCEEDED");
    // The transition, which is the thing a reader of job history actually wants:
    // the order row itself has moved on by the time anyone looks.
    expect(row.startStatus).toBe("PENDING_SYNC");
    expect(row.endStatus).toBe("SYNCED");
    expect(row.durationMs).not.toBeNull();
    expect(row.durationMs!).toBeGreaterThanOrEqual(0);
    expect(row.finishedAt).not.toBeNull();
    // Nothing was retried, so there is no retryable verdict to record.
    expect(row.retryable).toBeNull();
    expect(row.errorClass).toBeNull();
  });

  it("records a resumed attempt as DRAFT_CREATED -> SYNCED", async () => {
    const order = await seedOrder({
      status: "DRAFT_CREATED",
      shopifyDraftOrderId: "gid://shopify/DraftOrder/resumed",
    });

    await processor.processSubmitOrder(fakeJob(order.id), fakeShopify().port);

    const row = await db.jobLog.findFirst({ where: { entityId: order.id } });
    expect(row?.startStatus).toBe("DRAFT_CREATED");
    expect(row?.endStatus).toBe("SYNCED");
  });

  it("marks a retryable failure retryable, and says where the order was left", async () => {
    const order = await seedOrder();
    const shopify = fakeShopify({
      async createDraftOrder() {
        throw new ShopifyError("socket hang up", { kind: "transport", retryable: true });
      },
    });

    await expect(
      processor.processSubmitOrder(fakeJob(order.id, { attemptsMade: 0, attempts: 5 }), shopify.port),
    ).rejects.toThrow("socket hang up");

    const row = await db.jobLog.findFirst({ where: { entityId: order.id } });
    expect(row?.status).toBe("FAILED");
    expect(row?.retryable).toBe(true);
    expect(row?.startStatus).toBe("PENDING_SYNC");
    // Released for the retry, not left looking claimed.
    expect(row?.endStatus).toBe("PENDING_SYNC");
    expect(row?.errorClass).toBe("ShopifyError");
    expect(row?.errorMessage).toContain("socket hang up");
  });

  it("marks a userError NOT retryable", async () => {
    const order = await seedOrder();
    const shopify = fakeShopify({
      async createDraftOrder() {
        throw new submitModule.PermanentSubmissionError(
          "draft_create_user_error",
          "lineItems.0.variantId: Variant does not exist",
        );
      },
    });

    // Returns rather than throws: a permanent failure is a finished job, and
    // throwing would ask BullMQ to retry what cannot succeed.
    const result = await processor.processSubmitOrder(fakeJob(order.id), shopify.port);
    expect(result.outcome).toBe("failed");

    const row = await db.jobLog.findFirst({ where: { entityId: order.id } });
    expect(row?.status).toBe("SUCCEEDED");
    expect(row?.retryable).toBe(false);
    expect(row?.startStatus).toBe("PENDING_SYNC");
    expect(row?.endStatus).toBe("FAILED");
  });

  it("writes one row per attempt, keeping the whole story", async () => {
    const order = await seedOrder();
    let calls = 0;
    const shopify = fakeShopify({
      async createDraftOrder() {
        calls += 1;
        if (calls === 1) throw new ShopifyError("blip", { kind: "transport", retryable: true });
        return { id: "gid://shopify/DraftOrder/eventual", name: "#D", status: "OPEN", order: null };
      },
    });

    await expect(
      processor.processSubmitOrder(fakeJob(order.id, { attemptsMade: 0 }), shopify.port),
    ).rejects.toThrow("blip");
    await processor.processSubmitOrder(fakeJob(order.id, { attemptsMade: 1 }), shopify.port);

    const logs = await db.jobLog.findMany({
      where: { entityId: order.id },
      orderBy: { attempt: "asc" },
    });

    // "Attempt 2 succeeded after attempt 1 failed" is the interesting story; one
    // mutable row would erase it.
    expect(logs.map((l) => [l.attempt, l.status, l.retryable])).toEqual([
      [1, "FAILED", true],
      [2, "SUCCEEDED", null],
    ]);
    expect(logs[1].startStatus).toBe("PENDING_SYNC");
    expect(logs[1].endStatus).toBe("SYNCED");
  });

  it("records BOTH attempt 1s when a job is replaced under the same job id", async () => {
    // D11. submit-order uses a FIXED job id per order, reused on every
    // re-enqueue, so a replacement job restarts at attempt 1. Under the old
    // `(bullJobId, attempt)` uniqueness the second row collided, `startJobLog`
    // warned and returned a null id, and the finish became a no-op -- which is how
    // the WINNING attempt of the first real COD order ended up with no history at
    // all. `jobInstance` is what keeps both rows.
    const order = await seedOrder();
    const jobId = `order--${order.id}`;

    // Instance A: fails, leaving the order claimable.
    const failing = fakeShopify({
      async createDraftOrder() {
        throw new submitModule.PermanentSubmissionError("draft_create_user_error", "refused once");
      },
    });
    await processor.processSubmitOrder(
      fakeJob(order.id, { id: jobId, attemptsMade: 0, timestamp: 1_111_111 }),
      failing.port,
    );

    // Instance B: the replacement job. Same job id, same attempt number, later
    // enqueue time -- exactly the shape that used to be dropped.
    await processor.processSubmitOrder(
      fakeJob(order.id, { id: jobId, attemptsMade: 0, timestamp: 2_222_222 }),
      fakeShopify().port,
    );

    const logs = await db.jobLog.findMany({
      where: { entityId: order.id },
      orderBy: { startedAt: "asc" },
    });

    expect(logs).toHaveLength(2);
    expect(logs.every((row) => row.bullJobId === jobId)).toBe(true);
    expect(logs.every((row) => row.attempt === 1)).toBe(true);
    expect(logs.map((row) => row.jobInstance)).toEqual(["1111111", "2222222"]);

    // And the story reads correctly: the replacement is the one that succeeded.
    expect(logs[0].endStatus).toBe("FAILED");
    expect(logs[1].startStatus).toBe("FAILED");
    expect(logs[1].endStatus).toBe("SYNCED");
    expect((await db.order.findUnique({ where: { id: order.id } }))?.status).toBe("SYNCED");
  });

  it("still writes one row per attempt within a single job instance", async () => {
    // The original guarantee must survive: re-logging the same attempt of the same
    // instance is still idempotent, so a stalled-job re-delivery cannot double-log.
    const order = await seedOrder();
    const jobId = `order--${order.id}`;
    const shopify = fakeShopify({
      async createDraftOrder() {
        throw new ShopifyError("blip", { kind: "transport", retryable: true });
      },
    });

    for (const attemptsMade of [0, 1, 2]) {
      await expect(
        processor.processSubmitOrder(
          fakeJob(order.id, { id: jobId, attemptsMade, timestamp: 3_333_333 }),
          shopify.port,
        ),
      ).rejects.toThrow("blip");
    }

    const logs = await db.jobLog.findMany({
      where: { entityId: order.id },
      orderBy: { attempt: "asc" },
    });
    expect(logs.map((row) => row.attempt)).toEqual([1, 2, 3]);
    expect(new Set(logs.map((row) => row.jobInstance))).toEqual(new Set(["3333333"]));
  });

  it("records the job instance on a first-time attempt", async () => {
    const order = await seedOrder();

    await processor.processSubmitOrder(
      fakeJob(order.id, { timestamp: 4_444_444 }),
      fakeShopify().port,
    );

    const row = await db.jobLog.findFirst({ where: { entityId: order.id } });
    expect(row?.jobInstance).toBe("4444444");
  });

  it("records the SYNCED no-op without inventing a transition", async () => {
    const order = await seedOrder({ status: "SYNCED", shopifyOrderId: "gid://shopify/Order/1" });

    const result = await processor.processSubmitOrder(fakeJob(order.id), fakeShopify().port);

    expect(result.outcome).toBe("already_synced");
    const row = await db.jobLog.findFirst({ where: { entityId: order.id } });
    expect(row?.startStatus).toBe("SYNCED");
    expect(row?.endStatus).toBe("SYNCED");
    expect(row?.status).toBe("SUCCEEDED");
  });

  it("logs no customer data anywhere in the row", async () => {
    const order = await seedOrder();
    const shopify = fakeShopify({
      async createDraftOrder() {
        throw new submitModule.PermanentSubmissionError("draft_create_user_error", "phone: is invalid");
      },
    });

    await processor.processSubmitOrder(fakeJob(order.id), shopify.port);

    const row = await db.jobLog.findFirst({ where: { entityId: order.id } });
    const serialised = JSON.stringify(row);
    for (const pii of ["+923001234567", "Ayesha", "Jinnah", "ayesha@example.com", "Lahore"]) {
      expect(serialised).not.toContain(pii);
    }
    // The order id is the identifier that makes the row useful, and it is not PII.
    expect(serialised).toContain(order.id);
  });
});
