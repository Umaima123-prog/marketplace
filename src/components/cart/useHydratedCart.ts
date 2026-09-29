"use client";

/**
 * Turns the local cart (ids and quantities) into the server's view of it.
 *
 * Shared by the cart page and the checkout form so both show the same prices from
 * the same source. Re-runs whenever the cart changes: an edited quantity must
 * produce a new subtotal computed by the server, never one computed here.
 *
 * Nothing in this file does arithmetic on money.
 *
 * `status` is DERIVED from whether the stored response matches the current cart,
 * rather than being a flag some code path has to remember to set. That removes
 * the whole class of bug where a fetch returns and the spinner stays up, and it
 * removes the out-of-order problem too: a response for a superseded cart simply
 * no longer matches.
 */
import { useEffect, useMemo, useState } from "react";

import { EMPTY_HYDRATED_CART, type HydratedCart } from "@/src/lib/cart/cart-view";
import { serializeCart, type CartState } from "@/src/lib/cart/cart-state";

export type HydrationStatus = "loading" | "ready" | "error";

/** One response, and the cart it answers. */
interface Result {
  signature: string;
  /** Null when the request failed. */
  cart: HydratedCart | null;
}

export function useHydratedCart(cart: CartState, enabled: boolean) {
  const signature = useMemo(() => serializeCart(cart), [cart]);
  const [result, setResult] = useState<Result | null>(null);

  const isEmpty = cart.lines.length === 0;

  useEffect(() => {
    // `enabled` is the provider's `ready`. Before localStorage has been read the
    // cart looks empty, and hydrating that would show "your cart is empty" to
    // someone who has items.
    if (!enabled || isEmpty) return;

    const controller = new AbortController();

    // No state is set synchronously here -- the first `setResult` is behind an
    // `await`. React 19 flags a synchronous setState in an effect, and it is right
    // to: it is a second render before the browser has painted the first.
    async function load() {
      try {
        const response = await fetch("/api/cart/hydrate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Only the two fields. Sending anything else would be sending the
          // server data it must not trust anyway.
          body: JSON.stringify({
            lines: cart.lines.map((line) => ({
              variantId: line.variantId,
              quantity: line.quantity,
            })),
          }),
          signal: controller.signal,
        });

        if (!response.ok) throw new Error(`hydrate failed: ${response.status}`);
        const data = (await response.json()) as HydratedCart;
        setResult({ signature, cart: data });
      } catch {
        // An aborted request is a superseded one, not a failure.
        if (controller.signal.aborted) return;
        setResult({ signature, cart: null });
      }
    }

    void load();
    return () => controller.abort();
  }, [cart, enabled, isEmpty, signature]);

  const matched = result?.signature === signature ? result : null;

  const status: HydrationStatus = !enabled
    ? "loading"
    : isEmpty
      ? "ready"
      : matched
        ? matched.cart
          ? "ready"
          : "error"
        : "loading";

  // While a newer request is in flight the previous response is still shown, so
  // the page does not empty itself between keystrokes. `status` says it is stale.
  const hydrated = isEmpty ? EMPTY_HYDRATED_CART : (matched?.cart ?? result?.cart ?? EMPTY_HYDRATED_CART);

  return { hydrated, status };
}
