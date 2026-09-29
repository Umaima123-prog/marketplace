import "server-only";

/**
 * Checkout. The only place a local order is created.
 *
 * The rule the whole file exists to enforce: **the browser is never trusted for
 * price, stock, or whether a product may be sold.** It supplies variant ids,
 * quantities and contact details. Everything else is re-read from MySQL here,
 * immediately before the write, and the totals are computed from those rows.
 *
 * Order of operations (ARCHITECTURE 4.1):
 *   1. validate input                  -- strict schema, unknown keys rejected
 *   2. fingerprint the request         -- binds the idempotency key to it
 *   3. idempotency lookup              -- replay wins, mismatch is refused
 *   4. re-read variants from MySQL     -- active? in stock? what price?
 *   5. compute totals with Decimal     -- shipping 0, tax 0, grand = subtotal
 *   6. ONE transaction: Order + items  -- status PENDING_SYNC
 *   7. AFTER commit: enqueue           -- never inside, never before
 *
 * Shopify is not called here and must never be: the HTTP request returns as soon
 * as MySQL has the order.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@/src/generated/prisma";
import { prisma as defaultPrisma, isUniqueConstraintError } from "@/src/lib/prisma";
import { logger } from "@/src/lib/logger";
import { normalizeMoney } from "@/src/lib/money";
import { CART_VARIANT_SELECT, evaluateLine, type LineProblem } from "@/src/server/cart/cart.service";

import { checkoutSchema, formatIssues, type CheckoutInput } from "./checkout.schema";
import { computeRequestFingerprint } from "./fingerprint";

const log = logger.child({ service: "checkout" });

/**
 * The cart's select plus the two GIDs an OrderItem snapshots.
 *
 * Built from `CART_VARIANT_SELECT` rather than written out again so the cart page
 * and the checkout can never drift into reading different columns and reaching
 * different conclusions about the same variant.
 */
const CHECKOUT_VARIANT_SELECT = {
  ...CART_VARIANT_SELECT,
  shopifyVariantId: true,
  product: {
    select: { ...CART_VARIANT_SELECT.product.select, shopifyProductId: true },
  },
} satisfies Prisma.ProductVariantSelect;

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

export interface PlacedOrder {
  reference: string;
  publicToken: string;
  /** True when an existing order was returned instead of a new one. */
  replayed: boolean;
}

export type CheckoutResult =
  | { ok: true; order: PlacedOrder }
  | { ok: false; code: "validation_failed"; fieldErrors: Record<string, string> }
  | { ok: false; code: "cart_invalid"; lineErrors: Array<{ variantId: string; problem: LineProblem }> }
  | { ok: false; code: "idempotency_conflict" }
  | { ok: false; code: "internal_error" };

/**
 * Enqueueing is injected so the transaction boundary can be tested without
 * Redis, and so a failure to enqueue is visibly a separate step from the write.
 */
export type SubmitEnqueuer = (orderId: string) => Promise<void>;

export interface CheckoutDeps {
  prisma?: PrismaClient;
  enqueueSubmit?: SubmitEnqueuer;
}

// ---------------------------------------------------------------------------
// identifiers
// ---------------------------------------------------------------------------

/** Customer-facing, short, unambiguous: no 0/O or 1/I. */
function generateReference(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(10);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `COD-${out}`;
}

/**
 * The confirmation URL's secret. 32 random bytes, not the order id: an
 * enumerable order URL would expose every customer's order to anyone who can
 * count (ARCHITECTURE 8).
 */
function generatePublicToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Ties this order to at most one Shopify draft, used by the submit worker. */
function generateSubmissionKey(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// checkout
// ---------------------------------------------------------------------------

export async function placeOrder(raw: unknown, deps: CheckoutDeps = {}): Promise<CheckoutResult> {
  const prisma = deps.prisma ?? defaultPrisma;

  // 1. Validate. Unknown keys -- including any attempt to send a price -- fail
  //    here rather than being silently stripped.
  const parsed = checkoutSchema.safeParse(raw);
  if (!parsed.success) {
    log.info({ event: "checkout_validation_failed", issues: parsed.error.issues.length }, "checkout rejected");
    return { ok: false, code: "validation_failed", fieldErrors: formatIssues(parsed.error) };
  }
  const input: CheckoutInput = parsed.data;

  // 2/3. Idempotency. The fingerprint is checked BEFORE the stored order is
  //      returned: a matching key with a different request is a conflict, not a
  //      replay, and must never hand back someone else's order.
  const fingerprint = computeRequestFingerprint(input);

  const existing = await prisma.order.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { reference: true, publicToken: true, requestFingerprint: true },
  });

  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      log.warn({ event: "idempotency_conflict" }, "idempotency key reused with a different request");
      return { ok: false, code: "idempotency_conflict" };
    }
    log.info({ event: "checkout_replayed" }, "returning the existing order for this idempotency key");
    return {
      ok: true,
      order: { reference: existing.reference, publicToken: existing.publicToken, replayed: true },
    };
  }

  // 4. Re-read every variant from MySQL. Nothing the browser sent about these
  //    products is used beyond the id and the quantity.
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: input.items.map((item) => item.variantId) } },
    select: CHECKOUT_VARIANT_SELECT,
  });
  const byId = new Map(variants.map((variant) => [variant.id, variant]));

  const lineErrors: Array<{ variantId: string; problem: LineProblem }> = [];
  for (const item of input.items) {
    const problem = evaluateLine(byId.get(item.variantId), item.quantity);
    if (problem) lineErrors.push({ variantId: item.variantId, problem });
  }

  if (lineErrors.length > 0) {
    log.info(
      { event: "checkout_cart_invalid", lines: lineErrors.length, itemCount: input.items.length },
      "checkout blocked by invalid cart lines",
    );
    return { ok: false, code: "cart_invalid", lineErrors };
  }

  // 5. Totals, computed here from the rows just read. Decimal throughout: the
  //    stored number is cash a courier collects.
  let subtotal = new Prisma.Decimal(0);
  const orderItems = input.items.map((item) => {
    // Non-null: evaluateLine already rejected anything missing.
    const variant = byId.get(item.variantId)!;
    const lineTotal = variant.price.mul(item.quantity);
    subtotal = subtotal.add(lineTotal);

    return {
      variantId: variant.id,
      shopifyVariantId: variant.shopifyVariantId,
      shopifyProductId: variant.product.shopifyProductId,
      // Snapshots: the order must still read correctly after the catalog moves
      // on, and OrderItem is financial history, not a view of the catalog.
      productTitle: variant.product.title,
      variantTitle: variant.title,
      sku: variant.sku,
      unitPrice: variant.price,
      quantity: item.quantity,
      lineTotal,
    };
  });

  const shippingTotal = new Prisma.Decimal(0);
  const taxTotal = new Prisma.Decimal(0);
  const grandTotal = subtotal.add(shippingTotal).add(taxTotal);
  const currencyCode = byId.get(input.items[0].variantId)!.currencyCode;

  // 6. One transaction. An Order without its items is an order nobody can
  //    fulfil, and a set of items without an order is unreachable rows.
  const reference = generateReference();
  const publicToken = generatePublicToken();
  const submissionKey = generateSubmissionKey();

  let orderId: string;
  let created: { id: string; reference: string; publicToken: string };

  try {
    created = await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          reference,
          publicToken,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          submissionKey,
          status: "PENDING_SYNC",
          paymentMethod: "COD",
          currencyCode,
          subtotal,
          shippingTotal,
          taxTotal,
          grandTotal,
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          customerEmail: input.customerEmail ?? null,
          addressLine1: input.addressLine1,
          addressLine2: input.addressLine2 ?? null,
          city: input.city,
          province: input.province ?? null,
          postalCode: input.postalCode ?? null,
          countryCode: input.countryCode,
          customerNote: input.customerNote ?? null,
          items: { create: orderItems },
        },
        select: { id: true, reference: true, publicToken: true },
      });
      return order;
    });
    orderId = created.id;
  } catch (error) {
    // The unique index on idempotencyKey is the FINAL protection against two
    // simultaneous submissions of the same key -- the lookup above narrows the
    // window, the constraint closes it. The loser re-reads and replays.
    if (isUniqueConstraintError(error)) {
      const winner = await prisma.order.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { reference: true, publicToken: true, requestFingerprint: true },
      });

      if (winner && winner.requestFingerprint === fingerprint) {
        log.info({ event: "checkout_race_replayed" }, "lost an idempotency race; returning the winner");
        return {
          ok: true,
          order: { reference: winner.reference, publicToken: winner.publicToken, replayed: true },
        };
      }
      return { ok: false, code: "idempotency_conflict" };
    }

    log.error(
      { event: "checkout_failed", errorClass: error instanceof Error ? error.name : typeof error },
      "could not create the order",
    );
    return { ok: false, code: "internal_error" };
  }

  log.info(
    {
      event: "order_created",
      orderId,
      itemCount: orderItems.length,
      status: "PENDING_SYNC",
      // No name, phone, email or address: ARCHITECTURE 8 forbids it, and an
      // order id is enough to find the row.
    },
    "order created",
  );

  // 7. Enqueue AFTER the commit. Enqueuing inside the transaction would publish
  //    a job for a row a rollback then removes.
  if (deps.enqueueSubmit) {
    try {
      await deps.enqueueSubmit(orderId);
      log.info({ event: "submit_enqueued", orderId }, "submit-order job enqueued");
    } catch (error) {
      // Deliberately NOT a failure for the customer. The order is committed and
      // PENDING_SYNC, which is the outbox: the reconcile sweeper re-enqueues
      // anything left in that state past a grace interval, and `jobId = orderId`
      // means the sweeper and this call cannot produce two jobs. Failing the
      // request here would invite a retry that creates a second order.
      log.error(
        {
          event: "submit_enqueue_failed",
          orderId,
          errorClass: error instanceof Error ? error.name : typeof error,
        },
        "order committed but could not be enqueued; the sweeper will recover it",
      );
    }
  }

  return {
    ok: true,
    order: { reference: created.reference, publicToken: created.publicToken, replayed: false },
  };
}

