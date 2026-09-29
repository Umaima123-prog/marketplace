import "server-only";

/**
 * The storefront's only route to catalog data.
 *
 * Two rules this module exists to enforce:
 *
 * 1. **The storefront never calls Shopify.** Everything here reads MySQL. The
 *    sync worker is the only process that talks to the Admin API, and it runs
 *    somewhere else entirely (ARCHITECTURE §2).
 *
 * 2. **Prisma never reaches a client component.** `server-only` makes that a
 *    build error rather than a convention: importing this from a `"use client"`
 *    module fails the build instead of shipping the database client, the
 *    connection string, and every internal column to a browser.
 *
 * Everything returned is a plain view model with prices as exact decimal
 * strings. Internal columns -- `lastSyncRunId`, `syncedAt`, `variantSyncCursor`,
 * `shopifyUpdatedAt`, anything from SyncRun or JobLog -- are never selected, so
 * they cannot leak by accident.
 */
import type { Prisma } from "@/src/generated/prisma";
import { prisma } from "@/src/lib/prisma";
import { compareMoney, normalizeMoney, type MoneyString } from "@/src/lib/money";

// ---------------------------------------------------------------------------
// view models -- the shape the storefront sees
// ---------------------------------------------------------------------------

export interface ProductImageView {
  url: string;
  altText: string | null;
}

export interface VariantView {
  id: string;
  title: string;
  sku: string | null;
  price: MoneyString;
  compareAtPrice: MoneyString | null;
  currencyCode: string;
  /** Whether this variant can be added to a cart right now. */
  available: boolean;
  /** Shown only when tracked; null means "not tracked", not "zero". */
  inventoryQuantity: number | null;
}

export interface ProductCardView {
  handle: string;
  title: string;
  vendor: string | null;
  image: ProductImageView | null;
  /** Lowest price among purchasable variants. */
  fromPrice: MoneyString;
  /** The compare-at of the variant that set `fromPrice`, when higher. */
  compareAtPrice: MoneyString | null;
  currencyCode: string;
  /** True when at least one variant is purchasable. */
  available: boolean;
  variantCount: number;
}

export interface ProductDetailView {
  handle: string;
  title: string;
  descriptionHtml: string | null;
  vendor: string | null;
  productType: string | null;
  images: ProductImageView[];
  variants: VariantView[];
  currencyCode: string;
  available: boolean;
  /**
   * True when the stored variant set is known to be truncated
   * (ARCHITECTURE §3.3). The page says so rather than implying the list is
   * complete.
   */
  variantsMayBeIncomplete: boolean;
}

export interface ProductListPage {
  products: ProductCardView[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// selection -- narrow on purpose
// ---------------------------------------------------------------------------

/**
 * A variant is purchasable when it is active and either untracked, in stock, or
 * explicitly allowed to oversell. Mirrors the check the checkout will re-run
 * server-side; the storefront copy is presentation, never authorisation.
 */
function isPurchasable(variant: {
  isActive: boolean;
  inventoryTracked: boolean;
  inventoryQuantity: number;
  inventoryPolicy: "DENY" | "CONTINUE";
}): boolean {
  if (!variant.isActive) return false;
  if (!variant.inventoryTracked) return true;
  if (variant.inventoryPolicy === "CONTINUE") return true;
  return variant.inventoryQuantity > 0;
}

/**
 * Listing selection.
 *
 * `descriptionHtml` is deliberately absent: it is a TEXT column holding the
 * whole product description, and a 24-card grid does not display one. Fetching
 * it would multiply the transferred bytes for nothing.
 *
 * One image, one row per variant. Prisma resolves each relation in a single
 * additional query regardless of how many products match, so this is three
 * queries in total, not 1 + 2N.
 */
const LISTING_SELECT = {
  id: true,
  handle: true,
  title: true,
  vendor: true,
  images: {
    select: { url: true, altText: true },
    orderBy: { position: "asc" },
    take: 1,
  },
  variants: {
    where: { isActive: true },
    select: {
      price: true,
      compareAtPrice: true,
      currencyCode: true,
      inventoryQuantity: true,
      inventoryTracked: true,
      inventoryPolicy: true,
      isActive: true,
    },
    orderBy: { price: "asc" },
  },
} satisfies Prisma.ProductSelect;

const DETAIL_SELECT = {
  id: true,
  handle: true,
  title: true,
  descriptionHtml: true,
  vendor: true,
  productType: true,
  variantSyncComplete: true,
  images: {
    select: { url: true, altText: true },
    orderBy: { position: "asc" },
  },
  variants: {
    where: { isActive: true },
    select: {
      id: true,
      title: true,
      sku: true,
      price: true,
      compareAtPrice: true,
      currencyCode: true,
      inventoryQuantity: true,
      inventoryTracked: true,
      inventoryPolicy: true,
      isActive: true,
    },
    orderBy: { position: "asc" },
  },
} satisfies Prisma.ProductSelect;

/**
 * What the storefront is allowed to see.
 *
 * `isActive` is ours (the sync sets it) and `status` is Shopify's; both must
 * agree. A product archived in Shopify has `isActive = false` already, but
 * requiring both means a bug in one does not silently publish a product.
 */
const VISIBLE = { isActive: true, status: "ACTIVE" } satisfies Prisma.ProductWhereInput;

// ---------------------------------------------------------------------------
// listing
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 60;

export interface ListCursor {
  /** Epoch ms, or null for products Shopify never published. */
  publishedAtMs: number | null;
  id: string;
}

export function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Returns null for anything malformed: a bad cursor is page one, not a 500. */
export function decodeCursor(raw: string | null | undefined): ListCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { publishedAtMs, id } = parsed as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0) return null;
    if (publishedAtMs !== null && typeof publishedAtMs !== "number") return null;
    return { publishedAtMs, id };
  } catch {
    return null;
  }
}

