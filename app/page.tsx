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
    <StorefrontLayout
      title="Catalog"
      subtitle={
        products.length > 0
          ? `${products.length} product${products.length === 1 ? "" : "s"}`
          : undefined
      }
    >
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
