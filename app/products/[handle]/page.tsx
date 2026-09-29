import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { StorefrontLayout } from "@/src/components/storefront/StorefrontLayout";
import { ProductPurchasePanel } from "@/src/components/storefront/ProductPurchasePanel";
import { getProductByHandle } from "@/src/server/catalog/catalog.service";

export const dynamic = "force-dynamic";

/**
 * Product detail.
 *
 * The handle comes from the URL and selects a row; it never decides whether
 * that row may be shown. `getProductByHandle` searches only visible products,
 * so an inactive, archived or unknown handle is simply not found -- one code
 * path for "does not exist" and "may not be shown", which is the version that
 * cannot leak the difference between them.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  const product = await getProductByHandle(handle);
  return product ? { title: product.title } : { title: "Product not found" };
}

export default async function ProductDetailPage({
  params,
}: {
  // Next 16: params is async and must be awaited.
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const product = await getProductByHandle(handle);

  if (!product) notFound();

  return (
    <StorefrontLayout
      title={product.title}
      subtitle={product.vendor ?? undefined}
      breadcrumb={
        <ol className="breadcrumb float-sm-right bg-transparent p-0 mb-0">
          <li className="breadcrumb-item">
            <Link href="/">Catalog</Link>
          </li>
          <li className="breadcrumb-item active">{product.title}</li>
        </ol>
      }
    >
      <div className="card">
        <div className="card-body">
          <ProductPurchasePanel product={product} />
        </div>
      </div>

      {product.descriptionHtml ? (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title h6 mb-0">Description</h2>
          </div>
          <div className="card-body">
            {/*
              Shopify-authored HTML. It is rendered as markup because that is
              what a product description is, and it is trusted for exactly one
              reason: it comes from the merchant's own Shopify admin via the
              sync worker, never from a shopper. No user input reaches this.
            */}
            <div
              className="storefront-description"
              dangerouslySetInnerHTML={{ __html: product.descriptionHtml }}
            />
          </div>
        </div>
      ) : null}
    </StorefrontLayout>
  );
}
