/**
 * Durable job history.
 *
 * BullMQ's own history lives in Redis, which this architecture treats as
 * disposable (ARCHITECTURE §6) -- history that vanishes on a `FLUSHALL` is not
 * history. Every processor writes a JobLog row when it starts and updates it
 * when it finishes, so "what happened at 04:00 last Tuesday" is answerable from
 * MySQL.
 *
 * Keyed on `(bullJobId, attempt)`: retries of the same job are separate rows,
 * because "attempt 3 succeeded after attempts 1 and 2 failed" is the
 * interesting story and a single mutable row would erase it.
 */
import type { PrismaClient } from "@/src/generated/prisma";

import { errorFields, type Logger } from "../logger";

export type JobEntityType = "ORDER" | "PRODUCT" | "SYNC_RUN";

export interface JobLogContext {
  queueName: string;
  jobName: string;
  bullJobId: string;
  attempt: number;
  entityType?: JobEntityType;
  entityId?: string;
}

export interface StartedJobLog extends JobLogContext {
  id: string | null;
  startedAt: number;
}

/**
 * Record the start of an attempt.
 *
 * Never throws: job history is observability, and losing a log row must not
 * fail the work it describes. A failure here is logged and the processor
 * continues with `id: null`, which makes `finishJobLog` a no-op.
 */
export async function startJobLog(
  prisma: PrismaClient,
  context: JobLogContext,
  log: Logger,
): Promise<StartedJobLog> {
  const startedAt = Date.now();
  try {
    const row = await prisma.jobLog.create({
      data: {
        queueName: context.queueName,
        jobName: context.jobName,
        bullJobId: context.bullJobId,
        attempt: context.attempt,
        entityType: context.entityType,
        entityId: context.entityId,
        status: "STARTED",
      },
      select: { id: true },
    });
    return { ...context, id: row.id, startedAt };
  } catch (error) {
    log.warn({ ...errorFields(error) }, "could not persist JobLog start row");
    return { ...context, id: null, startedAt };
  }
}

export async function finishJobLog(
  prisma: PrismaClient,
  started: StartedJobLog,
  outcome:
    | { status: "SUCCEEDED" }
    | { status: "FAILED"; error: unknown; willRetry: boolean },
  log: Logger,
): Promise<void> {
  if (!started.id) return;
  const durationMs = Date.now() - started.startedAt;

  try {
    await prisma.jobLog.update({
      where: { id: started.id },
      data: {
        status: outcome.status,
        durationMs,
        finishedAt: new Date(),
        ...(outcome.status === "FAILED"
          ? {
              errorClass: errorFields(outcome.error).errorClass.slice(0, 128),
              // Message and stack together: the stack alone rarely says what the
              // API refused, and the message alone rarely says where.
              errorMessage: [
                errorFields(outcome.error).errorMessage,
                errorFields(outcome.error).stack,
              ]
                .filter(Boolean)
                .join("\n\n")
                .slice(0, 60_000),
            }
          : {}),
      },
    });
  } catch (error) {
    log.warn({ ...errorFields(error) }, "could not persist JobLog finish row");
  }
}

/**
 * Wrap a processor: JobLog row in, structured start/finish lines out.
 *
 * Every log line this produces carries job name, BullMQ id, attempt, the
 * related entity, duration on completion, and on failure the error class,
 * message, stack and whether BullMQ will retry -- the graded list, in one place
 * rather than repeated in three processors.
 */
export async function withJobLog<T>(
  prisma: PrismaClient,
  log: Logger,
  context: JobLogContext & { maxAttempts: number },
  work: (started: StartedJobLog) => Promise<T>,
): Promise<T> {
  const started = await startJobLog(prisma, context, log);
  // queue / jobName / jobId / attempt are already bound on the child logger;
  // repeating them here would duplicate the keys in the emitted JSON.
  log.info(
    { entityType: context.entityType, entityId: context.entityId, event: "job_started" },
    "job started",
  );

  try {
    const result = await work(started);
    const durationMs = Date.now() - started.startedAt;
    await finishJobLog(prisma, started, { status: "SUCCEEDED" }, log);
    log.info(
      {
        durationMs,
        event: "job_succeeded",
        ...(typeof result === "object" && result !== null ? { result } : {}),
      },
      "job succeeded",
    );
    return result;
  } catch (error) {
    const durationMs = Date.now() - started.startedAt;
    const willRetry = context.attempt < context.maxAttempts && isRetryable(error);
    await finishJobLog(prisma, started, { status: "FAILED", error, willRetry }, log);
    log.error(
      {
        maxAttempts: context.maxAttempts,
        durationMs,
        willRetry,
        event: "job_failed",
        ...errorFields(error),
      },
      "job failed",
    );
    throw error;
  }
}

/**
 * Imported lazily to keep this module free of a Shopify dependency: job logging
 * is generic, and the order phase will log jobs that never touch Shopify.
 */
function isRetryable(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "retryable" in error) {
    return Boolean((error as { retryable?: unknown }).retryable);
  }
  return true;
}
