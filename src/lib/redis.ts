/**
 * Redis connections for BullMQ.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on any connection it uses for
 * blocking commands; with a number, ioredis aborts the blocking BRPOPLPUSH that
 * a Worker lives inside and the worker dies on the first network blip instead of
 * reconnecting.
 *
 * Queues (producer side) and Workers (consumer side) get SEPARATE connections on
 * purpose -- a Worker's blocking command would otherwise stall every `queue.add`
 * sharing the socket.
 */
import IORedis, { type Redis } from "ioredis";

import { env } from "./env";
import { logger } from "./logger";

function create(role: "queue" | "worker" | "scheduler"): Redis {
  const connection = new IORedis(env.redisUrl, {
    maxRetriesPerRequest: null,
    // Fail the command rather than queue it forever when Redis is down: a
    // manual sync trigger should return an error in milliseconds, not hang the
    // request until the operator gives up.
    enableOfflineQueue: role !== "queue",
    lazyConnect: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });

  connection.on("error", (error: Error) => {
    // Connection errors are logged once per occurrence by ioredis' own
    // retry loop; without a handler, an error event on an EventEmitter is an
    // unhandled exception that kills the process.
    logger.error({ role, err: error.message }, "redis connection error");
  });

  return connection;
}

let queueConnection: Redis | undefined;

/** Shared by every Queue in the web process. Created on first use. */
export function getQueueConnection(): Redis {
  queueConnection ??= create("queue");
  return queueConnection;
}

/** A dedicated connection per Worker. Never shared. */
export function createWorkerConnection(): Redis {
  return create("worker");
}
