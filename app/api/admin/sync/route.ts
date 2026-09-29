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
    const result = await enqueueProductSync({ mode, triggeredBy: "MANUAL" });

    log.info({ mode, jobId: result.jobId, event: "sync_enqueued" }, "manual sync enqueued");

    // 202: accepted for processing. The run itself may still decline to start
    // if another one holds the database lock -- the worker reports that, and it
    // is not something this handler can or should wait to find out.
    return NextResponse.json(
      { enqueued: result.enqueued, mode, jobId: result.jobId ?? null },
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
