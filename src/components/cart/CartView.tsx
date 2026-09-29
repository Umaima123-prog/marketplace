"use client";

/**
 * The cart page.
 *
 * Every number on it comes from the server. The rows are the local cart's ids and
 * quantities; the titles, images, prices and the subtotal are whatever
 * `/api/cart/hydrate` just read out of MySQL. Change a quantity and the subtotal
 * is recomputed by the server, not here -- there is no money arithmetic in this
 * file, deliberately.
 *
 * Lines the catalog can no longer sell are shown rather than silently dropped: a
 * shopper whose item vanished with no explanation assumes the site is broken.
 * They are struck through, labelled with the reason, and they block checkout
 * until removed.
 */
import Link from "next/link";

import { describeProblem } from "@/src/lib/cart/cart-view";
import { formatMoney } from "@/src/lib/money";
import { MAX_LINE_QUANTITY } from "@/src/lib/cart/cart-state";

import { useCart } from "./CartProvider";
import { useHydratedCart } from "./useHydratedCart";

export function CartView() {
  const { cart, ready, update, remove } = useCart();
  const { hydrated, status } = useHydratedCart(cart, ready);

  if (!ready || (status === "loading" && hydrated.lines.length === 0)) {
    return <p className="text-muted">Loading your cart…</p>;
  }

  if (status === "error") {
    return (
      <div className="alert alert-danger">
        The cart could not be loaded. Reload the page to try again.
      </div>
    );
  }

  if (cart.lines.length === 0) {
    return (
      <div className="card">
        <div className="card-body text-center">
          <p className="mb-3">Your cart is empty.</p>
          <Link className="btn btn-primary" href="/">
            Browse the catalog
          </Link>
        </div>
      </div>
    );
  }

  const blocked = hydrated.lines.filter((line) => line.problem !== null);

  return (
    <div className="row">
      <div className="col-lg-8">
        <div className="card">
          <div className="card-body p-0">
            <table className="table table-hover mb-0">
              <thead>
                <tr>
                  <th colSpan={2}>Item</th>
                  <th className="text-right">Price</th>
                  <th style={{ width: "8rem" }}>Quantity</th>
                  <th className="text-right">Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {hydrated.lines.map((line) => (
                  <tr key={line.variantId} className={line.problem ? "table-warning" : undefined}>
                    <td style={{ width: "4.5rem" }}>
                      {line.imageUrl ? (
                        /* eslint-disable-next-line @next/next/no-img-element -- remote Shopify CDN, see ProductCard */
                        <img
                          src={line.imageUrl}
                          alt=""
                          className="rounded"
                          style={{ width: "3.5rem", height: "3.5rem", objectFit: "cover" }}
                        />
                      ) : null}
                    </td>
                    <td>
                      {line.productHandle ? (
                        <Link href={`/products/${line.productHandle}`}>{line.productTitle}</Link>
                      ) : (
                        <span>{line.productTitle}</span>
                      )}
                      {line.variantTitle ? (
                        <div className="text-muted small">{line.variantTitle}</div>
                      ) : null}
                      {line.sku ? <div className="text-muted small">SKU: {line.sku}</div> : null}
                      {line.problem ? (
                        <div className="text-danger small font-weight-bold">
                          {describeProblem(line.problem)}
                        </div>
                      ) : null}
                    </td>
                    <td className="text-right align-middle">
                      {line.available ? formatMoney(line.unitPrice, line.currencyCode) : "—"}
                    </td>
                    <td className="align-middle">
                      <input
                        type="number"
                        className="form-control form-control-sm"
                        min={1}
                        max={MAX_LINE_QUANTITY}
                        step={1}
                        value={line.quantity}
                        aria-label={`Quantity for ${line.productTitle}`}
                        onChange={(event) => {
                          const next = Number.parseInt(event.target.value, 10);
                          // NaN (an emptied field) leaves the line alone rather
                          // than removing it mid-edit.
                          if (Number.isNaN(next)) return;
                          update(line.variantId, next);
                        }}
                      />
                    </td>
                    <td className="text-right align-middle">
                      {line.available ? formatMoney(line.lineTotal, line.currencyCode) : "—"}
                    </td>
                    <td className="align-middle text-right">
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        onClick={() => remove(line.variantId)}
                        aria-label={`Remove ${line.productTitle}`}
                      >
                        Remove
                      </button>
                    </td>
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
              <dt className="col-7">Items</dt>
              <dd className="col-5 text-right">{hydrated.itemCount}</dd>

              <dt className="col-7">Subtotal</dt>
              <dd className="col-5 text-right">
                {formatMoney(hydrated.subtotal, hydrated.currencyCode)}
              </dd>

              {/* Both fixed at zero for this exercise, and shown rather than
                  hidden so the grand total is not a number with no derivation. */}
              <dt className="col-7 text-muted">Shipping</dt>
              <dd className="col-5 text-right text-muted">Free</dd>

              <dt className="col-7 text-muted">Tax</dt>
              <dd className="col-5 text-right text-muted">
                {formatMoney("0.00", hydrated.currencyCode)}
              </dd>

              <dt className="col-7 font-weight-bold border-top pt-2">Total</dt>
              <dd className="col-5 text-right font-weight-bold border-top pt-2">
                {formatMoney(hydrated.subtotal, hydrated.currencyCode)}
              </dd>
            </dl>
          </div>
          <div className="card-footer">
            {blocked.length > 0 ? (
              <>
                <p className="text-danger small">
                  Remove or adjust the highlighted {blocked.length === 1 ? "item" : "items"} before
                  checking out.
                </p>
                {/* A disabled link is not a thing in HTML, so this is a disabled
                    button that looks like the real one. */}
                <button type="button" className="btn btn-primary btn-block" disabled>
                  Continue to checkout
                </button>
              </>
            ) : (
              <Link
                className={`btn btn-primary btn-block${hydrated.checkoutable ? "" : " disabled"}`}
                href="/checkout"
                aria-disabled={!hydrated.checkoutable}
              >
                Continue to checkout
              </Link>
            )}
            <p className="text-muted small mb-0 mt-2">
              Payment is cash on delivery. Prices are confirmed again when you place the order.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
