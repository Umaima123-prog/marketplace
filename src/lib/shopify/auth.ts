/**
 * Shopify Admin API authentication.
 *
 * All token acquisition lives here. The GraphQL client asks for a token and
 * never learns where it came from, so there is exactly one place that touches
 * the client secret and exactly one place to audit.
 *
 * Primary mechanism: the **client credentials grant**. The app exchanges its own
 * client id and secret for an Admin API access token with no merchant
 * interaction -- the right shape for a server-side integration acting on its
 * own store. Shopify issues a token valid for `expires_in` seconds (currently
 * 86399, i.e. 24 hours), so unlike a permanent `shpat_` token it must be
 * re-requested.
 *
 *   POST https://{shop}/admin/oauth/access_token
 *   Content-Type: application/x-www-form-urlencoded
 *   grant_type=client_credentials&client_id=...&client_secret=...
 *   -> { access_token, scope, expires_in }
 *
 * The grant requests no scopes: what comes back is a readback of what the app
 * version declares. A scope problem therefore shows up as a GraphQL
 * ACCESS_DENIED later, not as a failure here -- which is why the granted scope
 * string is logged (it is not a secret) while the token never is.
 *
 * An optional `SHOPIFY_ADMIN_ACCESS_TOKEN` still short-circuits all of this, for
 * an admin-created custom app whose token is permanent and pre-generated.
 */
import { shopifyEnv } from "../env";
import { logger, type Logger } from "../logger";

import { ShopifyError } from "./errors";

interface TokenResponse {
  access_token: string;
  scope?: string;
  expires_in?: number;
}

export interface CachedToken {
  token: string;
  /** Epoch ms after which this token must not be used. */
  expiresAtMs: number;
  scope: string | null;
}

/**
 * Refresh this long before the stated expiry.
 *
 * A token that expires mid-flight fails a page job that has already spent a
 * Shopify round trip and opened a transaction. Five minutes of a 24-hour
 * lifetime costs nothing and removes the class of failure entirely.
 */
export const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/**
 * When Shopify omits `expires_in`, assume a short life rather than a long one:
 * guessing high would mean using a dead token, guessing low costs one extra
 * exchange per hour.
 */
const FALLBACK_LIFETIME_MS = 60 * 60 * 1000;

/** Pure: when does a token obtained now stop being usable? */
export function expiryFromResponse(
  expiresInSeconds: number | undefined,
  nowMs: number,
  skewMs: number = EXPIRY_SKEW_MS,
): number {
  const lifetimeMs =
    typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? expiresInSeconds * 1000
      : FALLBACK_LIFETIME_MS;

  // Never return an expiry in the past, however small the lifetime Shopify
  // reports -- that would make every request re-exchange in a tight loop.
  return nowMs + Math.max(lifetimeMs - skewMs, Math.min(lifetimeMs, 30_000));
}

/** Pure: is this cache entry still usable? */
export function isUsable(entry: CachedToken | null, nowMs: number): entry is CachedToken {
  return entry !== null && entry.expiresAtMs > nowMs;
}

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

let cached: CachedToken | null = null;

/**
 * Concurrent callers share one exchange.
 *
 * Three page workers starting together would otherwise each notice the missing
 * token and each POST for one. Shopify would honour all three, but two are
 * wasted and the last write wins the cache anyway.
 */
let inFlight: Promise<CachedToken> | null = null;

/** Drops the cached token, so the next call re-exchanges. */
export function invalidateAccessToken(): void {
  cached = null;
}

/** Test seam. */
export function __resetAuthState(): void {
  cached = null;
  inFlight = null;
}

/** Non-secret view of the cache, for diagnostics and logging. */
export function describeToken(): {
  source: "static" | "client_credentials" | "none";
  expiresInSeconds: number | null;
  scope: string | null;
} {
  const { accessToken } = shopifyEnv();
  if (accessToken) return { source: "static", expiresInSeconds: null, scope: null };
  if (!cached) return { source: "none", expiresInSeconds: null, scope: null };
  return {
    source: "client_credentials",
    expiresInSeconds: Math.max(0, Math.round((cached.expiresAtMs - Date.now()) / 1000)),
    scope: cached.scope,
  };
}

// ---------------------------------------------------------------------------
// acquisition
// ---------------------------------------------------------------------------

/**
 * The access token for an Admin API call.
 *
 * Returns a cached token while it is still valid, otherwise exchanges the app
 * credentials for a fresh one.
 */
export async function getAccessToken(log: Logger = logger): Promise<string> {
  const env = shopifyEnv();

  // An admin-created custom app has a permanent, pre-generated token and needs
  // no exchange at all.
  if (env.accessToken) return env.accessToken;

  const now = Date.now();
  if (isUsable(cached, now)) return cached.token;

  inFlight ??= exchangeClientCredentials(log).finally(() => {
    inFlight = null;
  });

  const fresh = await inFlight;
  return fresh.token;
}

async function exchangeClientCredentials(log: Logger): Promise<CachedToken> {
  const env = shopifyEnv();

  if (!env.clientId || !env.clientSecret) {
    throw new ShopifyError(
      "Shopify is not configured: set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET " +
        "(or SHOPIFY_ADMIN_ACCESS_TOKEN for an admin-created custom app)",
      { kind: "auth", retryable: false },
    );
  }

  const url = `https://${env.shopDomain}/admin/oauth/access_token`;

  // Form-encoded, as the grant requires. The body carries the secret, so it is
  // never logged and never included in an error.
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.clientId,
    client_secret: env.clientSecret,
  });

  const started = Date.now();
  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    // Reaching the token endpoint is a network problem, not a credential
    // problem, so this one IS retryable.
    throw new ShopifyError(
      `could not reach Shopify's token endpoint: ${cause instanceof Error ? cause.message : String(cause)}`,
      { kind: "transport", retryable: true, cause },
    );
  }

  if (!response.ok) {
    // Shopify answers 400/401 with a small JSON body. It describes the
    // credentials, never contains them, but only the error code is surfaced.
    const detail = await safeErrorDetail(response);
    throw new ShopifyError(
      `Shopify refused the client credentials grant (HTTP ${response.status}${detail ? `: ${detail}` : ""}). ` +
        "Check SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET, and that the app and the store " +
        "belong to the same Shopify organization.",
      { kind: "auth", retryable: false, status: response.status },
    );
  }

  const payload = (await response.json()) as Partial<TokenResponse>;

  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new ShopifyError("Shopify returned no access_token", {
      kind: "auth",
      retryable: false,
      status: response.status,
    });
  }

  const entry: CachedToken = {
    token: payload.access_token,
    expiresAtMs: expiryFromResponse(payload.expires_in, Date.now()),
    scope: typeof payload.scope === "string" ? payload.scope : null,
  };

  cached = entry;

  // The granted scope string is not a secret and is the single most useful
  // thing to have in the log when a later call returns ACCESS_DENIED.
  log.info(
    {
      shopDomain: env.shopDomain,
      grant: "client_credentials",
      expiresInSeconds: payload.expires_in ?? null,
      usableForSeconds: Math.round((entry.expiresAtMs - Date.now()) / 1000),
      scope: entry.scope,
      durationMs: Date.now() - started,
      event: "shopify_token_acquired",
    },
    "acquired a Shopify access token",
  );

  return entry;
}

/** Reads an error body defensively; returns only Shopify's error code. */
async function safeErrorDetail(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const code = record.error ?? record.errors;
      if (typeof code === "string") return code;
    }
    return null;
  } catch {
    return null;
  }
}
