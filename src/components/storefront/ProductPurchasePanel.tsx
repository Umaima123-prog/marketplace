"use client";

import { useState } from "react";
import Link from "next/link";

import { useCart } from "@/src/components/cart/CartProvider";
import { MAX_LINE_QUANTITY } from "@/src/lib/cart/cart-state";
import { formatMoney } from "@/src/lib/money";
import type { ProductDetailView, VariantView } from "@/src/server/catalog/catalog.service";

/**
 * Variant selection, gallery and the Add to Cart control.
 *
 * The ONLY client component on the storefront, and the only reason it is one:
 * selecting a variant changes what the page shows.
 *
 * It selects among data already delivered by the server. No fetch, no Shopify
 * call, no request of any kind happens when the selection changes -- every
 * variant's price, compare-at and availability arrived with the page.
 *
 * It receives view models, never Prisma rows: prices are exact decimal strings,
 * and `catalog.service.ts` is marked `server-only`, so importing it here would
 * fail the build rather than ship the database client to a browser.
 */
export function ProductPurchasePanel({ product }: { product: ProductDetailView }) {
  // Default to the first purchasable variant, falling back to the first
  // overall: landing on an out-of-stock variant when a buyable one exists is a
  // worse first impression than the page being slightly opinionated.
  const initial = product.variants.find((variant) => variant.available) ?? product.variants[0];

  const [selectedId, setSelectedId] = useState<string | undefined>(initial?.id);
  /**
   * A thumbnail the shopper picked, as a url, or null for "follow the variant".
   *
   * Cleared by the option control itself, so selecting a variant always wins.
   * An earlier version keyed this to the variant it was picked for, which looked
   * equivalent and was not: going Black -> thumbnail -> White -> Black brought
   * the old override back, and the image stopped following the selection. A
   * manual choice belongs to one selection, not to a variant forever.
   */
  const [manualImage, setManualImage] = useState<string | null>(null);
  const [requestedQuantity, setRequestedQuantity] = useState(1);
  /**
   * Which variant was last added, not a boolean.
   *
   * The confirmation then disappears by itself when the shopper switches
   * option, because the message is a function of the current selection rather
   * than a flag someone has to remember to reset. Nothing is cleared in an
   * effect, which also keeps React 19's `set-state-in-effect` rule satisfied.
   */
  const [addedVariantId, setAddedVariantId] = useState<string | null>(null);

  const { add } = useCart();

  const selected: VariantView | undefined =
    product.variants.find((variant) => variant.id === selectedId) ?? initial;

  /**
   * Which image the gallery shows, in precedence order:
   *
   *   1. a thumbnail the shopper picked for THIS variant;
   *   2. the image Shopify assigned to the selected variant;
   *   3. the product's first image.
   *
   * (3) is the fallback for a variant with no assigned image, which is the
   * common case -- 11 of the 19 variants in the current catalog have none. It is
   * a normal state, not a missing one.
   */
  const image =
    (manualImage ? product.images.find((candidate) => candidate.url === manualImage) : undefined) ??
    selected?.image ??
    product.images[0] ??
    null;

  /**
   * The ceiling on this line's quantity.
   *
   * `inventoryQuantity` is null when Shopify does not track the variant, and a
   * tracked variant sitting at 0 while still `available` is one Shopify allows
   * to oversell (`inventoryPolicy = CONTINUE`). Neither is limited by stock, so
   * only a positive tracked count narrows the cap below the per-line maximum.
   */
  const stockCap = selected?.inventoryQuantity ?? null;
  const stockLimited = stockCap !== null && stockCap > 0;
  const maxQuantity = stockLimited
    ? Math.min(MAX_LINE_QUANTITY, stockCap)
    : MAX_LINE_QUANTITY;

  /**
   * Clamped at render rather than corrected in an effect. Switching from a
   * variant with 25 in stock to one with 3 cannot leave 25 in the field for a
   * frame, and the number that reaches the cart is the clamped one because it is
   * the only one this component ever reads.
   */
  const quantity = Math.min(Math.max(requestedQuantity, 1), maxQuantity);
  const justAdded = addedVariantId !== null && addedVariantId === selected?.id;

  return (
    <div className="row">
      <div className="col-lg-6 mb-4 mb-lg-0">
        {image ? (
          <>
            <div className="storefront-detail-media">
              {/* eslint-disable-next-line @next/next/no-img-element -- remote Shopify CDN, see ProductCard */}
              <img
                src={image.url}
                alt={image.altText ?? product.title}
                className="storefront-gallery-main"
              />
            </div>
            {product.images.length > 1 ? (
              <div className="d-flex flex-wrap mt-3" role="group" aria-label="Product images">
                {product.images.map((thumb, index) => {
                  // Compared by url, not by index: the displayed image can come
                  // from the selected variant, which has no index of its own.
                  const active = thumb.url === image?.url;
                  return (
                    <button
                      key={thumb.url}
                      type="button"
                      className="btn p-0 mr-2 mb-2 bg-transparent border-0"
                      onClick={() => setManualImage(thumb.url)}
                      aria-label={`Show image ${index + 1}`}
                      aria-pressed={active}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- as above */}
                      <img
                        src={thumb.url}
                        alt=""
                        className={`storefront-gallery-thumb rounded${
                          active ? " storefront-gallery-thumb--active" : ""
                        }`}
                      />
                    </button>
                  );
                })}
              </div>
            ) : null}
          </>
        ) : (
          <div className="storefront-detail-media storefront-gallery-main storefront-card-image--placeholder d-flex align-items-center justify-content-center">
            <span className="text-muted">No image available</span>
          </div>
        )}
      </div>

      <div className="col-lg-6">
        {product.vendor ? <p className="storefront-card-vendor">{product.vendor}</p> : null}
        <h1 className="storefront-detail-title">{product.title}</h1>

        {selected ? (
          <>
            <div className="d-flex align-items-baseline flex-wrap mt-3">
              <span className="storefront-detail-price mr-2">
                {formatMoney(selected.price, selected.currencyCode)}
              </span>
              {selected.compareAtPrice ? (
                <span className="storefront-price-compare">
                  {formatMoney(selected.compareAtPrice, selected.currencyCode)}
                </span>
              ) : null}
            </div>

            <p className="mt-2 mb-3">
              {selected.available ? (
                <span className="badge badge-success">In stock</span>
              ) : (
                <span className="badge badge-danger">Sold Out</span>
              )}
              {/*
                Quantity is shown only when Shopify tracks it. For an untracked
                variant the stored number is meaningless, and printing "0 left"
                would be actively wrong.
              */}
              {selected.available && selected.inventoryQuantity !== null ? (
                <span className="text-muted small ml-2">
                  {selected.inventoryQuantity} available
                </span>
              ) : null}
              {selected.sku ? (
                <span className="storefront-detail-sku ml-2">SKU {selected.sku}</span>
              ) : null}
            </p>

            {product.variants.length > 1 ? (
              <div className="form-group">
                <label className="storefront-option-label" htmlFor="variant-select">
                  Option
                </label>
                <select
                  id="variant-select"
                  className="form-control storefront-select"
                  value={selected.id}
                  onChange={(event) => {
                    setSelectedId(event.target.value);
                    // Selecting an option re-asserts the variant's own image
                    // over any thumbnail the shopper had picked.
                    setManualImage(null);
                  }}
                >
                  {product.variants.map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {variant.title}
                      {" — "}
                      {formatMoney(variant.price, variant.currencyCode)}
                      {variant.available ? "" : " · Sold Out"}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="form-group">
              <label className="storefront-option-label" htmlFor="quantity-input">
                Quantity
              </label>
              <input
                id="quantity-input"
                type="number"
                className="form-control storefront-quantity"
                min={1}
                max={maxQuantity}
                step={1}
                value={quantity}
                disabled={!selected.available}
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value, 10);
                  if (Number.isNaN(next)) return;
                  setRequestedQuantity(next);
                }}
              />
              {/*
                `max` on the input stops the spinner and a typed-in number past
                the cap, but the clamp above is what actually decides -- an
                attribute is a convenience, never the rule.
              */}
              {stockLimited && maxQuantity < MAX_LINE_QUANTITY ? (
                <small className="form-text text-muted">
                  {maxQuantity} in stock for this option.
                </small>
              ) : null}
            </div>

            {/*
              Adds the VARIANT ID and the quantity to the cart, and nothing else
              -- not the price rendered above it. That price is display only; the
              cart page and the checkout each re-read it from MySQL.

              `available` came from the server too, so this button being enabled
              is a hint, not a guarantee: the server checks stock again at
              checkout, because between this render and that request the stock can
              go to zero.
            */}
            <button
              type="button"
              className="btn btn-primary btn-block storefront-cta"
              disabled={!selected.available}
              onClick={() => {
                add(selected.id, quantity);
                setAddedVariantId(selected.id);
              }}
            >
              {selected.available ? "Add to Cart" : "Sold Out"}
            </button>

            {justAdded ? (
              <p className="text-success small mt-2 mb-0">
                Added to your cart. <Link href="/cart">View cart</Link>
              </p>
            ) : (
              <p className="text-muted small mt-2 mb-0">
                {selected.available
                  ? "Pay in cash when your order is delivered."
                  : "This option is sold out. Choose another option, or check back later."}
              </p>
            )}
          </>
        ) : (
          <div className="alert alert-secondary mb-0 mt-3">
            This product has no purchasable options at the moment.
          </div>
        )}

        {product.variantsMayBeIncomplete ? (
          <div className="alert alert-warning mt-3 mb-0 small">
            Some options for this product are still being synchronised, so the list above may be
            incomplete.
          </div>
        ) : null}
      </div>
    </div>
  );
}
