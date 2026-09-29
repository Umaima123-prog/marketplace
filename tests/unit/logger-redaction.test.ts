/**
 * Log redaction, exercised rather than asserted.
 *
 * Redaction is defence in depth: the primary control is not putting a customer's
 * details into a log call in the first place, and the checkout code logs an order
 * id, an item count and a duration. This is the backstop for the day somebody logs
 * a whole Order row while debugging a failing submission -- at which point a
 * delivery address would otherwise be sitting in `docker logs` forever.
 *
 * The real logger writes to stdout, so these tests build a pino instance with the
 * same redaction configuration over a capturing stream.
 */
import pino from "pino";
import { describe, expect, it } from "vitest";

import { REDACT_PATHS } from "@/src/lib/logger";

function captureLog(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  const log = pino(
    { redact: { paths: REDACT_PATHS, censor: "[redacted]" }, base: undefined },
    { write: (line: string) => lines.push(line) },
  );
  log.info(payload, "test");
  return lines.join("");
}

describe("log redaction: customer PII", () => {
  it("censors every field of a logged order row", () => {
    const line = captureLog({
      orderId: "cm4order1",
      customerName: "Ayesha Khan",
      customerPhone: "+923001234567",
      customerEmail: "ayesha@example.com",
      addressLine1: "12 Jinnah Road",
      addressLine2: "Flat 4",
      city: "Lahore",
      province: "Punjab",
      postalCode: "54000",
      customerNote: "Call on arrival",
    });

    for (const secret of [
      "Ayesha Khan",
      "+923001234567",
      "ayesha@example.com",
      "12 Jinnah Road",
      "Flat 4",
      "Lahore",
      "Punjab",
      "54000",
      "Call on arrival",
    ]) {
      expect(line).not.toContain(secret);
    }

    // The identifiers that make a log useful survive.
    expect(line).toContain("cm4order1");
  });

  it("censors PII nested one level down, which is how it usually arrives", () => {
    const line = captureLog({
      event: "order_created",
      order: { customerName: "Ayesha Khan", city: "Lahore", customerPhone: "+923001234567" },
    });

    expect(line).not.toContain("Ayesha Khan");
    expect(line).not.toContain("Lahore");
    expect(line).not.toContain("+923001234567");
    expect(line).toContain("order_created");
  });
});

describe("log redaction: credentials", () => {
  it("censors tokens, secrets and passwords", () => {
    const line = captureLog({
      token: "shpat-not-a-real-token",
      accessToken: "shpat-also-not-real",
      secret: "client-secret-value",
      password: "database-password-value",
      shopify: { token: "nested-token-value" },
    });

    for (const secret of [
      "shpat-not-a-real-token",
      "shpat-also-not-real",
      "client-secret-value",
      "database-password-value",
      "nested-token-value",
    ]) {
      expect(line).not.toContain(secret);
    }
  });

  it("censors an Authorization header carried along by an error object", () => {
    const line = captureLog({ headers: { authorization: "Bearer not-a-real-token" } });
    expect(line).not.toContain("not-a-real-token");
  });
});

describe("log redaction: what is allowed through", () => {
  it("keeps the fields structured logs are for", () => {
    const line = captureLog({
      event: "order_created",
      orderId: "cm4order1",
      jobId: "order--cm4order1",
      itemCount: 3,
      status: "PENDING_SYNC",
      durationMs: 42,
    });

    expect(line).toContain("cm4order1");
    expect(line).toContain("order--cm4order1");
    expect(line).toContain('"itemCount":3');
    expect(line).toContain("PENDING_SYNC");
    expect(line).toContain('"durationMs":42');
  });
});
