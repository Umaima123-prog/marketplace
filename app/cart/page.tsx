import Link from "next/link";
import type { Metadata } from "next";

import { CartView } from "@/src/components/cart/CartView";
import { StorefrontLayout } from "@/src/components/storefront/StorefrontLayout";

export const metadata: Metadata = { title: "Your cart" };

/**
 * The cart page shell.
 *
 * A server component with no data fetching, because there is nothing for it to
 * fetch: the cart lives in the shopper's browser. `CartView` reads it there and
 * asks the server what those variant ids currently cost.
 *
 * Deliberately NOT a server-rendered cart. A guest cart with no session has no
 * server-side identity, and inventing one (a cookie, a cart row) would be a
 * larger system than this phase needs.
 */
export default function CartPage() {
  return (
    <StorefrontLayout
      title="Your cart"
      subtitle="Cash on delivery"
      breadcrumb={
        <ol className="breadcrumb float-sm-right bg-transparent p-0 mb-0">
          <li className="breadcrumb-item">
            <Link href="/">Catalog</Link>
          </li>
          <li className="breadcrumb-item active">Cart</li>
        </ol>
      }
    >
      <CartView />
    </StorefrontLayout>
  );
}
