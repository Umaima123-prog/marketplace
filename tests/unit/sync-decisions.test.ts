import { describe, expect, it } from "vitest";

import {
  INCREMENTAL_OVERLAP_MS,
  buildProductQueryFilter,
  canSweep,
  incrementalWatermark,
  isLockStale,
  isStaleAfterRun,
  shouldApplyUpdate,
  variantSyncState,
} from "@/src/lib/sync/decisions";

describe("shouldApplyUpdate", () => {
  const stored = new Date("2026-09-20T10:00:00Z");

  it("applies when the payload is newer", () => {
    expect(shouldApplyUpdate(new Date("2026-09-20T10:00:01Z"), stored)).toBe(true);
  });

  it("applies on an equal timestamp, so a re-run can repair a partial write", () => {
    expect(shouldApplyUpdate(new Date("2026-09-20T10:00:00Z"), stored)).toBe(true);
  });

  it("rejects an older payload -- a slow page must not clobber a newer webhook", () => {
    expect(shouldApplyUpdate(new Date("2026-09-20T09:59:59Z"), stored)).toBe(false);
  });

  it("applies when nothing is stored", () => {
    expect(shouldApplyUpdate(new Date(), null)).toBe(true);
    expect(shouldApplyUpdate(new Date(), undefined)).toBe(true);
  });
});

describe("isLockStale", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  const staleAfterMs = 600_000; // 10 minutes

  it("treats a fresh heartbeat as alive", () => {
    expect(
      isLockStale({ status: "RUNNING", heartbeatAt: new Date("2026-09-29T11:59:00Z") }, now, staleAfterMs),
    ).toBe(false);
  });

  it("treats a heartbeat older than the threshold as abandoned", () => {
    expect(
      isLockStale({ status: "RUNNING", heartbeatAt: new Date("2026-09-29T11:45:00Z") }, now, staleAfterMs),
    ).toBe(true);
  });

  it("is exclusive at the boundary -- exactly at the threshold is still alive", () => {
    expect(
      isLockStale({ status: "RUNNING", heartbeatAt: new Date("2026-09-29T11:50:00Z") }, now, staleAfterMs),
    ).toBe(false);
  });

  it("treats any non-RUNNING holder as reclaimable regardless of heartbeat", () => {
    for (const status of ["COMPLETED", "PARTIAL", "FAILED"] as const) {
      expect(isLockStale({ status, heartbeatAt: now }, now, staleAfterMs)).toBe(true);
    }
  });
});

describe("canSweep -- the gate that protects the catalog", () => {
  const complete = {
    mode: "FULL" as const,
    status: "COMPLETED" as const,
    failures: 0,
    reachedLastPage: true,
  };

  it("allows the sweep only after a complete, failure-free FULL run", () => {
    expect(canSweep(complete)).toBe(true);
  });

  it("refuses after an INCREMENTAL run", () => {
    // An incremental run never sees unchanged products; sweeping would
    // deactivate the entire catalog except the last 15 minutes of changes.
    expect(canSweep({ ...complete, mode: "INCREMENTAL" })).toBe(false);
  });

  it("refuses when any page failed", () => {
    expect(canSweep({ ...complete, failures: 1 })).toBe(false);
  });

  it("refuses when the run did not reach the last page", () => {
    expect(canSweep({ ...complete, reachedLastPage: false })).toBe(false);
  });

  it("refuses for a PARTIAL, FAILED or still-RUNNING run", () => {
    for (const status of ["PARTIAL", "FAILED", "RUNNING"] as const) {
      expect(canSweep({ ...complete, status })).toBe(false);
    }
  });

  it("refuses every combination that is not all four conditions", () => {
    const modes = ["FULL", "INCREMENTAL"] as const;
    const statuses = ["RUNNING", "COMPLETED", "PARTIAL", "FAILED"] as const;
    for (const mode of modes) {
      for (const status of statuses) {
        for (const failures of [0, 1]) {
          for (const reachedLastPage of [true, false]) {
            const expected =
              mode === "FULL" && status === "COMPLETED" && failures === 0 && reachedLastPage;
            expect(canSweep({ mode, status, failures, reachedLastPage })).toBe(expected);
          }
        }
      }
    }
  });
});

describe("isStaleAfterRun", () => {
  it("treats a never-stamped row as stale", () => {
    // NULL-safety: `last_sync_run_id != 'run'` is NULL in SQL for a NULL column,
    // and NULL is not TRUE, so the obvious predicate would skip this row.
    expect(isStaleAfterRun(null, "run-1")).toBe(true);
  });

  it("treats a row stamped by another run as stale", () => {
    expect(isStaleAfterRun("run-0", "run-1")).toBe(true);
  });

  it("treats a row stamped by this run as fresh", () => {
    expect(isStaleAfterRun("run-1", "run-1")).toBe(false);
  });
});

describe("variantSyncState", () => {
  it("is complete only when Shopify reports no further pages", () => {
    expect(variantSyncState(false, null)).toEqual({
      variantSyncComplete: true,
      variantSyncCursor: null,
    });
  });

  it("is incomplete and keeps a resume cursor while pages remain", () => {
    expect(variantSyncState(true, "CUR")).toEqual({
      variantSyncComplete: false,
      variantSyncCursor: "CUR",
    });
  });
});

describe("incremental watermark", () => {
  const now = new Date("2026-09-29T12:00:00Z");

  it("walks everything when no run has ever completed", () => {
    expect(incrementalWatermark(null, now)).toBeNull();
  });

  it("overlaps the previous run, because updated_at is second-granular and eventually consistent", () => {
    const lastRun = new Date("2026-09-29T11:50:00Z");
    const watermark = incrementalWatermark(lastRun, now);
    expect(watermark?.getTime()).toBe(lastRun.getTime() - INCREMENTAL_OVERLAP_MS);
  });

  it("never returns a future watermark", () => {
    const lastRun = new Date("2026-09-29T12:10:00Z"); // clock skew
    expect(incrementalWatermark(lastRun, now, 0)?.getTime()).toBe(now.getTime());
  });
});

describe("buildProductQueryFilter", () => {
  it("produces Shopify's updated_at filter", () => {
    expect(buildProductQueryFilter(new Date("2026-09-29T11:45:00Z"))).toBe(
      "updated_at:>=2026-09-29T11:45:00.000Z",
    );
  });

  it("returns null for a full walk, so the query is unfiltered", () => {
    expect(buildProductQueryFilter(null)).toBeNull();
  });
});