// ---------------------------------------------------------------------------
// confirmation
// ---------------------------------------------------------------------------

export interface OrderConfirmationView {
  reference: string;
  status: string;
  placedAt: Date;
  currencyCode: string;
  subtotal: string;
  shippingTotal: string;
  taxTotal: string;
  grandTotal: string;
  itemCount: number;
  items: Array<{
    productTitle: string;
    variantTitle: string;
    sku: string | null;
    unitPrice: string;
    quantity: number;
    lineTotal: string;
  }>;
  /** First name only -- enough to confirm the order is theirs, no more. */
  customerFirstName: string;
  city: string;
  countryCode: string;
}

/**
 * Looked up by the unguessable token, never by id or reference.
 *
 * Returns no phone, no email, no street address: a confirmation page is
 * reachable by anyone holding the link, so it shows only what is needed to
 * recognise the order.
 */
export async function getOrderByPublicToken(
  publicToken: string,
  deps: CheckoutDeps = {},
): Promise<OrderConfirmationView | null> {
  const prisma = deps.prisma ?? defaultPrisma;
  if (typeof publicToken !== "string" || publicToken.length < 16 || publicToken.length > 64) return null;

  const order = await prisma.order.findUnique({
    where: { publicToken },
    select: {
      reference: true,
      status: true,
      createdAt: true,
      currencyCode: true,
      subtotal: true,
      shippingTotal: true,
      taxTotal: true,
      grandTotal: true,
      customerName: true,
      city: true,
      countryCode: true,
      items: {
        select: {
          productTitle: true,
          variantTitle: true,
          sku: true,
          unitPrice: true,
          quantity: true,
          lineTotal: true,
        },
      },
    },
  });

  if (!order) return null;

  return {
    reference: order.reference,
    status: order.status,
    placedAt: order.createdAt,
    currencyCode: order.currencyCode,
    subtotal: normalizeMoney(order.subtotal.toString()),
    shippingTotal: normalizeMoney(order.shippingTotal.toString()),
    taxTotal: normalizeMoney(order.taxTotal.toString()),
    grandTotal: normalizeMoney(order.grandTotal.toString()),
    itemCount: order.items.reduce((total, item) => total + item.quantity, 0),
    items: order.items.map((item) => ({
      productTitle: item.productTitle,
      variantTitle: item.variantTitle,
      sku: item.sku,
      unitPrice: normalizeMoney(item.unitPrice.toString()),
      quantity: item.quantity,
      lineTotal: normalizeMoney(item.lineTotal.toString()),
    })),
    customerFirstName: order.customerName.trim().split(/\s+/)[0] ?? "",
    city: order.city,
    countryCode: order.countryCode,
  };
}
