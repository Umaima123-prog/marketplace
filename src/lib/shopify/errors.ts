/**
 * The Shopify failure taxonomy (ARCHITECTURE §7), as types.
 *
 * Three failure surfaces are routinely conflated, and conflating them is how an
 * integration ends up retrying a permanently invalid request 8 times:
 *
 *   transport   - the HTTP call did not produce a GraphQL body (5xx, socket
 *                 reset, 429). Retryable.
 *   top-level   - HTTP 200 with an `errors` array. Retryable ONLY when the code
 *                 is THROTTLED; everything else is a malformed query, a missing
 *                 scope, or a revoked token, and a retry cannot fix any of them.
 *   userErrors  - HTTP 200, valid query, and the mutation refused. NEVER
 *                 retryable. (No mutations in this phase; the type exists so the
 *                 order submission phase inherits the taxonomy rather than
 *                 inventing a second one.)
 */

export type ShopifyErrorKind = "transport" | "throttled" | "graphql" | "auth" | "user";

export class ShopifyError extends Error {
  readonly kind: ShopifyErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  /** Shopify's `errors[].extensions.code`, when present. */
  readonly code?: string;
  /** Seconds to wait before retrying, when the throttle state tells us. */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: {
      kind: ShopifyErrorKind;
      retryable: boolean;
      status?: number;
      code?: string;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "ShopifyError";
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.status = options.status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
  }

  /** Fields safe to log: no token, no request body, no customer data. */
  toLogFields(): Record<string, unknown> {
    return {
      errorClass: this.name,
      kind: this.kind,
      retryable: this.retryable,
      status: this.status,
      code: this.code,
      retryAfterMs: this.retryAfterMs,
      errorMessage: this.message,
    };
  }
}

export function isShopifyError(error: unknown): error is ShopifyError {
  return error instanceof ShopifyError;
}

/**
 * Whether BullMQ should be allowed to retry this failure.
 *
 * An auth failure is deliberately terminal: the integration is down, not the
 * job. Retrying it 5 times per page across 400 pages turns one broken token
 * into 2,000 useless calls and a log nobody can read.
 */
export function shouldRetry(error: unknown): boolean {
  if (isShopifyError(error)) return error.retryable;
  // Unknown failures (a MySQL deadlock, a socket hang-up inside Prisma) are
  // treated as transient. The attempt cap is what stops this being infinite.
  return true;
}
