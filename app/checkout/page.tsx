import Link from "next/link";
import type { Metadata } from "next";

import { CheckoutForm } from "@/src/components/checkout/CheckoutForm";
import { StorefrontLayout } from "@/src/components/storefront/StorefrontLayout";

export const metadata: Metadata = { title: "Checkout" };

/**
 * The checkout shell.
 *
 * Like the cart page, it fetches nothing: the cart is in the browser, and the
 * form asks the server for prices and then asks it to place the order. The order
 * itself is created by `POST /api/checkout`, which is the only place that writes.
 */
export default function CheckoutPage() {
  return (
    <StorefrontLayout
      title="Checkout"
      subtitle="Cash on delivery"
      breadcrumb={
        <ol className="breadcrumb float-sm-right bg-transparent p-0 mb-0">
          <li className="breadcrumb-item">
            <Link href="/">Catalog</Link>
          </li>
          <li className="breadcrumb-item">
            <Link href="/cart">Cart</Link>
          </li>
          <li className="breadcrumb-item active">Checkout</li>
        </ol>
      }
    >
      <CheckoutForm />
    </StorefrontLayout>
  );
}
