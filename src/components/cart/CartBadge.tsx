"use client";

/**
 * The navbar cart link and its item count.
 *
 * Client-side because the count comes from localStorage, which the server cannot
 * see. It renders no number until the provider has read storage: rendering 0
 * first and correcting it a tick later is a visible flicker on every page load,
 * and on the server render it would be a hydration mismatch.
 */
import Link from "next/link";

import { useCart } from "./CartProvider";

export function CartBadge() {
  const { count, ready } = useCart();

  return (
    <Link className="nav-link storefront-cart-link" href="/cart">
      Cart
      {ready && count > 0 ? (
        <span className="badge badge-primary ml-1" aria-label={`${count} items in cart`}>
          {count}
        </span>
      ) : null}
    </Link>
  );
}
