/**
 * Environment configuration, validated at the point of use.
 *
 * Split deliberately into two tiers:
 *
 *   `env`         - what every process needs (database, Redis, timings).
 *                   Validated at module load: a missing DATABASE_URL should stop
 *                   the process, not surface as a connection error later.
 *
 *   `shopifyEnv()`- validated on FIRST USE, not at import.
 *
 * The web process never calls Shopify (ARCHITECTURE §2: the storefront reads
 * MySQL, the worker owns the integration), so requiring a Shopify token to boot
 * Next would be enforcing the opposite of the intended boundary -- and it would
 * mean a build machine needs a production credential to run `next build`.
 * Reaching for a Shopify credential in the web process now fails loudly, which
 * is the correct outcome.
 *
 * Nothing here is logged. `describeEnv()` exists so a startup line can state
 * what the process points at without printing a credential.
 */

class EnvError extends Error {
  constructor(problems: string[]) {
    super(
      `Invalid environment (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
    this.name = "EnvError";
  }
}

function collect<T>(build: (require: (name: string) => string, problems: string[]) => T): T {
  const problems: string[] = [];
  const required = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) {
      problems.push(`${name} is required but missing or empty`);
      return "";
    }
    return value;
  };
  const result = build(required, problems);
  if (problems.length > 0) throw new EnvError(problems);
  return result;
}

function integer(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  return parsed;
}

// ---------------------------------------------------------------------------
// core: every process
// ---------------------------------------------------------------------------

export const env = Object.freeze(
  collect((required) => ({
    databaseUrl: required("DATABASE_URL"),
    redisUrl: required("REDIS_URL"),
    syncHeartbeatStaleSeconds: integer("SYNC_HEARTBEAT_STALE_SECONDS", 600, 60),
    productSyncIntervalMinutes: integer("PRODUCT_SYNC_INTERVAL_MINUTES", 15, 1),
    logLevel: process.env.LOG_LEVEL?.trim() || "info",
    nodeEnv: process.env.NODE_ENV ?? "development",
  })),
);

// ---------------------------------------------------------------------------
// shopify: worker only, validated on first use
// ---------------------------------------------------------------------------

export interface ShopifyEnv {
  shopDomain: string;
  accessToken: string;
  apiVersion: string;
}

let shopifyCache: ShopifyEnv | undefined;

export function shopifyEnv(): ShopifyEnv {
  if (shopifyCache) return shopifyCache;

  shopifyCache = collect((required, problems) => {
    const shopDomain = required("SHOPIFY_SHOP_DOMAIN");
    // A wrong domain 404s from an unrelated host, which is a confusing way to
    // learn that an environment variable has a typo.
    if (shopDomain && !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shopDomain)) {
      problems.push(`SHOPIFY_SHOP_DOMAIN must look like "your-store.myshopify.com"`);
    }

    const apiVersion = required("SHOPIFY_API_VERSION");
    // Quarterly, YYYY-MM. Pinned explicitly -- never "latest", never unset.
    if (apiVersion && !/^\d{4}-\d{2}$/.test(apiVersion)) {
      problems.push(`SHOPIFY_API_VERSION must be a pinned version like "2026-07"`);
    }

    return {
      shopDomain: shopDomain.toLowerCase(),
      accessToken: required("SHOPIFY_ADMIN_ACCESS_TOKEN"),
      apiVersion,
    };
  });

  return shopifyCache;
}

/** True when Shopify credentials are present, without throwing. */
export function hasShopifyEnv(): boolean {
  try {
    shopifyEnv();
    return true;
  } catch {
    return false;
  }
}

/** Test seam. */
export function __resetShopifyEnv(): void {
  shopifyCache = undefined;
}

/** Safe for a startup log line: identifies the targets, reveals no credential. */
export function describeEnv(): Record<string, string | number | boolean> {
  const shopify = hasShopifyEnv() ? shopifyEnv() : null;
  return {
    nodeEnv: env.nodeEnv,
    // Host and database only -- the password lives in the same string.
    database: safeUrlTarget(env.databaseUrl),
    redis: safeUrlTarget(env.redisUrl),
    syncIntervalMinutes: env.productSyncIntervalMinutes,
    heartbeatStaleSeconds: env.syncHeartbeatStaleSeconds,
    shopifyConfigured: shopify !== null,
    ...(shopify ? { shopDomain: shopify.shopDomain, shopifyApiVersion: shopify.apiVersion } : {}),
  };
}

function safeUrlTarget(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}:${url.port || "default"}${url.pathname}`;
  } catch {
    return "(unparseable)";
  }
}
