/**
 * Bull Board monitoring UI and API, mounted at /api/queues.
 *
 * Read-only (see src/lib/bull-board.ts): this route only ever reads queue and
 * job state for the operator's eyes, never a path for triggering or mutating
 * work. Enqueueing stays exactly where it already was (POST /api/admin/sync,
 * the checkout flow, the recovery sweep).
 *
 * Gated by HTTP Basic Auth (src/lib/bull-board-auth.ts), unlike
 * /api/admin/sync, which still has none -- there is no admin auth system in
 * this app, so this route brings its own rather than waiting for one. Missing
 * BULL_BOARD_USERNAME or BULL_BOARD_PASSWORD means every request here is
 * denied, never served unauthenticated.
 */
import { getQueueMonitorApp } from "@/src/lib/bull-board";
import { errorFields, logger } from "@/src/lib/logger";

const log = logger.child({ service: "web", route: "/api/queues" });

/** Dashboard data must never be served stale or cached. */
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  try {
    return await getQueueMonitorApp().fetch(request);
  } catch (error) {
    // Redis down, most likely. The dashboard fails with a 503 instead of
    // taking the storefront down with it -- this route shares no connection
    // and no process with the rest of Next.js.
    log.error(errorFields(error), "queue monitor request failed");
    return new Response("Queue monitor unavailable", { status: 503 });
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