/**
 * Keyset pagination, never OFFSET (ARCHITECTURE §3.5).
 *
 * Ordering is `publishedAt DESC, id DESC`, which matches the existing
 * `(isActive, publishedAt, id)` index. MySQL sorts NULLs last under DESC, so
 * products Shopify never published come after the published ones -- and the
 * predicate below has to say that explicitly, because `publishedAt < NULL` is
 * NULL in SQL, not true.
 */
export function keysetWhere(cursor: ListCursor | null): Prisma.ProductWhereInput {
  if (!cursor) return {};

  if (cursor.publishedAtMs === null) {
    // Already inside the trailing NULL group: only smaller ids remain.
    return { publishedAt: null, id: { lt: cursor.id } };
  }

  const publishedAt = new Date(cursor.publishedAtMs);
  return {
    OR: [
      { publishedAt: { lt: publishedAt } },
      { publishedAt, id: { lt: cursor.id } },
      // The NULL group sorts after every non-null value.
      { publishedAt: null },
    ],
  };
}

export async function listProducts(
  options: { limit?: number; cursor?: string | null } = {},
): Promise<ProductListPage> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const cursor = decodeCursor(options.cursor);

  // One extra row decides whether another page exists, without a second query.
  const rows = await prisma.product.findMany({
    where: { AND: [VISIBLE, keysetWhere(cursor)] },
    select: { ...LISTING_SELECT, publishedAt: true },
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return {
    products: page.map(toCard).filter((card): card is ProductCardView => card !== null),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ publishedAtMs: last.publishedAt?.getTime() ?? null, id: last.id })
        : null,
  };
}

type ListingRow = Prisma.ProductGetPayload<{ select: typeof LISTING_SELECT }> & {
  publishedAt?: Date | null;
};

/**
 * A product with no active variant has no price to show and nothing to sell, so
 * it is not a card. Returning null rather than a placeholder keeps that
 * decision in one place.
 */
export function toCard(row: ListingRow): ProductCardView | null {
  if (row.variants.length === 0) return null;

  // Variants arrive ordered by price ascending, so the first is the lowest.
  // Decimal -> string at the boundary; no price becomes a number anywhere.
  const cheapest = row.variants[0];
  // normalizeMoney, not toString alone: Prisma's Decimal drops trailing zeros,
  // which would put "15" and "9.99" in the same response.
  const fromPrice = normalizeMoney(cheapest.price.toString());
  const compareAt = cheapest.compareAtPrice ? normalizeMoney(cheapest.compareAtPrice.toString()) : null;

  return {
    handle: row.handle,
    title: row.title,
    vendor: row.vendor,
    image: row.images[0] ?? null,
    fromPrice,
    // A compare-at that is not above the price is not a discount; showing it
    // struck through would be a lie.
    compareAtPrice: compareAt && compareMoney(compareAt, fromPrice) > 0 ? compareAt : null,
    currencyCode: cheapest.currencyCode,
    available: row.variants.some(isPurchasable),
    variantCount: row.variants.length,
  };
}

// ---------------------------------------------------------------------------
// detail
// ---------------------------------------------------------------------------

/**
 * Looked up by handle, and only among visible products.
 *
 * The browser supplies the handle, which selects a row -- it never decides
 * whether that row may be shown. An inactive or archived product is simply not
 * found, which is also why the page can answer 404 without a second check.
 */
export async function getProductByHandle(handle: string): Promise<ProductDetailView | null> {
  if (typeof handle !== "string" || handle.length === 0 || handle.length > 255) return null;

  const row = await prisma.product.findFirst({
    where: { ...VISIBLE, handle },
    select: DETAIL_SELECT,
  });

  return row ? toDetail(row) : null;
}

type DetailRow = Prisma.ProductGetPayload<{ select: typeof DETAIL_SELECT }>;

export function toDetail(row: DetailRow): ProductDetailView {
  const variants: VariantView[] = row.variants.map((variant) => ({
    id: variant.id,
    title: variant.title,
    sku: variant.sku,
    price: normalizeMoney(variant.price.toString()),
    compareAtPrice: variant.compareAtPrice ? normalizeMoney(variant.compareAtPrice.toString()) : null,
    currencyCode: variant.currencyCode,
    available: isPurchasable(variant),
    inventoryQuantity: variant.inventoryTracked ? variant.inventoryQuantity : null,
  })).map((view) => ({
    ...view,
    compareAtPrice:
      view.compareAtPrice && compareMoney(view.compareAtPrice, view.price) > 0
        ? view.compareAtPrice
        : null,
  }));

  return {
    handle: row.handle,
    title: row.title,
    descriptionHtml: row.descriptionHtml,
    vendor: row.vendor,
    productType: row.productType,
    images: row.images,
    variants,
    currencyCode: variants[0]?.currencyCode ?? "USD",
    available: variants.some((variant) => variant.available),
    variantsMayBeIncomplete: !row.variantSyncComplete,
  };
}

/** Handles for `generateStaticParams` and sitemaps. Ids are never exposed. */
export async function listProductHandles(limit = 200): Promise<string[]> {
  const rows = await prisma.product.findMany({
    where: VISIBLE,
    select: { handle: true },
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  return rows.map((row) => row.handle);
}
