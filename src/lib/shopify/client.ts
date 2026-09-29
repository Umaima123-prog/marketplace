/**
 * Shopify Admin GraphQL client.
 *
 * Node's built-in fetch, no SDK. The whole surface this project needs is one
 * POST with three headers; an SDK would add a dependency, a version to track,
 * and its own opinion about retries that would have to be disabled to implement
 * the throttle handling below.
 *
 * Guarantees:
 *   - the access token is read from the environment and never logged, never
 *     returned in an error, never put in a URL;
 *   - the API version is pinned explicitly (env, validated at boot);
 *   - top-level GraphQL errors, throttling and transport failures are separated
 *     (see errors.ts) so callers retry only what a retry can fix;
 *   - `extensions.cost` is read on every response, so the client paces itself
 *     rather than discovering the limit by being rejected.
 */
import { shopifyEnv } from "../env";
import { logger, type Logger } from "../logger";

import { getAccessToken, invalidateAccessToken } from "./auth";
import { ShopifyError } from "./errors";
import {
  MAX_INLINE_THROTTLE_WAIT_MS,
  parseCost,
  throttleRetryDelayMs,
  waitForCostMs,
  backoffMs,
  type QueryCost,
} from "./throttle";

export interface GraphQLResponse<T> {
  data: T;
  cost: QueryCost | null;
}

