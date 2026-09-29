/**
 * One PrismaClient per process (ARCHITECTURE §8).
 *
 * The global cache is not a style preference: Next's dev server re-evaluates
 * modules on every hot reload, and a fresh PrismaClient per reload exhausts the
 * MySQL connection limit within a few edits. The worker process loads this once
 * and the global is simply unused there.
 */
import { PrismaClient } from "@/src/generated/prisma";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Errors and warnings only. Query logging would put every product title and
    // every parameter on stdout, which is both noise and a PII risk once orders
    // exist.
    log: [
      { emit: "stdout", level: "error" },
      { emit: "stdout", level: "warn" },
    ],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** Prisma's error code for a unique-constraint violation. */
export const P2002 = "P2002";

/**
 * True when an error is a unique-constraint race rather than a bug.
 *
 * Checked structurally instead of with `instanceof
 * Prisma.PrismaClientKnownRequestError`: the generated client is imported
 * through a path alias, and an instanceof check against a different module
 * instance silently returns false -- which would turn every handled race into
 * an unhandled failure.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === P2002
  );
}
