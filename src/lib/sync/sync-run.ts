/**
 * SyncRun lifecycle: the lock, the heartbeat, and finalisation.
 *
 * The lock is a UNIQUE index on `SyncRun.activeLock`, not an advisory lock and
 * not a Redis key. MySQL treats NULLs as distinct in a unique index, so every
 * finished run can hold NULL while exactly one row holds 'ACTIVE'. The database
 * is therefore the lock, which means the guarantee survives multiple worker
 * processes, a Redis flush, and BullMQ's own concurrency settings being wrong.
 */
import type { PrismaClient } from "@/src/generated/prisma";

import { env } from "../env";
import { isUniqueConstraintError } from "../prisma";
import type { Logger } from "../logger";

import { isLockStale, type SyncMode, type SyncRunStatus } from "./decisions";

const ACTIVE = "ACTIVE";

export class SyncAlreadyRunningError extends Error {
  readonly activeRunId: string;
  constructor(activeRunId: string) {
    super(`a sync run is already active (${activeRunId})`);
    this.name = "SyncAlreadyRunningError";
    this.activeRunId = activeRunId;
  }
}

export interface StartRunOptions {
  mode: SyncMode;
  triggeredBy: "SCHEDULE" | "NIGHTLY" | "MANUAL" | "WEBHOOK";
  watermarkFrom: Date | null;
  now?: Date;
  log?: Logger;
}

/**
 * Claim the run lock, reclaiming an abandoned one if the holder is dead.
 *
 * Insert-first rather than check-then-insert: two orchestrators asking "is
 * anyone running?" can both get "no". Letting the unique index answer means the
 * loser gets P2002 and stops, which is correct by construction rather than by
 * timing.
 */
export async function startSyncRun(
  prisma: PrismaClient,
  options: StartRunOptions,
): Promise<{ id: string; reclaimedFrom?: string }> {
  const now = options.now ?? new Date();
  const staleAfterMs = env.syncHeartbeatStaleSeconds * 1000;

  try {
    const run = await prisma.syncRun.create({
      data: {
        mode: options.mode,
        status: "RUNNING",
        activeLock: ACTIVE,
        triggeredBy: options.triggeredBy,
        watermarkFrom: options.watermarkFrom,
        startedAt: now,
        heartbeatAt: now,
      },
      select: { id: true },
    });
    return { id: run.id };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }

  // Someone holds the lock. Alive, or dead and holding it forever?
  const holder = await prisma.syncRun.findFirst({
    where: { activeLock: ACTIVE },
    select: { id: true, status: true, heartbeatAt: true },
  });

  if (!holder) {
    // Released between our INSERT and this read. One retry, then give up --
    // looping here would spin against a genuinely busy lock.
    return startSyncRun(prisma, { ...options, now });
  }

  if (!isLockStale(holder, now, staleAfterMs)) {
    throw new SyncAlreadyRunningError(holder.id);
  }

  // The holder is dead. Mark it FAILED and release the lock, then take it.
  // updateMany with the lock still held is the compare-and-swap: if another
  // worker reclaimed it first, count is 0 and we lose the race safely.
  const released = await prisma.syncRun.updateMany({
    where: { id: holder.id, activeLock: ACTIVE },
    data: {
      status: "FAILED",
      activeLock: null,
      finishedAt: now,
      lastError: `reclaimed: no heartbeat for more than ${env.syncHeartbeatStaleSeconds}s`,
    },
  });

  if (released.count === 0) throw new SyncAlreadyRunningError(holder.id);

  options.log?.warn(
    { reclaimedRunId: holder.id, staleSeconds: env.syncHeartbeatStaleSeconds },
    "reclaimed a stale sync lock",
  );

  const run = await prisma.syncRun.create({
    data: {
      mode: options.mode,
      status: "RUNNING",
      activeLock: ACTIVE,
      triggeredBy: options.triggeredBy,
      watermarkFrom: options.watermarkFrom,
      startedAt: now,
      heartbeatAt: now,
    },
    select: { id: true },
  });

  return { id: run.id, reclaimedFrom: holder.id };
}

/**
 * Prove the run is alive, and record progress in the same write.
 *
 * Called at the START of every page job. A heartbeat written only at the end
 * would go stale during exactly the long page that most needs to be believed.
 */
