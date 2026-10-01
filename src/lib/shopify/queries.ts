/**
 * The two queries this phase needs, with explicit field selections.
 *
 * Page sizes follow ARCHITECTURE §3.3: products 50 x variants 100. Calculated
 * cost is multiplicative on nested connections, so `products(250) {
 * variants(250) }` is ~62,500 nodes of requested cost and gets throttled
 * immediately. 50x100 covers the overwhelming majority of products in one round
 * trip and leaves the bucket healthy.
 */

import { env } from "../env";

/**
 * Defaults are the production values; both are overridable by environment so a
 * controlled run can make pagination observable without shipping a smaller page
 * size. See src/lib/env.ts.
 */
export const PRODUCTS_PER_PAGE = env.shopifyProductsPerPage;
export const VARIANTS_PER_PAGE = env.shopifyVariantsPerPage;
export const IMAGES_PER_PRODUCT = 50;

/**
 * One page of products with variants and images inline.
 *
 * `sortKey: ID` with a stable cursor: an `UPDATED_AT` sort would reorder rows
 * mid-walk as Shopify mutates them, which can skip a product entirely between
 * two pages. ID order does not change.
 *
 * `query` is optional and used only for INCREMENTAL runs
 * (`updated_at:>=<iso>`); a FULL run passes null and walks everything.
 */
export const PRODUCTS_PAGE_QUERY = /* GraphQL */ `
  query ProductsPage($first: Int!, $after: String, $query: String, $variantsFirst: Int!, $imagesFirst: Int!) {
    products(first: $first, after: $after, query: $query, sortKey: ID) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        legacyResourceId
        title
        handle
        descriptionHtml
        vendor
        productType
        status
        publishedAt
        updatedAt
        options {
          id
          name
          position
          values
        }
        media(first: $imagesFirst) {
          nodes {
            ... on MediaImage {
              id
              image {
                url
                altText
              }
            }
          }
        }
        variants(first: $variantsFirst) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            sku
            position
            price
            compareAtPrice
            inventoryQuantity
            inventoryPolicy
            updatedAt
            selectedOptions {
              name
              value
            }
            inventoryItem {
              tracked
            }
            # The variant's own assigned image. ProductVariant.image is
            # DEPRECATED on 2026-07 -- the schema says "Use media instead" -- so
            # this reads the media connection and takes the first entry;
            # Shopify's admin assigns one image per variant.
            #
            # Only the id is selected. It is a MediaImage GID drawn from the
            # product's OWN media set (verified live against the store, 8/8), and
            # the product media selection above already stores that id with its
            # URL. Selecting the URL again would put it on the wire twice and
            # invite two sources of truth for one image.
            media(first: 1) {
              nodes {
                ... on MediaImage {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Continuation for a product whose variant connection exceeded one page.
 *
 * Deliberately NOT a second `products` query filtered to one id: `product(id:)`
 * plus a variants page is a single node lookup, far cheaper in calculated cost.
 */
export const PRODUCT_VARIANTS_PAGE_QUERY = /* GraphQL */ `
  query ProductVariantsPage($productId: ID!, $first: Int!, $after: String) {
    product(id: $productId) {
      id
      updatedAt
      variants(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          title
          sku
          position
          price
          compareAtPrice
          inventoryQuantity
          inventoryPolicy
          updatedAt
          selectedOptions {
            name
            value
          }
          inventoryItem {
            tracked
          }
          # As above. The continuation query needs it too, or a product with more
          # than one variant page would map images for page 1 only.
          media(first: 1) {
            nodes {
              ... on MediaImage {
                id
              }
            }
          }
        }
      }
    }
  }
`;

/** The shop's currency. Variants carry amounts, not currency codes. */
export const SHOP_CURRENCY_QUERY = /* GraphQL */ `
  query ShopCurrency {
    shop {
      currencyCode
    }
  }
`;
