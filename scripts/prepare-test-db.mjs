/**
 * Applies the committed migrations to the integration-test database.
 *
 * `prisma migrate deploy` reads DATABASE_URL, so this spawns it with
 * DATABASE_URL set to TEST_DATABASE_URL for the child process only -- the
 * parent's environment, and therefore the development database, is untouched.
 *
 * Run automatically by `npm run test:integration`.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const url = process.env.TEST_DATABASE_URL?.trim();

if (!url) {
  console.error("TEST_DATABASE_URL is not set. See .env.example.");
  process.exit(1);
}

const database = new URL(url).pathname.replace(/^\//, "");

if (!database.endsWith("_test")) {
  console.error(`Refusing to migrate "${database}": it does not end in "_test".`);
  process.exit(1);
}

// Database name only -- the URL carries the password.
console.error(`applying migrations to ${database}`);

// Spawn the Prisma CLI's JS entry point with this Node binary, rather than the
// `npx`/`.cmd` shim: the shim resolution differs between platforms and shells,
// and a failure to spawn it is silent.
const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma/build/index.js");

const result = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
  env: { ...process.env, DATABASE_URL: url },
  stdio: "inherit",
});

if (result.error) {
  console.error(`could not start the Prisma CLI: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
