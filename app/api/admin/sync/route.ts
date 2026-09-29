/**
 * Manual sync trigger.
 *
 * Enqueue and return. This handler must never await Shopify pagination: a full
 * catalog walk is minutes of work, and an operator clicking a button should get
 * an answer in milliseconds. It returns the BullMQ job id so the caller can
 * correlate with the worker's logs.
 *
 * The web process is a producer only -- it calls `queue.add` and never
 * constructs a Worker (ARCHITECTURE §2).
 */
import { NextResponse } from "next/server";

import { logger } from "@/src/lib/logger";
import { enqueueProductSync, type SyncMode } from "@/src/lib/queues";

const log = logger.child({ service: "web", route: "POST /api/admin/sync" });

/** Route handlers are not cached by default; this one must never be. */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let mode: SyncMode = "INCREMENTAL";

  // Body is optional: `POST /api/admin/sync` with no body means "incremental".
  try {
    const body: unknown = await request.json();
    if (typeof body === "object" && body !== null && "mode" in body) {
      const requested = (body as { mode?: unknown }).mode;
      if (requested === "FULL" || requested === "INCREMENTAL") {
        mode = requested;
      } else if (requested !== undefined) {
        return NextResponse.json(
          { error: 'mode must be "FULL" or "INCREMENTAL"' },
          { status: 400 },
        );
      }
    }
  } catch {
    // No body, or not JSON. The default stands.
  }

  try {
    const jobId = await enqueueProductSync({ mode, triggeredBy: "MANUAL" });

    // A duplicate id means a run of this mode is already queued. That is a
    // success from the caller's point of view -- the work they asked for is
    // going to happen -- so it is not an error, but it is worth saying.
    log.info({ mode, jobId, event: "sync_enqueued" }, "manual sync enqueued");

    return NextResponse.json(
      { enqueued: true, mode, jobId: jobId ?? null },
      { status: 202 },
    );
  } catch (error) {
    // Redis down. The request fails fast rather than hanging: `enableOfflineQueue`
    // is false on the producer connection precisely so this returns instead of
    // buffering forever.
    log.error(
      {
        mode,
        errorClass: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      "could not enqueue manual sync",
    );
    return NextResponse.json({ error: "queue unavailable" }, { status: 503 });
  }
}
