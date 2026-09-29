"use client";

import { useState } from "react";

import { formatMoney } from "@/src/lib/money";
import type { ProductDetailView, VariantView } from "@/src/server/catalog/catalog.service";

/**
 * Variant selection, gallery and the Add to cart control.
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
  const [imageIndex, setImageIndex] = useState(0);

  const selected: VariantView | undefined =
    product.variants.find((variant) => variant.id === selectedId) ?? initial;

  const image = product.images[imageIndex] ?? product.images[0] ?? null;

  return (
    <div className="row">
      <div className="col-md-6 mb-3">
        {image ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- remote Shopify CDN, see ProductCard */}
            <img
              src={image.url}
              alt={image.altText ?? product.title}
              className="storefront-gallery-main border rounded"
            />
            {product.images.length > 1 ? (
              <div className="d-flex flex-wrap mt-2" role="group" aria-label="Product images">
                {product.images.map((thumb, index) => (
                  <button
                    key={thumb.url}
                    type="button"
                    className="btn p-0 mr-2 mb-2 bg-transparent border-0"
                    onClick={() => setImageIndex(index)}
                    aria-label={`Show image ${index + 1}`}
                    aria-pressed={index === imageIndex}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- as above */}
                    <img
                      src={thumb.url}
                      alt=""
                      className={`storefront-gallery-thumb rounded${
                        index === imageIndex ? " storefront-gallery-thumb--active" : ""
                      }`}
                    />
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="storefront-gallery-main storefront-card-image--placeholder border rounded d-flex align-items-center justify-content-center">
            <span className="text-muted">No image available</span>
          </div>
        )}
      </div>

      <div className="col-md-6">
        {selected ? (
          <>
            <p className="mb-1">
              <span className="h3 font-weight-bold">
                {formatMoney(selected.price, selected.currencyCode)}
              </span>
              {selected.compareAtPrice ? (
                <span className="ml-2 storefront-price-compare">
                  {formatMoney(selected.compareAtPrice, selected.currencyCode)}
                </span>
              ) : null}
            </p>

            <p className="mb-3">
              {selected.available ? (
                <span className="badge badge-success">In stock</span>
              ) : (
                <span className="badge badge-secondary">Out of stock</span>
              )}
              {/*
                Quantity is shown only when Shopify tracks it. For an untracked
                variant the stored number is meaningless, and printing "0 left"
                would be actively wrong.
              */}
              {selected.available && selected.inventoryQuantity !== null ? (
                <span className="text-muted small ml-2">{selected.inventoryQuantity} available</span>
              ) : null}
            </p>

            {product.variants.length > 1 ? (
              <div className="form-group">
                <label className="font-weight-bold" htmlFor="variant-select">
                  Option
                </label>
                <select
                  id="variant-select"
                  className="form-control"
                  value={selected.id}
                  onChange={(event) => setSelectedId(event.target.value)}
                >
                  {product.variants.map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {variant.title}
                      {variant.available ? "" : " — out of stock"}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {selected.sku ? <p className="text-muted small">SKU: {selected.sku}</p> : null}

            {/*
              UI only for this phase. It is disabled when the variant cannot be
              bought, and it deliberately does nothing yet -- a button that
              pretends to add to a cart that does not exist is worse than one
              that is honest about the phase it is in.
            */}
            <button
              type="button"
              className="btn btn-primary btn-lg btn-block"
              disabled={!selected.available}
              title="Cart is not implemented yet"
            >
              Add to cart
            </button>
            <p className="text-muted small mt-2 mb-0">
              Cart and checkout arrive in the next phase.
            </p>
          </>
        ) : (
          <div className="alert alert-secondary mb-0">
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
