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
    alias: {
      "@": path.resolve(import.meta.dirname),
      // `server-only` throws unless the bundler sets the "react-server" export
      // condition. That guard is the point in the app -- importing a server
      // module from a client component must fail the build -- but a plain Node
      // test runner sets no such condition, so it resolves to the throwing
      // build. Point it at the package's own no-op instead: the guard keeps
      // working where it matters (next build), and server-side tests can run.
      "server-only": path.resolve(import.meta.dirname, "node_modules/server-only/empty.js"),
    },
  },
});
