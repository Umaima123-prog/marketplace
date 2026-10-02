"use client";

import { useState } from "react";
import Link from "next/link";

import { useCart } from "@/src/components/cart/CartProvider";
import { MAX_LINE_QUANTITY } from "@/src/lib/cart/cart-state";
import { formatMoney } from "@/src/lib/money";
import {
  excerptFromHtml,
  optionGroupLabel,
  shouldUseChips,
  swatchFor,
} from "@/src/lib/storefront/option-display";
import type { ProductDetailView, VariantView } from "@/src/server/catalog/catalog.service";

/**
 * Variant selection, gallery and the Add to Cart control.
 *
 * The ONLY client component on the storefront, and the only reason it is one:
 * selecting a variant changes what the page shows.
 *
 * It selects among data already delivered by the server. No fetch, no Shopify
 * call, no request of any kind happens when the selection changes -- every
 * variant's price, compare-at, availability and assigned image arrived with the
 * page.
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
   * Cleared whenever an option is chosen, so selecting a variant always wins.
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

  /** One place to change the variant, so the image override can never be missed. */
  function selectVariant(variantId: string) {
    setSelectedId(variantId);
    setManualImage(null);
  }

  /**
   * Which image the gallery shows, in precedence order:
   *
   *   1. a thumbnail the shopper just picked;
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
  const maxQuantity = stockLimited ? Math.min(MAX_LINE_QUANTITY, stockCap) : MAX_LINE_QUANTITY;

  /**
   * Clamped at render rather than corrected in an effect. Switching from a
   * variant with 25 in stock to one with 3 cannot leave 25 in the field for a
   * frame, and the number that reaches the cart is the clamped one because it is
   * the only one this component ever reads.
   */
  const quantity = Math.min(Math.max(requestedQuantity, 1), maxQuantity);
  const justAdded = addedVariantId !== null && addedVariantId === selected?.id;

  const titles = product.variants.map((variant) => variant.title);
  const useChips = shouldUseChips(product.variants.length);
  const groupLabel = optionGroupLabel(titles);
  const lead = excerptFromHtml(product.descriptionHtml);

  return (
    <div className="row storefront-pdp">
      {/* ---- left: gallery -------------------------------------------- */}
      <div className="col-12 col-lg-6 mb-4 mb-lg-0">
        {image ? (
          <>
            <div className="storefront-pdp-stage">
              {/* eslint-disable-next-line @next/next/no-img-element -- remote Shopify CDN, see ProductCard */}
              <img
                src={image.url}
                alt={image.altText ?? product.title}
                className="storefront-pdp-stage-image"
              />
            </div>

            {product.images.length > 1 ? (
              <div className="storefront-pdp-thumbs" role="group" aria-label="Product images">
                {product.images.map((thumb, index) => {
                  // Compared by url, not by index: the displayed image can come
                  // from the selected variant, which has no index of its own.
                  const active = thumb.url === image.url;
                  return (
                    <button
                      key={thumb.url}
                      type="button"
                      className={`storefront-pdp-thumb${
                        active ? " storefront-pdp-thumb--active" : ""
                      }`}
                      onClick={() => setManualImage(thumb.url)}
                      aria-label={`Show image ${index + 1}`}
                      aria-pressed={active}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- as above */}
                      <img src={thumb.url} alt="" />
                    </button>
                  );
                })}
              </div>
            ) : null}
          </>
        ) : (
          <div className="storefront-pdp-stage storefront-pdp-stage--empty">
            <span className="text-muted">No image available</span>
          </div>
        )}
      </div>

      {/* ---- right: product information ------------------------------- */}
      <div className="col-12 col-lg-6">
        {product.vendor ? <p className="storefront-card-vendor">{product.vendor}</p> : null}
        <h1 className="storefront-pdp-title">{product.title}</h1>
        {lead ? <p className="storefront-pdp-lead">{lead}</p> : null}

        {selected ? (
          <>
            <hr className="storefront-pdp-rule" />

            {/* ---- options ---------------------------------------------- */}
            {product.variants.length > 1 ? (
              <div className="storefront-pdp-options">
                <h2 className="storefront-pdp-section-heading" id="variant-group-label">
                  {groupLabel}
                </h2>

                {useChips ? (
                  // One bordered group with the cells joined by dividers, as in
                  // the reference: the option name sits above its swatch.
                  <div
                    className="storefront-pdp-swatches"
                    role="group"
                    aria-labelledby="variant-group-label"
                  >
                    {product.variants.map((variant) => {
                      const swatch = swatchFor(variant.title);
                      const active = variant.id === selected.id;
                      return (
                        <button
                          key={variant.id}
                          type="button"
                          data-variant-id={variant.id}
                          className={`storefront-pdp-swatch${
                            active ? " storefront-pdp-swatch--active" : ""
                          }${variant.available ? "" : " storefront-pdp-swatch--soldout"}`}
                          onClick={() => selectVariant(variant.id)}
                          aria-pressed={active}
                          // A sold-out option stays SELECTABLE: the shopper has
                          // to be able to look at it and see why it cannot be
                          // bought. Disabling the cell would hide the price and
                          // the Sold Out state behind a dead control.
                        >
                          <span className="storefront-pdp-swatch-label">{variant.title}</span>
                          {swatch ? (
                            <span
                              className={`storefront-pdp-dot${
                                swatch.needsOutline ? " storefront-pdp-dot--outlined" : ""
                              }`}
                              style={{ background: swatch.color }}
                              aria-hidden="true"
                            />
                          ) : null}
                          {variant.available ? null : (
                            <span className="storefront-pdp-swatch-note">Sold Out</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  // Many variants: the dropdown remains the usable control.
                  <select
                    id="variant-select"
                    className="form-control storefront-select"
                    value={selected.id}
                    onChange={(event) => selectVariant(event.target.value)}
                    aria-labelledby="variant-group-label"
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
                )}
              </div>
            ) : null}

            {/*
              ---- price box ----------------------------------------------
              The reference's solid slate panel with the price large and white,
              and a secondary line beneath. The reference's second line is
              "Ex Tax"; this store does not compute tax, so the line states what
              is actually true of the order -- cash on delivery, and the zero
              `taxTotal` the checkout really writes.
            */}
            <div className="storefront-pdp-price-box">
              <div className="storefront-pdp-price-row">
                <span className="storefront-pdp-price">
                  {formatMoney(selected.price, selected.currencyCode)}
                </span>
                {selected.compareAtPrice ? (
                  <span className="storefront-pdp-price-compare">
                    {formatMoney(selected.compareAtPrice, selected.currencyCode)}
                  </span>
                ) : null}
              </div>
              <p className="storefront-pdp-price-note">
                Cash on delivery · Tax: {formatMoney("0.00", selected.currencyCode)}
              </p>
            </div>

            {/*
              Stock row, buying control and note as ONE block, so their spacing
              can tighten together when the variant is sold out. Sold out, the
              three lines read as a single statement: what the state is, the
              control that is unavailable, and what to do about it.
            */}
            <div
              className={`storefront-pdp-purchase${
                selected.available ? "" : " storefront-pdp-purchase--soldout"
              }`}
            >
              <div className="storefront-pdp-status">
                {selected.available ? (
                  <span className="badge badge-success">In Stock</span>
                ) : (
                  <span className="badge badge-danger">Sold Out</span>
                )}
                {/*
                  Quantity is shown only when Shopify tracks it. For an untracked
                  variant the stored number is meaningless, and printing "0 left"
                  would be actively wrong.
                */}
                {selected.available && selected.inventoryQuantity !== null ? (
                  <span className="text-muted small">{selected.inventoryQuantity} available</span>
                ) : null}
                {selected.sku ? (
                  <span className="storefront-detail-sku">SKU {selected.sku}</span>
                ) : null}
              </div>

              {/* ---- quantity + add to cart -------------------------------- */}
              <div className="storefront-pdp-buy">
                {/*
                  NOT RENDERED when the variant is sold out, rather than rendered
                  disabled. There is no quantity to choose of something that
                  cannot be bought, and a greyed field still asks the shopper to
                  read it and work out why it is dead. Removing it also pulls the
                  Sold Out button up against the stock row, which is the whole
                  point of the compact state.

                  The clamp and `maxQuantity` above are untouched, so the stock
                  rules are exactly as they were -- this hides a control, it does
                  not relax a limit.
                */}
                {selected.available ? (
                  <div className="form-group mb-0">
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
                ) : null}

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
                  className="btn btn-primary btn-block storefront-cta storefront-pdp-cta"
                  disabled={!selected.available}
                  onClick={() => {
                    add(selected.id, quantity);
                    setAddedVariantId(selected.id);
                  }}
                >
                  <CartIcon />
                  <span>{selected.available ? "Add to Cart" : "Sold Out"}</span>
                </button>
              </div>
              {justAdded ? (
                <p className="storefront-pdp-note text-success">
                  Added to your cart. <Link href="/cart">View cart</Link>
                </p>
              ) : (
                <p className="storefront-pdp-note text-muted">
                  {selected.available
                    ? "Pay in cash when your order is delivered."
                    : "This option is sold out. Choose another option, or check back later."}
                </p>
              )}
            </div>
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

/**
 * Inline SVG rather than an icon font.
 *
 * AdminLTE is vendored as CSS only -- no Font Awesome, no icon set -- and
 * pulling one in for a single glyph would add a dependency and a network
 * request for 500 bytes of path data.
 */
function CartIcon() {
  return (
    <svg
      className="storefront-pdp-cta-icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="9" cy="20" r="1.4" />
      <circle cx="18" cy="20" r="1.4" />
      <path d="M2 3h2.2l2.6 12.2h11.4l2.2-8.4H6" />
    </svg>
  );
}
