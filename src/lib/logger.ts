/**
 * The single logger. `console.log` is banned project-wide (see ARCHITECTURE §8);
 * everything goes through here so that redaction is not optional.
 *
 * Structured JSON on stdout. No pretty-printer, no transport: a transport is a
 * second process whose failure modes are the logger's failure modes, and
 * `docker compose logs | jq` is enough locally.
 */
import pino from "pino";

import { env } from "./env";

/**
 * Redaction is defence in depth, not the primary control -- the primary control
 * is not putting secrets in log calls. These paths cover the ways a secret
 * reaches a logger by accident: someone logs an error with `err.config`, or
 * spreads a request object, or logs a whole order row while debugging.
 *
 * `censor` is a fixed string rather than removal so the shape of the object is
 * preserved in the output; a missing key looks like a code path that did not run.
 */
export const REDACT_PATHS = [
  // Shopify credentials, however they are nested.
  "token",
  "accessToken",
  "*.token",
  "*.accessToken",
  "headers.authorization",
  "headers['X-Shopify-Access-Token']",
  "headers['x-shopify-access-token']",
  "*.headers.authorization",
  "*.headers['X-Shopify-Access-Token']",
  "*.headers['x-shopify-access-token']",
  "password",
  "*.password",
  "secret",
  "*.secret",
  // Customer PII. Checkout logs an order id, an item count and a duration and
  // nothing else (ARCHITECTURE §8) -- these paths are the backstop for the day
  // someone logs a whole Order row while debugging. The delivery address is
  // covered field by field, including the parts that look harmless alone: a city
  // plus a postal code plus a name identifies a household.
  "customerName",
  "customerPhone",
  "customerEmail",
  "customerNote",
  "addressLine1",
  "addressLine2",
  "city",
  "province",
  "postalCode",
  "*.customerName",
  "*.customerPhone",
  "*.customerEmail",
  "*.customerNote",
  "*.addressLine1",
  "*.addressLine2",
  "*.city",
  "*.province",
  "*.postalCode",
];

/**
 * Synchronous writes.
 *
 * pino buffers asynchronously by default, which is faster and fine for a
 * long-lived server whose process exits cleanly. It is wrong here: a worker
 * killed mid-run (a deploy, a crash, an operator with SIGKILL) discards the
 * buffer, and the log of what it was doing when it died -- the single most
 * useful log there is -- vanishes. Observed: a completed sync whose page-level
 * lines were lost while the run sat COMPLETED in MySQL.
 *
 * The durable record is still JobLog in the database; this just stops the
 * narrative log from lying by omission.
 */
const destination = pino.destination({ sync: true });

export const logger = pino({
  level: env.logLevel,
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  // No `service` here: every caller binds it with `.child({ service })`.
  // Setting it in both places emits the key twice in one JSON line, which is
  // legal JSON that every log pipeline resolves differently.
  base: undefined,
  // ISO timestamps: log aggregation and a human reading `docker logs` both want
  // the same field, and epoch millis satisfy neither.
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
}, destination);

export type Logger = pino.Logger;

/**
 * A child logger bound to one job attempt. Every line a processor emits carries
 * the same identifying fields, which is what makes the logs greppable per job
 * rather than per message.
 */
export function jobLogger(fields: {
  queue: string;
  jobName: string;
  jobId: string;
  attempt: number;
  syncRunId?: string;
  productGid?: string;
}): Logger {
  return logger.child(fields);
}

/**
 * Error serialisation for a log line.
 *
 * The stack is included deliberately -- requirement: "error + stack on failure".
 * The message is NOT trusted to be secret-free (an HTTP client may embed a URL
 * with a token in it), so it passes through the same redaction as everything
 * else by virtue of being logged as a field rather than interpolated.
 */
export function errorFields(error: unknown): {
  errorClass: string;
  errorMessage: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      errorClass: error.name || error.constructor.name,
      errorMessage: error.message,
      stack: error.stack,
    };
  }
  return { errorClass: typeof error, errorMessage: String(error) };
}
