import Link from "next/link";

import { formatMoney } from "@/src/lib/money";
import type { ProductCardView } from "@/src/server/catalog/catalog.service";

/**
 * One product in the catalog grid, as an AdminLTE card.
 *
 * A server component: it receives a plain view model and renders. There is no
 * state, so making it a client component would ship JavaScript to render static
 * markup.
 *
 * Every field it displays is already resolved server-side -- including which
 * price to show and whether a compare-at price is a genuine discount -- so the
 * card contains no pricing logic of its own.
 */
export function ProductCard({ product }: { product: ProductCardView }) {
  const price = formatMoney(product.fromPrice, product.currencyCode);
  const compareAt = product.compareAtPrice
    ? formatMoney(product.compareAtPrice, product.currencyCode)
    : null;

  return (
    <div className="card h-100">
      {/*
        A product with no image is normal, not an error: Shopify does not
        require one. A placeholder of the same height keeps the grid aligned
        instead of letting one card collapse.
      */}
      {product.image ? (
        // eslint-disable-next-line @next/next/no-img-element -- Shopify CDN hosts
        // these at arbitrary remote paths; next/image would need every CDN host
        // allow-listed in next.config, which is configuration this phase does
        // not own.
        <img
          src={product.image.url}
          alt={product.image.altText ?? product.title}
          className="card-img-top storefront-card-image"
          loading="lazy"
        />
      ) : (
        <div className="card-img-top storefront-card-image storefront-card-image--placeholder">
          <span className="small">No image</span>
        </div>
      )}

      <div className="card-body d-flex flex-column">
        {product.vendor ? (
          <p className="text-muted text-uppercase small mb-1">{product.vendor}</p>
        ) : null}

        <h2 className="h6 card-title mb-2">{product.title}</h2>

        <p className="mb-2">
          {product.variantCount > 1 ? <span className="text-muted small mr-1">from</span> : null}
          <span className="font-weight-bold">{price}</span>
          {compareAt ? <span className="ml-2 small storefront-price-compare">{compareAt}</span> : null}
        </p>

        {/*
          Availability is a property of the variants, computed server-side. An
          unavailable product still links through -- the detail page explains
          which variants are out of stock, which is more useful than a dead card.
        */}
        <p className="mb-3">
          {product.available ? (
            <span className="badge badge-success">In stock</span>
          ) : (
            <span className="badge badge-secondary">Out of stock</span>
          )}
        </p>

        <Link className="btn btn-primary btn-block mt-auto" href={`/products/${product.handle}`}>
          View product
        </Link>
      </div>
    </div>
  );
}
