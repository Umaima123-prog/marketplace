import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Integration suite: real MySQL, real Prisma, real constraints. Shopify is not
 * involved -- these tests are about what the database does.
 *
 * Kept in its own config so `npm test` never silently requires a running
 * database, and run serially: every file truncates shared tables, so parallel
 * files would delete each other's rows mid-assertion.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      // src/lib/env.ts validates these at import; the repository under test
      // uses the explicit test client, not this URL.
      DATABASE_URL: "mysql://unused:unused@127.0.0.1:3306/unused",
      REDIS_URL: "redis://127.0.0.1:6379",
    },
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname) },
  },
});
