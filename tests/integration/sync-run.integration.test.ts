/**
 * The run lock, the heartbeat and finalisation, against real MySQL.
 *
 * The lock is a UNIQUE index, so its behaviour only exists in the database.
 * Testing it against a fake client would test a mock's opinion of what MySQL
 * does with NULLs in a unique index -- which is the one thing worth checking.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  SyncAlreadyRunningError,
  failSyncRun,
  finishSyncRun,
  heartbeat,
  lastCompletedRunAt,
  startSyncRun,
} from "@/src/lib/sync/sync-run";

import { disconnect, resetDatabase, testPrisma } from "./setup";

const db = testPrisma;

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnect();
});

type StartOptions = Parameters<typeof startSyncRun>[1];

const start = (overrides: Partial<StartOptions> = {}) =>
  startSyncRun(db, {
    mode: "FULL",
    triggeredBy: "MANUAL",
    watermarkFrom: null,
    ...overrides,
  });

describe("the run lock", () => {
  it("claims the lock and records the run as RUNNING", async () => {
    const run = await start();
    const stored = await db.syncRun.findUniqueOrThrow({ where: { id: run.id } });

    expect(stored.status).toBe("RUNNING");
    expect(stored.activeLock).toBe("ACTIVE");
    expect(stored.mode).toBe("FULL");
  });

  it("refuses a second run while the first is alive", async () => {
    await start();
    await expect(start()).rejects.toBeInstanceOf(SyncAlreadyRunningError);
    expect(await db.syncRun.count()).toBe(1);
  });

  it("lets many finished runs coexist, because MySQL treats NULLs as distinct", async () => {
    // This is the property the whole design rests on: UNIQUE(activeLock) with
    // NULL for finished runs permits unlimited history and exactly one live run.
    for (let i = 0; i < 3; i += 1) {
      const run = await start();
      await finishSyncRun(db, run.id, { status: "COMPLETED" });
    }

    expect(await db.syncRun.count()).toBe(3);
    expect(await db.syncRun.count({ where: { activeLock: "ACTIVE" } })).toBe(0);

    // And a new run can still start afterwards.
    const fresh = await start();
    expect(fresh.id).toBeTruthy();
  });

  it("reclaims a lock whose holder stopped heartbeating", async () => {
    const dead = await start();
    await db.syncRun.update({
      where: { id: dead.id },
      // Older than SYNC_HEARTBEAT_STALE_SECONDS (600 by default).
      data: { heartbeatAt: new Date(Date.now() - 3_600_000) },
    });

    const reclaimed = await start();

    expect(reclaimed.reclaimedFrom).toBe(dead.id);
    const corpse = await db.syncRun.findUniqueOrThrow({ where: { id: dead.id } });
    expect(corpse.status).toBe("FAILED");
    expect(corpse.activeLock).toBeNull();
    expect(corpse.lastError).toMatch(/no heartbeat/);
    expect(corpse.finishedAt).not.toBeNull();
  });

  it("does not reclaim a lock whose holder is still heartbeating", async () => {
    const alive = await start();
    await heartbeat(db, alive.id);
    await expect(start()).rejects.toBeInstanceOf(SyncAlreadyRunningError);
  });
});

describe("the heartbeat", () => {
  it("moves heartbeatAt forward and increments counters", async () => {
    const run = await start();
    const before = await db.syncRun.findUniqueOrThrow({ where: { id: run.id } });

    await new Promise((resolve) => setTimeout(resolve, 25));
    await heartbeat(db, run.id, {
      pagesProcessed: 1,
      productsUpserted: 50,
      variantsUpserted: 120,
      lastCursor: "CURSOR-1",
    });
    await heartbeat(db, run.id, { pagesProcessed: 1, productsUpserted: 30, variantsUpserted: 40 });

    const after = await db.syncRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.heartbeatAt.getTime()).toBeGreaterThan(before.heartbeatAt.getTime());
    // Increments, not assignments: two pages must not overwrite each other's counts.
    expect(after.pagesProcessed).toBe(2);
    expect(after.productsUpserted).toBe(80);
    expect(after.variantsUpserted).toBe(160);
    expect(after.lastCursor).toBe("CURSOR-1");
  });
});

describe("finalisation", () => {
  it("releases the lock on success", async () => {
    const run = await start();
    await finishSyncRun(db, run.id, { status: "COMPLETED", productsDeactivated: 4 });

    const stored = await db.syncRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.status).toBe("COMPLETED");
    expect(stored.activeLock).toBeNull();
    expect(stored.finishedAt).not.toBeNull();
    expect(stored.productsDeactivated).toBe(4);
  });

  it("releases the lock on failure too, so the catalog is not wedged", async () => {
    const run = await start();
    await failSyncRun(db, run.id, "page 3 exhausted its attempts");

    const stored = await db.syncRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.status).toBe("PARTIAL");
    expect(stored.activeLock).toBeNull();
    expect(stored.finishedAt).not.toBeNull();
    expect(stored.lastError).toContain("exhausted its attempts");

    // The next run must be able to start immediately, not wait out the
    // heartbeat timeout.
    const next = await start();
    expect(next.reclaimedFrom).toBeUndefined();
  });

  it("failing a run is idempotent, so a retry cannot resurrect it", async () => {
    const run = await start();
    await failSyncRun(db, run.id, "first failure");
    await failSyncRun(db, run.id, "second attempt at the same failure");

    const stored = await db.syncRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.status).toBe("PARTIAL");
    // The first reason is kept: it is the one that ended the run.
    expect(stored.lastError).toContain("first failure");
  });
});

describe("the incremental watermark", () => {
  it("reads the most recent COMPLETED run", async () => {
    const older = await start();
    await finishSyncRun(db, older.id, { status: "COMPLETED" });

    const partial = await start();
    await failSyncRun(db, partial.id, "half a catalog");

    const newer = await start();
    await finishSyncRun(db, newer.id, { status: "COMPLETED" });

    const stored = await db.syncRun.findUniqueOrThrow({ where: { id: newer.id } });
    const watermark = await lastCompletedRunAt(db);
    expect(watermark?.toISOString()).toBe(stored.finishedAt?.toISOString());
  });

  it("returns null when no run has ever completed, so the first run walks everything", async () => {
    const run = await start();
    await failSyncRun(db, run.id, "never completed");
    expect(await lastCompletedRunAt(db)).toBeNull();
  });
});
