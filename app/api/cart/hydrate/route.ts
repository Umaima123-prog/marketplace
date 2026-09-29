/**
 * Cart hydration endpoint.
 *
 * The browser sends the only two things it is allowed to know -- variant ids and
 * quantities -- and gets back the current title, option, image, price and
 * availability for each, read from MySQL. This is the mechanism that lets the
 * cart live in localStorage without letting the browser decide what anything
 * costs.
 *
 * A read, not a decision: it never creates an order and never enqueues anything.
 * Checkout re-reads the same rows for itself (`POST /api/checkout`) rather than
 * trusting this response, because between the two requests the catalog can change
 * and a shopper can edit whatever was sent back.
 */
import { NextResponse } from "next/server";

import { z } from "zod";

import { MAX_CART_LINES } from "@/src/lib/cart/cart-state";
import { logger } from "@/src/lib/logger";
import { cartLineSchema } from "@/src/server/checkout/checkout.schema";
import { EMPTY_HYDRATED_CART, hydrateCart } from "@/src/server/cart/cart.service";

const log = logger.child({ service: "web", route: "POST /api/cart/hydrate" });

/** Prices and stock change; a cached cart is a wrong cart. */
export const dynamic = "force-dynamic";

const requestSchema = z
  .object({
    // The same line schema the checkout uses, so a cart the cart page accepts
    // cannot be one the checkout rejects for a different reason.
    lines: z.array(cartLineSchema).max(MAX_CART_LINES),
  })
  .strict();

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    // A malformed cart is a client bug or a tampered localStorage, not something
    // to guess at. The count is logged; the contents are not.
    log.info({ event: "cart_hydrate_invalid", issues: parsed.error.issues.length }, "rejected cart");
    return NextResponse.json({ error: "invalid cart" }, { status: 400 });
  }

  if (parsed.data.lines.length === 0) {
    return NextResponse.json(EMPTY_HYDRATED_CART, { status: 200 });
  }

  try {
    const cart = await hydrateCart(parsed.data.lines);

    log.info(
      {
        event: "cart_hydrated",
        lineCount: cart.lines.length,
        itemCount: cart.itemCount,
        checkoutable: cart.checkoutable,
      },
      "cart hydrated",
    );

    return NextResponse.json(cart, { status: 200 });
  } catch (error) {
    log.error(
      { event: "cart_hydrate_failed", errorClass: error instanceof Error ? error.name : typeof error },
      "could not hydrate the cart",
    );
    return NextResponse.json({ error: "cart unavailable" }, { status: 503 });
  }
}
