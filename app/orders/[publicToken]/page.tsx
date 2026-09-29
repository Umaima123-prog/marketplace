import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { StorefrontLayout } from "@/src/components/storefront/StorefrontLayout";
import { formatMoney } from "@/src/lib/money";
import { getOrderByPublicToken } from "@/src/server/checkout/checkout.service";

/** An order's status changes as the worker submits it; never cache this. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Order confirmed" };

/**
 * Order confirmation, addressed by an unguessable token.
 *
 * The URL segment is a 32-byte random token, NOT the order id and not the
 * customer-facing reference. The reference is short and spoken aloud during
 * support calls, so it is guessable by design -- using it here would let anyone
 * walk the order table and read every customer's name and delivery city.
 *
 * The page shows the order's totals and items, the first name, and the city. No
 * phone number, no email, no street address: anyone holding the link can open
 * this, including whoever finds it in a shared browser's history.
 *
 * Totals come from the Order row, which is what the server computed and what the
 * courier collects. Nothing here recomputes them.
 */
export default async function OrderConfirmationPage({
  params,
}: {
  // Next 16: params is async and must be awaited.
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const order = await getOrderByPublicToken(publicToken);

  // One outcome for "no such order" and "not your order": a 404 either way, so
  // the page cannot be used to test whether a token exists.
  if (!order) notFound();

  return (
    <StorefrontLayout
      title="Order confirmed"
      subtitle={`Reference ${order.reference}`}
      breadcrumb={
        <ol className="breadcrumb float-sm-right bg-transparent p-0 mb-0">
          <li className="breadcrumb-item">
            <Link href="/">Catalog</Link>
          </li>
          <li className="breadcrumb-item active">Order</li>
        </ol>
      }
    >
      <div className="row">
        <div className="col-lg-8">
          <div className="callout callout-success">
            <h5 className="mb-1">Thank you, {order.customerFirstName}.</h5>
            <p className="mb-0">
              Your order is confirmed. Pay{" "}
              <strong>{formatMoney(order.grandTotal, order.currencyCode)}</strong> in cash when it is
              delivered to {order.city}, {order.countryCode}.
            </p>
          </div>

          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Items</h3>
            </div>
            <div className="card-body p-0">
              <table className="table mb-0">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="text-right">Unit price</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {order.items.map((item, index) => (
                    // The order is immutable, so index is a stable key here.
                    <tr key={index}>
                      <td>
                        {item.productTitle}
                        {item.variantTitle ? (
                          <div className="text-muted small">{item.variantTitle}</div>
                        ) : null}
                        {item.sku ? <div className="text-muted small">SKU: {item.sku}</div> : null}
                      </td>
                      <td className="text-right">{formatMoney(item.unitPrice, order.currencyCode)}</td>
                      <td className="text-right">{item.quantity}</td>
                      <td className="text-right">{formatMoney(item.lineTotal, order.currencyCode)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="col-lg-4">
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Summary</h3>
            </div>
            <div className="card-body">
              <dl className="row mb-0">
                <dt className="col-7">Reference</dt>
                <dd className="col-5 text-right">{order.reference}</dd>

                <dt className="col-7">Placed</dt>
                <dd className="col-5 text-right">
                  {order.placedAt.toISOString().slice(0, 10)}
                </dd>

                <dt className="col-7">Items</dt>
                <dd className="col-5 text-right">{order.itemCount}</dd>

                <dt className="col-7">Subtotal</dt>
                <dd className="col-5 text-right">
                  {formatMoney(order.subtotal, order.currencyCode)}
                </dd>

                <dt className="col-7 text-muted">Shipping</dt>
                <dd className="col-5 text-right text-muted">
                  {formatMoney(order.shippingTotal, order.currencyCode)}
                </dd>

                <dt className="col-7 text-muted">Tax</dt>
                <dd className="col-5 text-right text-muted">
                  {formatMoney(order.taxTotal, order.currencyCode)}
                </dd>

                <dt className="col-7 font-weight-bold border-top pt-2">Due on delivery</dt>
                <dd className="col-5 text-right font-weight-bold border-top pt-2">
                  {formatMoney(order.grandTotal, order.currencyCode)}
                </dd>
              </dl>
            </div>
            <div className="card-footer">
              <p className="mb-1">
                Payment method: <strong>Cash on delivery</strong>
              </p>
              {/*
                The status is the LOCAL one. PENDING_SYNC means MySQL has the
                order and Shopify does not have it yet -- which is the customer's
                order being real, not their order being incomplete. Worded so a
                shopper is not asked to care about our sync state.
              */}
              <p className="text-muted small mb-0">
                {order.status === "PENDING_SYNC"
                  ? "We have your order and are preparing it for dispatch."
                  : "Your order is being processed."}
              </p>
            </div>
          </div>

          <Link className="btn btn-outline-primary btn-block" href="/">
            Continue shopping
          </Link>
        </div>
      </div>
    </StorefrontLayout>
  );
}
