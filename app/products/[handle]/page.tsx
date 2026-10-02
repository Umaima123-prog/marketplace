import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { StorefrontLayout } from "@/src/components/storefront/StorefrontLayout";
import { ProductInfoTabs } from "@/src/components/storefront/ProductInfoTabs";
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
    // Section name on the left, breadcrumb on the right -- the reference's page
    // header. The product's own name is the <h1> inside the card, beside the
    // price and the buying controls, which is where a shopper looks for it.
    <StorefrontLayout
      title="Electronics"
      breadcrumb={
        <ol className="breadcrumb float-sm-right bg-transparent p-0 mb-0">
          <li className="breadcrumb-item">
            <Link href="/">Home</Link>
          </li>
          <li className="breadcrumb-item active">{product.title}</li>
        </ol>
      }
    >
      <div className="card storefront-card storefront-pdp-card">
        <div className="card-body">
          <ProductPurchasePanel product={product} />
        </div>
      </div>

      {/*
        Description, Comments and Rating, matching the reference. Only
        Description carries data: this project has no reviews or comments
        backend, so the other two are honest empty states with no submission
        form. See ProductInfoTabs for why that is the rendering chosen.
      */}
      <ProductInfoTabs descriptionHtml={product.descriptionHtml} />
    </StorefrontLayout>
  );
}
