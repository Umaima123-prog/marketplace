/**
 * Shopify GraphQL node -> database row. Pure: no Prisma, no network, no clock
 * except what is passed in. Every input is `unknown` and narrowed explicitly,
 * because "Shopify sent us a string where we expected a number" must fail on a
 * named field rather than three layers down inside a Prisma call.
 *
 * Money never becomes a JS number here. Prices arrive as decimal strings and
 * stay strings all the way into `DECIMAL(18,4)`; `Number("19.99")` is already
 * lossy by the time anyone sees it.
 */

export class MappingError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "MappingError";
    this.path = path;
  }
}

export type ProductStatus = "ACTIVE" | "ARCHIVED" | "DRAFT";
export type InventoryPolicy = "DENY" | "CONTINUE";

export interface MappedVariant {
  shopifyVariantId: string;
  title: string;
  sku: string | null;
  position: number;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number;
  inventoryTracked: boolean;
  inventoryPolicy: InventoryPolicy;
  shopifyUpdatedAt: Date;
  /** Flattened `selectedOptions`, e.g. `Size: L / Colour: Red`. */
  selectedOptions: Array<{ name: string; value: string }>;
}

export interface MappedImage {
  shopifyImageId: string;
  url: string;
  altText: string | null;
  position: number;
}

export interface MappedProduct {
  shopifyProductId: string;
  handle: string;
  title: string;
  descriptionHtml: string | null;
  vendor: string | null;
  productType: string | null;
  status: ProductStatus;
  publishedAt: Date | null;
  shopifyUpdatedAt: Date;
  options: Array<{ name: string; position: number; values: string[] }>;
  images: MappedImage[];
  variants: MappedVariant[];
  /** True when this product's variant connection has more pages to fetch. */
  variantsHasNextPage: boolean;
  /** Cursor to resume variant pagination from. Null when complete. */
  variantsEndCursor: string | null;
}

export interface MappedProductsPage {
  products: MappedProduct[];
  hasNextPage: boolean;
  endCursor: string | null;
}

