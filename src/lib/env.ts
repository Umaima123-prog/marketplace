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
    /**
     * Shopify page sizes. The DEFAULTS are the production values (50 products x
     * 100 variants, see ARCHITECTURE 3.3); the override exists so a page size
     * can be lowered for a controlled run -- a 17-product catalog needs a page
     * size of 5 before cursor pagination is observable at all -- and so it can
     * be tuned from the requestedCost/availableCost figures the page log emits.
     */
    shopifyProductsPerPage: integer("SHOPIFY_PRODUCTS_PER_PAGE", 50, 1),
    shopifyVariantsPerPage: integer("SHOPIFY_VARIANTS_PER_PAGE", 100, 1),
    productSyncIntervalMinutes: integer("PRODUCT_SYNC_INTERVAL_MINUTES", 15, 1),
    /**
     * Budget for ONE product page's write transaction, and how long to wait for
     * a pool connection to start it.
     *
     * Sized from latency, not taste. The transaction is a few hundred SEQUENTIAL
     * statements -- per product: a read, an upsert, an image reconcile, an image
     * index read and a variant sweep; per variant: a read and an upsert -- so its
     * duration is dominated by round trips, not by server work.
     *
     * Measured against the production MySQL over Railway's public TCP proxy:
     * ~370 ms mean per statement (p95 ~711 ms), versus ~1 ms on a local socket.
     * A 27-product page is ~280 statements, so ~103 s remotely and well under a
     * second locally. The previous hard-coded 60 s therefore held locally and
     * expired in production, after which Prisma rejects the next statement with
     * "Transaction not found" -- the error surfaces wherever the transaction
     * happens to be, which is why it was seen in `reconcileImages`.
     *
     * 240 s covers a full 50-product page at the measured mean with headroom.
     * This is NOT a global timeout: it is passed to the one `$transaction` call
     * in the page processor. Lower `SHOPIFY_PRODUCTS_PER_PAGE` to make each
     * transaction shorter instead of allowing a longer one.
     */
    syncPageTransactionTimeoutMs: integer("SYNC_PAGE_TRANSACTION_TIMEOUT_MS", 240_000, 1_000),
    /**
     * Pool wait for that transaction. A cold connection to the remote database
     * measured 3.3 s (TCP + auth), so the old 15 s was adequate; 30 s simply
     * stops a transient pool contention from failing a sync run.
     */
    syncPageTransactionMaxWaitMs: integer("SYNC_PAGE_TRANSACTION_MAX_WAIT_MS", 30_000, 1_000),
    /**
     * How long a worker's claim on an order is believed.
     *
     * A SYNCING row whose `claimedAt` is older than this belonged to a worker
     * that died, and may be reclaimed. It must comfortably exceed the worst-case
     * submission -- two Shopify round trips plus retries -- or a healthy slow
     * job gets reclaimed underneath itself and the order is submitted twice.
     * BullMQ's own lockDuration is 120s, so 300s leaves real headroom.
     */
    orderClaimLeaseSeconds: integer("ORDER_CLAIM_LEASE_SECONDS", 300, 60),
    /**
     * How old a PENDING_SYNC order must be before the recovery sweep re-enqueues
     * it. Long enough that an order committed microseconds ago -- whose enqueue
     * is still in flight -- is never swept.
     */
    orderRecoveryGraceSeconds: integer("ORDER_RECOVERY_GRACE_SECONDS", 120, 30),
    /** How often the recovery sweep runs. */
    orderRecoveryIntervalMinutes: integer("ORDER_RECOVERY_INTERVAL_MINUTES", 5, 1),
    /**
     * The order recovery sweep, with its OWN switch rather than sharing
     * SYNC_SCHEDULERS_ENABLED.
     *
     * That flag exists to give a controlled catalog-sync run a quiet worker.
     * Order recovery is a different kind of thing: with it off, an order whose
     * enqueue was lost waits for a human to notice, and a customer waits for a
     * delivery that was never sent. Conflating the two would mean turning off
     * sync noise silently turns off the outbox drain. Default true, and there is
     * no good reason to set it false outside a test.
     */
    orderRecoveryEnabled: (process.env.ORDER_RECOVERY_ENABLED?.trim() ?? "true") !== "false",
    /**
     * How "this order is unpaid, collect cash on delivery" is expressed to
     * Shopify. Two mechanisms exist on API 2026-07 and neither is unconditionally
     * available:
     *
     *   "payment_pending" (DEFAULT) - `draftOrderComplete(paymentPending: true)`.
     *       Deprecated in favour of payment terms, but present, functional, needs
     *       no extra permission, and means precisely "the payment is pending".
     *
     *   "payment_terms"             - payment terms on the draft, which is the
     *       non-deprecated path. Requires a permission this app does not have:
     *       `draftOrderCreate` refuses with "The user must have access to set
     *       payment terms." Notably `draftOrderCalculate` accepts the same input,
     *       so the input shape validating proves nothing about this.
     *
     * The default is the one that works. Switch to "payment_terms" once the
     * permission is granted -- that is the whole migration.
     */
    codPaymentMode:
      process.env.SHOPIFY_COD_PAYMENT_MODE?.trim() === "payment_terms"
        ? ("payment_terms" as const)
        : ("payment_pending" as const),
    /**
     * Repeatable jobs are registered by the worker at boot. Set false to run a
     * worker that only processes what is explicitly enqueued -- used for a
     * controlled first run or a one-off reprocess, where a scheduled sync
     * firing at boot would race the run being observed. Default true.
     */
    syncSchedulersEnabled: (process.env.SYNC_SCHEDULERS_ENABLED?.trim() ?? "true") !== "false",
    logLevel: process.env.LOG_LEVEL?.trim() || "info",
    nodeEnv: process.env.NODE_ENV ?? "development",
  })),
);