export async function heartbeat(
  prisma: PrismaClient,
  syncRunId: string,
  progress: {
    pagesProcessed?: number;
    productsUpserted?: number;
    variantsUpserted?: number;
    lastCursor?: string | null;
  } = {},
): Promise<void> {
  await prisma.syncRun.update({
    where: { id: syncRunId },
    data: {
      heartbeatAt: new Date(),
      ...(progress.pagesProcessed !== undefined
        ? { pagesProcessed: { increment: progress.pagesProcessed } }
        : {}),
      ...(progress.productsUpserted !== undefined
        ? { productsUpserted: { increment: progress.productsUpserted } }
        : {}),
      ...(progress.variantsUpserted !== undefined
        ? { variantsUpserted: { increment: progress.variantsUpserted } }
        : {}),
      ...(progress.lastCursor !== undefined ? { lastCursor: progress.lastCursor } : {}),
    },
  });
}

export async function getRun(prisma: PrismaClient, syncRunId: string) {
  return prisma.syncRun.findUnique({ where: { id: syncRunId } });
}

/**
 * End a run and release the lock.
 *
 * `activeLock: null` is the important part and runs on every path, including
 * failure -- a run that ends without releasing is a catalog that cannot sync
 * again until the heartbeat goes stale.
 */
export async function finishSyncRun(
  prisma: PrismaClient,
  syncRunId: string,
  outcome: {
    status: Exclude<SyncRunStatus, "RUNNING">;
    productsDeactivated?: number;
    lastError?: string | null;
  },
): Promise<void> {
  await prisma.syncRun.update({
    where: { id: syncRunId },
    data: {
      status: outcome.status,
      activeLock: null,
      finishedAt: new Date(),
      ...(outcome.productsDeactivated !== undefined
        ? { productsDeactivated: outcome.productsDeactivated }
        : {}),
      ...(outcome.lastError !== undefined ? { lastError: outcome.lastError } : {}),
    },
  });
}

/**
 * End a run because its chain is broken.
 *
 * This is the important half of the failure story. The chain IS the run: page N
 * is what enqueues page N+1, so when a page exhausts its attempts, no later page
 * job exists and nothing will ever finalise the run. Left alone it would sit
 * RUNNING holding the lock until the heartbeat went stale -- blocking every
 * sync for the whole stale window, and reporting a state ("running") that is
 * not true.
 *
 * So: mark PARTIAL, release the lock, record why. PARTIAL rather than FAILED
 * because the pages that did succeed are durably applied -- the run is
 * incomplete, not void. PARTIAL is also what blocks the sweep, which is exactly
 * correct: a run that never saw the whole catalog must not deactivate anything.
 *
 * Idempotent: the `status: "RUNNING"` guard means a second call (a retry
 * arriving after the run already ended) changes nothing and keeps the ORIGINAL
 * error, which is the one that ended the run.
 */
export async function failSyncRun(
  prisma: PrismaClient,
  syncRunId: string,
  reason: string,
): Promise<boolean> {
  const result = await prisma.syncRun.updateMany({
    where: { id: syncRunId, status: "RUNNING" },
    data: {
      status: "PARTIAL",
      activeLock: null,
      finishedAt: new Date(),
      lastError: reason.slice(0, 60_000),
    },
  });
  return result.count > 0;
}

/** Records a page problem without ending the run. */
export async function recordPageFailure(
  prisma: PrismaClient,
  syncRunId: string,
  message: string,
): Promise<void> {
  await prisma.syncRun.update({
    where: { id: syncRunId },
    data: { lastError: message.slice(0, 60_000) },
  });
}

/**
 * How many products the run left with a truncated variant set.
 *
 * A run may finish COMPLETED with some of these -- `variantSyncComplete = false`
 * is a deliberate, durable statement that the stored variant set is partial
 * (ARCHITECTURE §3.3), not a failure. But it must be counted and logged, because
 * "COMPLETED" would otherwise imply something stronger than what happened.
 */
export async function countIncompleteVariantProducts(
  prisma: PrismaClient,
  syncRunId: string,
): Promise<number> {
  return prisma.product.count({
    where: { lastSyncRunId: syncRunId, variantSyncComplete: false },
  });
}

/** The watermark source for an incremental run. */
export async function lastCompletedRunAt(prisma: PrismaClient): Promise<Date | null> {
  const run = await prisma.syncRun.findFirst({
    where: { status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  });
  return run?.finishedAt ?? null;
}
