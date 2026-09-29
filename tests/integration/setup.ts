/**
 * Integration-test harness: real MySQL, real Prisma, real constraints.
 *
 * The first thing this file does is refuse to run against the wrong database.
 * These tests truncate every table, so a `TEST_DATABASE_URL` pointing at
 * `marketplace` would destroy a developer's working data between one test file
 * and the next. The guard is deliberately unconditional and unskippable: a
 * flag to bypass it is a flag someone will set.
 */
import { PrismaClient } from "@/src/generated/prisma";

const REQUIRED_SUFFIX = "_test";

function assertSafeTestDatabase(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();

  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set.\n" +
        "Integration tests need their own MySQL database. See .env.example.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid URL");
  }

  const database = parsed.pathname.replace(/^\//, "");

  if (!database.endsWith(REQUIRED_SUFFIX)) {
    throw new Error(
      `Refusing to run: TEST_DATABASE_URL names "${database}", which does not end in ` +
        `"${REQUIRED_SUFFIX}".\n` +
        "These tests TRUNCATE every table. Point them at a dedicated database.",
    );
  }

  // Belt and braces: even a database called `marketplace_test` is fine, but one
  // called exactly `marketplace` must never be reachable from here.
  if (database === "marketplace" || database === "marketplace_shadow") {
    throw new Error(`Refusing to run against "${database}"`);
  }

  return url;
}

const databaseUrl = assertSafeTestDatabase();

/**
 * A client pointed explicitly at the test database, NOT the app singleton --
 * importing `src/lib/prisma` would connect to DATABASE_URL, which is the
 * development database.
 */
export const testPrisma = new PrismaClient({ datasourceUrl: databaseUrl });

/**
 * Tables in dependency order (children first). Truncation order matters
 * because foreign keys are real here -- that is the entire point of testing
 * against MySQL rather than a fake.
 */
const TABLES = [
  "order_items",
  "orders",
  "product_images",
  "product_variants",
  "products",
  "sync_runs",
  "job_logs",
  "webhook_events",
] as const;

/**
 * Empty every table. `TRUNCATE` resets nothing we depend on and is faster than
 * DELETE, but it cannot run while foreign keys reference the rows, hence the
 * session-scoped FK toggle. Scoped to this connection only.
 */
export async function resetDatabase(): Promise<void> {
  await testPrisma.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 0");
  for (const table of TABLES) {
    await testPrisma.$executeRawUnsafe(`TRUNCATE TABLE \`${table}\``);
  }
  await testPrisma.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 1");
}

export async function disconnect(): Promise<void> {
  await testPrisma.$disconnect();
}

/** Which database these tests are actually hitting, for the run header. */
export function testDatabaseName(): string {
  return new URL(databaseUrl).pathname.replace(/^\//, "");
}
