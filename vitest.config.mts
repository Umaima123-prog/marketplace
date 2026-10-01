import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Unit tests only: pure logic, fixtures, and fake clients. No MySQL, no Redis,
 * no Shopify -- `npm test` must run on a laptop with nothing started.
 */
export default defineConfig({
  test: {
    environment: "node",
    // src/lib/env.ts validates the core variables at import. These are
    // placeholders so that importing a module which touches env does not
    // require a developer's real .env -- no test connects to either service,
    // and the values are deliberately not credentials.
    env: {
      DATABASE_URL: "mysql://test:test@127.0.0.1:3306/marketplace_unit_tests",
      REDIS_URL: "redis://127.0.0.1:6379",
    },
    include: ["tests/unit/**/*.test.ts"],
    restoreMocks: true,
    /**
     * Coverage of the UNIT suite only, which is what `npm test` runs.
     *
     * Read it for what it is: the unit suite covers pure logic, mappers,
     * decision functions and fake-client paths. Everything that needs a real
     * database -- the catalog read path, the sync repository, the checkout
     * service, the order state machine -- is covered by the INTEGRATION suite
     * against real MySQL and real Redis, which is measured separately and is
     * deliberately not merged in here. A low number against, say,
     * `src/server/checkout` therefore means "not unit-tested", not "untested".
     *
     * `include` below defines the universe of measured files, so source no test
     * imports is still reported -- the gaps show up instead of being hidden by
     * only measuring what tests happened to touch. (Vitest 3 removed the old
     * `coverage.all` flag in favour of exactly this.)
     */
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts", "src/**/*.tsx", "scripts/*.mjs"],
      exclude: [
        // Generated Prisma client: machine-written, gitignored, and enormous.
        "src/generated/**",
        "**/*.d.ts",
      ],
    },
  },
  resolve: {
    // Mirrors the "@/*" -> "./*" alias in tsconfig.json.
    alias: { "@": path.resolve(import.meta.dirname) },
  },
});