// ---------------------------------------------------------------------------
// shopify: worker only, validated on first use
// ---------------------------------------------------------------------------

export interface ShopifyEnv {
  shopDomain: string;
  apiVersion: string;
  /** Client credentials grant -- the primary mechanism. */
  clientId: string;
  clientSecret: string;
  /**
   * Optional. An admin-created custom app has a permanent, pre-generated token
   * and needs no exchange; when this is set it short-circuits the grant.
   */
  accessToken: string;
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

    // Two valid configurations, and at least one must be complete:
    //   client credentials  -- SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
    //   custom app token    -- SHOPIFY_ADMIN_ACCESS_TOKEN
    // Checked here rather than at the call site so a half-configured app fails
    // at startup with a readable message instead of at the first API call.
    const clientId = process.env.SHOPIFY_CLIENT_ID?.trim() ?? "";
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim() ?? "";
    const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim() ?? "";
    const hasClientCredentials = clientId.length > 0 && clientSecret.length > 0;

    // Half-configured cases first: "you set one of the pair" is a far more
    // useful message than "set one of two mechanisms", and the generic message
    // would otherwise swallow it.
    if (clientId.length > 0 && clientSecret.length === 0) {
      problems.push("SHOPIFY_CLIENT_SECRET is required when SHOPIFY_CLIENT_ID is set");
    } else if (clientSecret.length > 0 && clientId.length === 0) {
      problems.push("SHOPIFY_CLIENT_ID is required when SHOPIFY_CLIENT_SECRET is set");
    } else if (!hasClientCredentials && accessToken.length === 0) {
      problems.push(
        "set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (client credentials grant), " +
          "or SHOPIFY_ADMIN_ACCESS_TOKEN (admin-created custom app)",
      );
    }

    return {
      shopDomain: shopDomain.toLowerCase(),
      apiVersion,
      clientId,
      clientSecret,
      accessToken,
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
    ...(shopify
      ? {
          shopDomain: shopify.shopDomain,
          shopifyApiVersion: shopify.apiVersion,
          // Which mechanism is in use, never the credential itself.
          shopifyAuth: shopify.accessToken ? "static-token" : "client-credentials",
        }
      : {}),
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
