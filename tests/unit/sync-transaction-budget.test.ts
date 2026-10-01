/**
 * The product-page write transaction's budget, and its coupling to the BullMQ
 * job lock.
 *
 * These exist because of a production failure that local runs could not
 * reproduce. The page transaction is a few hundred SEQUENTIAL statements, so its
 * duration is set by round-trip latency: ~1 ms per statement on a local socket,
 * ~370 ms against the production MySQL over a public TCP proxy. A 27-product
 * page is ~280 statements -- under a second locally, ~103 s remotely -- so the
 * hard-coded 60 s budget passed locally and expired in production, after which
 * Prisma rejects the transaction's next statement with "Transaction not found".
 *
 * The second test is the one that matters most: the fix is only safe if the job
 * lock outlives the transaction. Otherwise a slow-but-healthy page loses its
 * lock, BullMQ re-delivers it, and the page is written twice -- one failure mode
 * swapped for a worse one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOCK_HEADROOM_MS,
  MIN_LOCK_DURATION_MS,
  workerLockDurationMs,
} from "@/src/lib/queues";

const KEYS = ["SYNC_PAGE_TRANSACTION_TIMEOUT_MS", "SYNC_PAGE_TRANSACTION_MAX_WAIT_MS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.resetModules();
});

/** `env` is frozen at module load, so an override needs a fresh module graph. */
async function loadEnv(overrides: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of KEYS) {
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  vi.resetModules();
  return (await import("@/src/lib/env")).env;
}

describe("page transaction budget", () => {
  it("defaults to a budget sized for remote database latency", async () => {
    const env = await loadEnv({});
    // 240s covers a full 50-product page (~550 statements) at the measured
    // ~370ms mean, with headroom. The old value was 60s.
    expect(env.syncPageTransactionTimeoutMs).toBe(240_000);
    expect(env.syncPageTransactionMaxWaitMs).toBe(30_000);
  });

  it("is overridable per environment", async () => {
    const env = await loadEnv({
      SYNC_PAGE_TRANSACTION_TIMEOUT_MS: "90000",
      SYNC_PAGE_TRANSACTION_MAX_WAIT_MS: "5000",
    });
    expect(env.syncPageTransactionTimeoutMs).toBe(90_000);
    expect(env.syncPageTransactionMaxWaitMs).toBe(5_000);
  });

  it("falls back rather than accepting a nonsensical value", async () => {
    // A typo must not silently produce a 1ms transaction budget, which would
    // fail every sync instead of making one slow.
    for (const bad of ["0", "-1", "abc", "1.5", "", "   "]) {
      const env = await loadEnv({ SYNC_PAGE_TRANSACTION_TIMEOUT_MS: bad });
      expect(env.syncPageTransactionTimeoutMs, bad).toBe(240_000);
    }
  });

  it("is generous enough for the measured production latency", async () => {
    const env = await loadEnv({});
    // The failing case: 27 products / 45 variants at ~370ms per statement.
    const statements = 27 * 7 + 45 * 2;
    const measuredMeanMs = 370;
    expect(statements * measuredMeanMs).toBeLessThan(env.syncPageTransactionTimeoutMs);
  });
});

describe("the job lock must outlive the transaction", () => {
  it("derives a lock longer than the transaction budget", () => {
    for (const timeout of [1_000, 60_000, 240_000, 600_000]) {
      expect(workerLockDurationMs(timeout), String(timeout)).toBeGreaterThan(timeout);
    }
  });

  it("keeps the previous 120s floor for short budgets", () => {
    // Other queues share this lock; shortening it for them would be an
    // unrelated regression.
    expect(workerLockDurationMs(1_000)).toBe(MIN_LOCK_DURATION_MS);
    expect(workerLockDurationMs(10_000)).toBe(MIN_LOCK_DURATION_MS);
  });

  it("adds headroom above the floor once the budget exceeds it", () => {
    expect(workerLockDurationMs(240_000)).toBe(240_000 + LOCK_HEADROOM_MS);
  });

  it("cannot be configured into disagreement with the transaction budget", async () => {
    // The invariant the whole fix rests on, checked against the real default.
    const env = await loadEnv({});
    expect(workerLockDurationMs(env.syncPageTransactionTimeoutMs)).toBeGreaterThan(
      env.syncPageTransactionTimeoutMs,
    );
  });
});

describe("nothing network-bound runs inside the write transaction", () => {
  /**
   * A structural guard, not a mock.
   *
   * The transaction body calls exactly one thing -- `upsertProduct` -- so if the
   * module that defines it cannot reach the network, nothing inside the
   * transaction can. A Shopify call, a queue `add` or an HTTP request in there
   * would hold the transaction open for a remote round trip and reintroduce
   * precisely the timeout this budget exists to survive.
   */
  it("catalog-repo.ts imports no network client", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/sync/catalog-repo.ts", "utf8");

    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    const forbidden = imports.filter((specifier) =>
      /shopify|queues|redis|bullmq|node:http|undici|axios/i.test(specifier),
    );
    expect(forbidden).toEqual([]);

    // Nor a bare fetch / queue hop in the body.
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/shopifyGraphQL/);
    expect(source).not.toMatch(/\.add\(/);
  });

  it("the page processor fetches from Shopify BEFORE opening the transaction", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/worker/processors/product-sync-page.ts", "utf8");

    const fetchAt = source.indexOf("shopifyGraphQL<unknown>(PRODUCTS_PAGE_QUERY");
    const txAt = source.indexOf("prisma.$transaction");
    const enqueueAt = source.indexOf("getVariantSyncQueue().add");

    expect(fetchAt).toBeGreaterThan(-1);
    expect(txAt).toBeGreaterThan(-1);
    expect(enqueueAt).toBeGreaterThan(-1);

    // Fetch, then write, then enqueue: the two slow remote calls sit outside the
    // transaction on either side of it.
    expect(fetchAt).toBeLessThan(txAt);
    expect(txAt).toBeLessThan(enqueueAt);
  });
});
