import { StorefrontLayout } from "@/src/components/storefront/StorefrontLayout";
import { ProductCard } from "@/src/components/storefront/ProductCard";
import { listProducts } from "@/src/server/catalog/catalog.service";

/**
 * Catalog listing.
 *
 * A server component reading MySQL through the catalog service. It makes no
 * Shopify request -- the storefront never does. Everything on this page was put
 * in MySQL by the sync worker, in a different process, minutes earlier.
 */
export const dynamic = "force-dynamic";

export default async function CatalogPage({
  searchParams,
}: {
  // Next 16: searchParams is async and must be awaited.
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  const { products, nextCursor } = await listProducts({ cursor });

  return (
    // No page title: the hero below names the store, and a "Catalog" heading
    // above it would be a second title saying less.
    <StorefrontLayout>
      {/*
        A plain typographic hero. No stock photography and no claim that is not
        true of this store: the three points below are each a property of the
        system as built -- cash on delivery, a Shopify-synced catalog, and stock
        re-checked server-side when the order is placed.
      */}
      <section className="storefront-hero">
        <h1 className="storefront-hero-title">Electronics, delivered and paid in cash</h1>
        <p className="storefront-hero-lead">
          Headphones, keyboards, wearables and desk accessories. Pay the courier when your order
          arrives — no card details are collected at any point.
        </p>
        <ul className="storefront-hero-points">
          <li>Cash on delivery</li>
          <li>Live Shopify catalog</li>
          <li>Stock confirmed at checkout</li>
        </ul>
      </section>

      {products.length === 0 ? (
        // An empty catalog is a legitimate state -- a store with nothing
        // published, or a sync that has not run yet -- and says so plainly
        // rather than rendering an empty grid that looks broken.
        <div className="card">
          <div className="card-body text-center py-5">
            <h2 className="h5">No products available</h2>
            <p className="text-muted mb-0">
              Nothing is published yet, or the catalog has not been synchronised.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="storefront-section-head">
            <h2 className="storefront-section-title">Featured Electronics</h2>
            <span className="storefront-section-count">
              {products.length} product{products.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="row">
            {products.map((product) => (
              <div className="col-12 col-sm-6 col-lg-4 col-xl-3 mb-4 d-flex" key={product.handle}>
                <ProductCard product={product} />
              </div>
            ))}
          </div>

          {nextCursor ? (
            <div className="text-center mb-4">
              {/* Keyset pagination: the cursor names the last row, never an offset. */}
              <a className="btn btn-outline-primary" href={`/?cursor=${encodeURIComponent(nextCursor)}`}>
                Next page
              </a>
            </div>
          ) : null}
        </>
      )}
    </StorefrontLayout>
  );
}
