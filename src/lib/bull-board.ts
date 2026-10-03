/**
 * Read-only Bull Board for the queues already defined in `./queues`.
 *
 * Reuses the same Queue instances the rest of the web process uses to enqueue
 * jobs -- this module adds no Redis connection and no Worker of its own
 * (ARCHITECTURE §2: the web process is a producer only).
 *
 * Every queue is wrapped with `readOnlyMode: true`. Bull Board enforces this
 * server-side (`@bull-board/api`'s queue provider rejects a mutating call
 * against a read-only queue) and client-side (the UI hides retry/remove/pause
 * controls once a queue reports itself read-only), so this is monitoring only,
 * never a second way to operate the queues.
 *
 * Gated end to end by HTTP Basic Auth (./bull-board-auth): the guard is
 * mounted on `root`, below, before the board's own routes, so it covers the
 * UI shell, every static asset, and every API call the dashboard makes --
 * there is no sub-path that bypasses it.
 */
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { serveStatic } from "@hono/node-server/serve-static";
import { HonoAdapter } from "@bull-board/hono";
import { Hono } from "hono";

import { requireBullBoardAuth } from "./bull-board-auth";
import {
  getOrderRecoveryQueue,
  getProductSyncPageQueue,
  getProductSyncQueue,
  getSubmitOrderQueue,
  getVariantSyncQueue,
} from "./queues";

/** Where the monitor is mounted. Must match the route file under `app/api`. */
export const QUEUE_MONITOR_BASE_PATH = "/api/queues";

let app: Hono | undefined;

function buildApp(): Hono {
  const serverAdapter = new HonoAdapter(serveStatic);
  serverAdapter.setBasePath(QUEUE_MONITOR_BASE_PATH);

  const queues = [
    getProductSyncQueue(),
    getProductSyncPageQueue(),
    getVariantSyncQueue(),
    getSubmitOrderQueue(),
    getOrderRecoveryQueue(),
  ];

  createBullBoard({
    queues: queues.map((queue) => new BullMQAdapter(queue, { readOnlyMode: true })),
    serverAdapter,
    options: { uiConfig: { boardTitle: "Marketplace Queues" } },
  });

  // `registerPlugin()` returns routes rooted at "/" (e.g. "/api/queues",
  // "/static/*"); mounting it on a root app at QUEUE_MONITOR_BASE_PATH is what
  // makes the full paths line up with what the UI's own templates request.
  //
  // The auth guard is registered first and matches every path ("*") on this
  // app -- this `root` instance exists only for the board, so there is no
  // other route it could wrongly cover.
  const root = new Hono();
  root.use("*", requireBullBoardAuth);
  root.route(QUEUE_MONITOR_BASE_PATH, serverAdapter.registerPlugin());
  return root;
}

/**
 * Lazily built so that constructing the module never touches Redis -- only
 * handling a request to the monitor does, and that failure is handled by the
 * route itself (see app/api/queues/[[...route]]/route.ts).
 */
export function getQueueMonitorApp(): Hono {
  app ??= buildApp();
  return app;
}
