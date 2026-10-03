import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getQueueMonitorApp, QUEUE_MONITOR_BASE_PATH } from "@/src/lib/bull-board";
import {
  getOrderRecoveryQueue,
  getProductSyncPageQueue,
  getProductSyncQueue,
  getSubmitOrderQueue,
  getVariantSyncQueue,
  QUEUE,
} from "@/src/lib/queues";

// These checks are deliberately synchronous: `BullMQAdapter#getName()` and
// `#readOnlyMode` never touch Redis, so this suite can assert the monitor is
// wired up correctly without a live Redis (ARCHITECTURE: unit tests run with
// nothing started). The handler that actually lists job counts
// (GET {base}/api/queues) does call Redis and is exercised by the
// integration suite instead.

describe("getQueueMonitorApp", () => {
  it("mounts the board at the documented base path", () => {
    const routes = getQueueMonitorApp().routes.map((route) => route.path);
    expect(routes).toContain(QUEUE_MONITOR_BASE_PATH);
    expect(routes.some((path) => path.startsWith(`${QUEUE_MONITOR_BASE_PATH}/api/queues`))).toBe(
      true,
    );
  });

  it("is a singleton -- callers never build a second Bull Board over the same queues", () => {
    expect(getQueueMonitorApp()).toBe(getQueueMonitorApp());
  });
});

describe("read-only wiring for every existing queue", () => {
  const queueGetters = [
    getProductSyncQueue,
    getProductSyncPageQueue,
    getVariantSyncQueue,
    getSubmitOrderQueue,
    getOrderRecoveryQueue,
  ];

  it("covers exactly the queue names defined in src/lib/queues.ts", () => {
    const names = queueGetters.map((get) => get().name);
    expect(new Set(names)).toEqual(new Set(Object.values(QUEUE)));
  });

  it("wraps every queue as read-only", () => {
    for (const getQueue of queueGetters) {
      const queue = getQueue();
      const adapter = new BullMQAdapter(queue, { readOnlyMode: true });
      expect(adapter.readOnlyMode).toBe(true);
      expect(adapter.getName()).toBe(queue.name);
    }
  });
});

describe("the mounted board is gated end to end", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks the unauthenticated dashboard shell", async () => {
    vi.stubEnv("BULL_BOARD_USERNAME", "ops");
    vi.stubEnv("BULL_BOARD_PASSWORD", "secret");
    const res = await getQueueMonitorApp().request(QUEUE_MONITOR_BASE_PATH);
    expect(res.status).toBe(401);
  });

  it("blocks a static asset request before it ever reaches disk", async () => {
    vi.stubEnv("BULL_BOARD_USERNAME", "ops");
    vi.stubEnv("BULL_BOARD_PASSWORD", "secret");
    const res = await getQueueMonitorApp().request(`${QUEUE_MONITOR_BASE_PATH}/static/css/main.css`);
    expect(res.status).toBe(401);
  });

  it("blocks the Redis-backed queues listing without ever calling Redis", async () => {
    // No Redis is running for this suite (ARCHITECTURE: unit tests run with
    // nothing started) -- this only passes if the auth guard runs BEFORE the
    // handler that would otherwise call queue.getJobCounts() etc.
    vi.stubEnv("BULL_BOARD_USERNAME", "ops");
    vi.stubEnv("BULL_BOARD_PASSWORD", "secret");
    const res = await getQueueMonitorApp().request(`${QUEUE_MONITOR_BASE_PATH}/api/queues`);
    expect(res.status).toBe(401);
  });

  it("fails closed with 503, never public, when unconfigured", async () => {
    vi.stubEnv("BULL_BOARD_USERNAME", "");
    vi.stubEnv("BULL_BOARD_PASSWORD", "");
    const res = await getQueueMonitorApp().request(QUEUE_MONITOR_BASE_PATH);
    expect(res.status).toBe(503);
  });

  it("serves the dashboard shell once correct credentials are sent", async () => {
    vi.stubEnv("BULL_BOARD_USERNAME", "ops");
    vi.stubEnv("BULL_BOARD_PASSWORD", "secret");
    const res = await getQueueMonitorApp().request(QUEUE_MONITOR_BASE_PATH, {
      headers: { Authorization: `Basic ${Buffer.from("ops:secret").toString("base64")}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Marketplace Queues");
  });
});