interface RequestOptions {
  /** Operation name for logs. Never the query body -- it is long and noisy. */
  operation: string;
  variables?: Record<string, unknown>;
  log?: Logger;
  /** Attempts INSIDE one call, for throttle/transport blips. */
  maxAttempts?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The bucket state observed on the last successful response, used to pace the
 * NEXT request. Module-scoped because Shopify's cost bucket is per shop: two
 * concurrent page jobs in one worker share the same real budget, so they should
 * share the same view of it.
 *
 * This is per-process, so N worker processes still over-request by a factor of
 * N. A cross-process limiter is a known gap, recorded in ARCHITECTURE.
 */
let lastKnownCost: QueryCost | null = null;

export function getLastKnownCost(): QueryCost | null {
  return lastKnownCost;
}

/** Test seam: reset the shared pacing state between cases. */
export function __resetCostState(): void {
  lastKnownCost = null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function shopifyGraphQL<T>(
  query: string,
  options: RequestOptions,
): Promise<GraphQLResponse<T>> {
  const log = options.log ?? logger;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  // Resolved ONCE, outside the retry loop and outside the try/catch below.
  // Inside, a missing credential would be caught as a "transport failure" and
  // retried -- 3 times here, then 5 times by BullMQ, for a condition no retry
  // can fix. Configuration errors must be terminal and obvious.
  let url: string;
  try {
    const shopify = shopifyEnv();
    url = `https://${shopify.shopDomain}/admin/api/${shopify.apiVersion}/graphql.json`;
  } catch (cause) {
    throw new ShopifyError(
      `Shopify is not configured: ${cause instanceof Error ? cause.message : String(cause)}`,
      { kind: "auth", retryable: false, cause },
    );
  }

  // One 401 is allowed to mean "the token died earlier than advertised" -- the
  // client credentials grant issues expiring tokens, and a revoked or rotated
  // one looks identical. The cache is dropped and the call retried ONCE; a
  // second 401 is a real credential problem.
  let refreshedAfter401 = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Proactive pacing: if the previous response left the bucket too low for a
    // request of this size, wait before spending it.
    if (lastKnownCost) {
      const wait = waitForCostMs(lastKnownCost.throttleStatus, lastKnownCost.requestedQueryCost);
      if (wait > 0) {
        const capped = Math.min(wait, MAX_INLINE_THROTTLE_WAIT_MS);
        log.debug(
          { operation: options.operation, waitMs: capped, available: lastKnownCost.throttleStatus.currentlyAvailable },
          "pacing before shopify request",
        );
        await sleep(capped);
      }
    }

    // Acquired per attempt, so a retry after a 401 picks up the fresh token.
    // The token is a local, used once, in one header -- never logged, never in
    // a URL, never attached to an error.
    const accessToken = await getAccessToken(log);

    const started = Date.now();
    let response: Response;

    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          // The only place the token appears. Never logged, never echoed.
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables: options.variables ?? {} }),
        signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      const error = new ShopifyError(
        `transport failure calling Shopify: ${cause instanceof Error ? cause.message : String(cause)}`,
        { kind: "transport", retryable: true, cause },
      );
      if (attempt >= maxAttempts) throw error;
      const delay = backoffMs(attempt);
      log.warn(
        { operation: options.operation, attempt, delayMs: delay, ...error.toLogFields() },
        "shopify transport failure, retrying",
      );
      await sleep(delay);
      continue;
    }

    const durationMs = Date.now() - started;

    if (response.status === 401 && !refreshedAfter401 && attempt < maxAttempts) {
      // Expiring token, revoked token, or rotated credentials. Drop the cache
      // and try once with a freshly exchanged token.
      refreshedAfter401 = true;
      invalidateAccessToken();
      log.warn(
        { operation: options.operation, attempt, event: "shopify_token_refresh" },
        "Shopify returned 401; re-exchanging the access token and retrying once",
      );
      continue;
    }

    // A second 401, or any 403: the integration is broken, not this request.
    // 403 in particular is a missing scope, which no retry and no fresh token
    // can fix -- the app version's declared access has to change.
    if (response.status === 401 || response.status === 403) {
      throw new ShopifyError(
        response.status === 403
          ? "Shopify denied the request (403): the token lacks a required scope. " +
            "Scopes come from the app version's declared access, not from the token request."
          : "Shopify rejected the access token (401) even after re-exchanging it",
        { kind: "auth", retryable: false, status: response.status },
      );
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? "1") * 1000;
      const delay = Math.min(Math.max(retryAfter, 250), MAX_INLINE_THROTTLE_WAIT_MS);
      if (attempt >= maxAttempts) {
        throw new ShopifyError("Shopify returned 429 after retrying", {
          kind: "throttled",
          retryable: true,
          status: 429,
          retryAfterMs: delay,
        });
      }
      log.warn({ operation: options.operation, attempt, delayMs: delay }, "shopify 429, retrying");
      await sleep(delay);
      continue;
    }

    if (!response.ok) {
      const error = new ShopifyError(`Shopify returned HTTP ${response.status}`, {
        kind: "transport",
        retryable: response.status >= 500,
        status: response.status,
      });
      if (!error.retryable || attempt >= maxAttempts) throw error;
      const delay = backoffMs(attempt);
      log.warn(
        { operation: options.operation, attempt, delayMs: delay, ...error.toLogFields() },
        "shopify http error, retrying",
      );
      await sleep(delay);
      continue;
    }

    const body = (await response.json()) as {
      data?: T;
      errors?: Array<{ message?: string; extensions?: { code?: string } }>;
      extensions?: unknown;
    };

    const cost = parseCost(body.extensions);
    if (cost) lastKnownCost = cost;

    if (body.errors && body.errors.length > 0) {
      const codes = body.errors.map((e) => e.extensions?.code).filter(Boolean) as string[];
      const throttled = codes.includes("THROTTLED");
      const message = body.errors[0]?.message ?? "unknown GraphQL error";

      if (throttled) {
        const delay = throttleRetryDelayMs(cost, cost?.requestedQueryCost ?? 0);
        if (attempt >= maxAttempts) {
          throw new ShopifyError("Shopify THROTTLED after retrying", {
            kind: "throttled",
            retryable: true,
            code: "THROTTLED",
            retryAfterMs: delay,
          });
        }
        log.warn(
          {
            operation: options.operation,
            attempt,
            delayMs: delay,
            available: cost?.throttleStatus.currentlyAvailable,
            restoreRate: cost?.throttleStatus.restoreRate,
          },
          "shopify throttled, waiting for bucket to refill",
        );
        await sleep(delay);
        continue;
      }

      // Anything else at the top level is a query, permission or token problem.
      // No retry can fix a malformed query or a missing scope.
      throw new ShopifyError(`Shopify GraphQL error: ${message}`, {
        kind: codes.some((c) => c === "ACCESS_DENIED" || c === "UNAUTHORIZED") ? "auth" : "graphql",
        retryable: false,
        code: codes[0],
      });
    }

    if (!body.data) {
      throw new ShopifyError("Shopify returned no data and no errors", {
        kind: "graphql",
        retryable: false,
      });
    }

    log.debug(
      {
        operation: options.operation,
        durationMs,
        requestedCost: cost?.requestedQueryCost,
        actualCost: cost?.actualQueryCost,
        available: cost?.throttleStatus.currentlyAvailable,
      },
      "shopify request complete",
    );

    return { data: body.data, cost };
  }

  // Unreachable: every path above either returns or throws on the last attempt.
  throw new ShopifyError("exhausted Shopify request attempts", {
    kind: "transport",
    retryable: true,
  });
}