// --------------------------------------------------------------------------
// primitives
// --------------------------------------------------------------------------

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MappingError(path, `expected an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MappingError(path, `expected a non-empty string, got ${describe(value)}`);
  }
  return value;
}

function optionalStr(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new MappingError(path, `expected a string or null, got ${describe(value)}`);
  }
  return value.length === 0 ? null : value;
}

function int(value: unknown, path: string, fallback?: number): number {
  if (value === null || value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new MappingError(path, "expected a number, got null");
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MappingError(path, `expected a finite number, got ${describe(value)}`);
  }
  return Math.trunc(value);
}

function bool(value: unknown, path: string, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new MappingError(path, `expected a boolean, got ${describe(value)}`);
  }
  return value;
}

function date(value: unknown, path: string): Date {
  const raw = str(value, path);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new MappingError(path, `expected an ISO timestamp, got "${raw}"`);
  }
  return parsed;
}

function optionalDate(value: unknown, path: string): Date | null {
  if (value === null || value === undefined) return null;
  return date(value, path);
}

/**
 * Money stays a string. Validated as a decimal so a malformed value fails here
 * rather than as a MySQL truncation warning that silently stores 0.
 */
function money(value: unknown, path: string): string {
  const raw = str(value, path);
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new MappingError(path, `expected a decimal amount, got "${raw}"`);
  }
  return raw;
}

function optionalMoney(value: unknown, path: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return money(value, path);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function enumValue<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  const raw = str(value, path);
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new MappingError(path, `expected one of ${allowed.join(" | ")}, got "${raw}"`);
  }
  return raw as T;
}

function nodes(value: unknown, path: string): unknown[] {
  const connection = obj(value, path);
  const list = connection.nodes;
  if (!Array.isArray(list)) {
    throw new MappingError(`${path}.nodes`, `expected an array, got ${describe(list)}`);
  }
  return list;
}

// --------------------------------------------------------------------------
// mappers
// --------------------------------------------------------------------------

export function mapVariant(input: unknown, path: string, index: number): MappedVariant {
  const node = obj(input, path);
  const inventoryItem =
    node.inventoryItem === null || node.inventoryItem === undefined
      ? {}
      : obj(node.inventoryItem, `${path}.inventoryItem`);

  const selectedOptions = Array.isArray(node.selectedOptions)
    ? node.selectedOptions.map((option, i) => {
        const o = obj(option, `${path}.selectedOptions[${i}]`);
        return {
          name: str(o.name, `${path}.selectedOptions[${i}].name`),
          value: str(o.value, `${path}.selectedOptions[${i}].value`),
        };
      })
    : [];

  return {
    shopifyVariantId: str(node.id, `${path}.id`),
    title: optionalStr(node.title, `${path}.title`) ?? "Default Title",
    sku: optionalStr(node.sku, `${path}.sku`),
    // Shopify positions are 1-based; fall back to array order when absent so
    // two variants never collide on position 0.
    position: int(node.position, `${path}.position`, index + 1),
    price: money(node.price, `${path}.price`),
    compareAtPrice: optionalMoney(node.compareAtPrice, `${path}.compareAtPrice`),
    // A variant with tracking off reports null; 0 is the honest projection,
    // and `inventoryTracked` is what the storefront actually branches on.
    inventoryQuantity: int(node.inventoryQuantity, `${path}.inventoryQuantity`, 0),
    inventoryTracked: bool(inventoryItem.tracked, `${path}.inventoryItem.tracked`, true),
    inventoryPolicy: enumValue(node.inventoryPolicy, `${path}.inventoryPolicy`, [
      "DENY",
      "CONTINUE",
    ] as const),
    shopifyUpdatedAt: date(node.updatedAt, `${path}.updatedAt`),
    selectedOptions,
  };
}

/** `media.nodes` holds MediaImage entries; anything else (video) is skipped. */
export function mapImages(media: unknown, path: string): MappedImage[] {
  if (media === null || media === undefined) return [];
  const list = nodes(media, path);
  const images: MappedImage[] = [];

  list.forEach((entry, index) => {
    const node = obj(entry, `${path}.nodes[${index}]`);
    const id = optionalStr(node.id, `${path}.nodes[${index}].id`);
    const image = node.image;
    if (!id || image === null || image === undefined) return;

    const img = obj(image, `${path}.nodes[${index}].image`);
    const url = optionalStr(img.url, `${path}.nodes[${index}].image.url`);
    if (!url) return;

    images.push({
      shopifyImageId: id,
      url,
      altText: optionalStr(img.altText, `${path}.nodes[${index}].image.altText`),
      position: index + 1,
    });
  });

  return images;
}

export function mapProduct(input: unknown, path: string): MappedProduct {
  const node = obj(input, path);

  const options = Array.isArray(node.options)
    ? node.options.map((option, i) => {
        const o = obj(option, `${path}.options[${i}]`);
        const values = Array.isArray(o.values)
          ? o.values.map((v, vi) => str(v, `${path}.options[${i}].values[${vi}]`))
          : [];
        return {
          name: str(o.name, `${path}.options[${i}].name`),
          position: int(o.position, `${path}.options[${i}].position`, i + 1),
          values,
        };
      })
    : [];

  const variantConnection = obj(node.variants, `${path}.variants`);
  const pageInfo = obj(variantConnection.pageInfo, `${path}.variants.pageInfo`);
  const hasNextPage = bool(pageInfo.hasNextPage, `${path}.variants.pageInfo.hasNextPage`, false);

  const variants = nodes(node.variants, `${path}.variants`).map((variant, i) =>
    mapVariant(variant, `${path}.variants.nodes[${i}]`, i),
  );

  return {
    shopifyProductId: str(node.id, `${path}.id`),
    handle: str(node.handle, `${path}.handle`),
    title: str(node.title, `${path}.title`),
    descriptionHtml: optionalStr(node.descriptionHtml, `${path}.descriptionHtml`),
    vendor: optionalStr(node.vendor, `${path}.vendor`),
    productType: optionalStr(node.productType, `${path}.productType`),
    status: enumValue(node.status, `${path}.status`, ["ACTIVE", "ARCHIVED", "DRAFT"] as const),
    publishedAt: optionalDate(node.publishedAt, `${path}.publishedAt`),
    shopifyUpdatedAt: date(node.updatedAt, `${path}.updatedAt`),
    options,
    images: mapImages(node.media, `${path}.media`),
    variants,
    variantsHasNextPage: hasNextPage,
    // The cursor is only meaningful when there IS a next page. Storing one
    // otherwise would leave a resume point for a chain that never runs.
    variantsEndCursor: hasNextPage
      ? optionalStr(pageInfo.endCursor, `${path}.variants.pageInfo.endCursor`)
      : null,
  };
}

export function mapProductsPage(input: unknown): MappedProductsPage {
  const root = obj(input, "data");
  const connection = obj(root.products, "data.products");
  const pageInfo = obj(connection.pageInfo, "data.products.pageInfo");
  const hasNextPage = bool(pageInfo.hasNextPage, "data.products.pageInfo.hasNextPage", false);

  return {
    products: nodes(connection, "data.products").map((node, i) =>
      mapProduct(node, `data.products.nodes[${i}]`),
    ),
    hasNextPage,
    endCursor: hasNextPage
      ? optionalStr(pageInfo.endCursor, "data.products.pageInfo.endCursor")
      : null,
  };
}

export interface MappedVariantsPage {
  shopifyProductId: string;
  shopifyUpdatedAt: Date;
  variants: MappedVariant[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export function mapVariantsPage(input: unknown, startIndex = 0): MappedVariantsPage {
  const root = obj(input, "data");
  if (root.product === null || root.product === undefined) {
    throw new MappingError("data.product", "product not found (deleted between pages?)");
  }
  const product = obj(root.product, "data.product");
  const connection = obj(product.variants, "data.product.variants");
  const pageInfo = obj(connection.pageInfo, "data.product.variants.pageInfo");
  const hasNextPage = bool(
    pageInfo.hasNextPage,
    "data.product.variants.pageInfo.hasNextPage",
    false,
  );

  return {
    shopifyProductId: str(product.id, "data.product.id"),
    shopifyUpdatedAt: date(product.updatedAt, "data.product.updatedAt"),
    variants: nodes(connection, "data.product.variants").map((variant, i) =>
      mapVariant(variant, `data.product.variants.nodes[${i}]`, startIndex + i),
    ),
    hasNextPage,
    endCursor: hasNextPage
      ? optionalStr(pageInfo.endCursor, "data.product.variants.pageInfo.endCursor")
      : null,
  };
}
