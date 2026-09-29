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
  },
  resolve: {
    // Mirrors the "@/*" -> "./*" alias in tsconfig.json.
    alias: { "@": path.resolve(import.meta.dirname) },
  },
});
