/**
 * COD checkout endpoint.
 *
 * Thin by design. Every decision -- validation, the re-read of prices and stock
 * from MySQL, the totals, the idempotency rules, the transaction, the queue
 * handoff -- is in `checkout.service.ts`. This handler translates the result into
 * a status code and nothing else, so there is exactly one implementation of "what
 * is a valid order" and no second copy of it here.
 *
 * It does NOT call Shopify. A COD customer waits for MySQL to commit, not for a
 * third-party API; submission happens later in the worker process
 * (ARCHITECTURE §2, §4.1).
 */
import { NextResponse } from "next/server";

import { logger } from "@/src/lib/logger";
import { placeOrder } from "@/src/server/checkout/checkout.service";
import { enqueueSubmitOrder } from "@/src/lib/queues";

const log = logger.child({ service: "web", route: "POST /api/checkout" });

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const startedAt = Date.now();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // The body is NEVER logged: it is a name, a phone number and a home address
  // (ARCHITECTURE §8). Nothing below logs it either -- the service logs an order
  // id and an item count.
  const result = await placeOrder(body, {
    enqueueSubmit: async (orderId) => {
      await enqueueSubmitOrder(orderId);
    },
  });

  const durationMs = Date.now() - startedAt;

  if (!result.ok) {
    switch (result.code) {
      case "validation_failed":
        return NextResponse.json(
          { error: "validation_failed", fieldErrors: result.fieldErrors },
          { status: 400 },
        );

      case "cart_invalid":
        // 409, not 400: the request was well-formed, but the catalog disagrees
        // with it now. The client re-hydrates the cart and shows what changed.
        return NextResponse.json(
          { error: "cart_invalid", lineErrors: result.lineErrors },
          { status: 409 },
        );

      case "idempotency_conflict":
        return NextResponse.json({ error: "idempotency_conflict" }, { status: 409 });

      case "internal_error":
        return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
  }

  log.info(
    { event: "checkout_completed", replayed: result.order.replayed, durationMs },
    "checkout completed",
  );

  // 200 rather than 201 for a replay: nothing was created the second time.
  return NextResponse.json(
    {
      reference: result.order.reference,
      // The confirmation URL, so the client never has to build one and the
      // unguessable token stays out of the page's own links.
      confirmationUrl: `/orders/${result.order.publicToken}`,
      replayed: result.order.replayed,
    },
    { status: result.order.replayed ? 200 : 201 },
  );
}
