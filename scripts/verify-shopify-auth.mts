/**
 * Minimal authenticated Shopify check.
 *
 *   npm run verify:shopify
 *
 * Exchanges the app credentials for an access token and runs one query --
 * `shop { name }`. Nothing else: this is a connectivity and authorization
 * check, not a sync.
 *
 * Prints the shop name, the granted scopes and the token lifetime. It never
 * prints the access token or the client secret, and the client never puts
 * either in a log line or an error.
 */
import { describeToken } from "@/src/lib/shopify/auth";
import { shopifyGraphQL } from "@/src/lib/shopify/client";
import { shopifyEnv } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";

const log = logger.child({ service: "verify-shopify" });

const SHOP_QUERY = /* GraphQL */ `
  query VerifyAuth {
    shop {
      name
      myshopifyDomain
      currencyCode
      plan {
        displayName
      }
    }
  }
`;

interface ShopResult {
  shop: {
    name: string;
    myshopifyDomain: string;
    currencyCode: string;
    plan: { displayName: string } | null;
  };
}

async function main(): Promise<void> {
  const env = shopifyEnv();
  log.info(
    {
      shopDomain: env.shopDomain,
      apiVersion: env.apiVersion,
      mechanism: env.accessToken ? "static-token" : "client-credentials",
    },
    "verifying Shopify authentication",
  );

  const { data, cost } = await shopifyGraphQL<ShopResult>(SHOP_QUERY, {
    operation: "VerifyAuth",
    log,
  });

  const token = describeToken();

  log.info(
    {
      shopName: data.shop.name,
      myshopifyDomain: data.shop.myshopifyDomain,
      currencyCode: data.shop.currencyCode,
      plan: data.shop.plan?.displayName ?? null,
      tokenSource: token.source,
      tokenValidForSeconds: token.expiresInSeconds,
      grantedScopes: token.scope,
      requestedCost: cost?.requestedQueryCost ?? null,
      availableCost: cost?.throttleStatus.currentlyAvailable ?? null,
      event: "shopify_auth_verified",
    },
    "authenticated successfully",
  );
}

main().catch((error: unknown) => {
  log.error(
    {
      errorClass: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      ...(typeof error === "object" && error !== null && "kind" in error
        ? { kind: (error as { kind?: unknown }).kind, status: (error as { status?: unknown }).status }
        : {}),
      event: "shopify_auth_failed",
    },
    "authentication failed",
  );
  process.exit(1);
});
