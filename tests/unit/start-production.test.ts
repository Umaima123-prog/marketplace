/**
 * The production launcher's configuration.
 *
 * The signal-forwarding and exit-propagation behaviour is process-level and is
 * verified against the real thing in the deployment logs rather than mocked
 * here. What IS worth pinning is the configuration those behaviours act on:
 * which two processes run, that the port comes from the environment rather than
 * being hard-coded, and that both are critical -- because "critical" is what
 * makes a dead worker take the service down instead of leaving a deployment
 * that serves pages while no order is ever submitted.
 */
import { describe, expect, it } from "vitest";

import { SHUTDOWN_GRACE_MS, childSpecs, spawnOptionsFor } from "../../scripts/start-production.mjs";

describe("childSpecs", () => {
  it("runs Next.js and the worker as two separate processes", () => {
    const specs = childSpecs({ PORT: "8080" });
    expect(specs.map((s) => s.name)).toEqual(["next", "worker"]);
  });

  it("starts Next on the port the platform provides", () => {
    const specs = childSpecs({ PORT: "8080" });
    const next = specs.find((s) => s.name === "next");
    expect(next?.command).toBe("npx");
    expect(next?.args).toEqual(["next", "start", "--port", "8080"]);
  });

  it("falls back to 3000 only when no PORT is set", () => {
    // Railway always injects PORT; the fallback exists for local use, and must
    // not silently override a provided one.
    const specs = childSpecs({});
    expect(specs.find((s) => s.name === "next")?.args).toEqual([
      "next",
      "start",
      "--port",
      "3000",
    ]);
  });

  it("starts the worker through its existing npm script, unchanged", () => {
    // The worker's own start command is not rewritten here: this launcher
    // supervises processes, it does not redefine them.
    const worker = childSpecs({}).find((s) => s.name === "worker");
    expect(worker?.command).toBe("npm");
    expect(worker?.args).toEqual(["run", "worker"]);
  });

  it("treats both children as critical", () => {
    // If either stops, the deployment is no longer doing its job. A worker that
    // dies silently is the dangerous case: pages keep serving while orders pile
    // up in PENDING_SYNC with nothing draining them.
    expect(childSpecs({}).every((s) => s.critical)).toBe(true);
  });

  it("does not read a secret or a connection string", () => {
    // Everything the children need is inherited from the environment; the
    // launcher itself must not touch a credential.
    const specs = childSpecs({
      PORT: "8080",
      DATABASE_URL: "mysql://u:p@h:1/db",
      REDIS_URL: "rediss://u:p@h:1",
      SHOPIFY_CLIENT_SECRET: "shh",
    });
    const serialised = JSON.stringify(specs);
    for (const leak of ["mysql://", "rediss://", "shh", "DATABASE_URL", "REDIS_URL"]) {
      expect(serialised).not.toContain(leak);
    }
  });
});

describe("shutdown grace", () => {
  it("allows a child time to exit before it is killed", () => {
    // Long enough for the worker's own SIGTERM handler to close its BullMQ
    // workers and release job locks, rather than having them wait out the
    // stalled-job timer.
    expect(SHUTDOWN_GRACE_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe("package wiring", () => {
  it("exposes the launcher as start:production", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["start:production"]).toBe("node scripts/start-production.mjs");
  });

  it("ships tsx as a runtime dependency, because the worker needs it to start", async () => {
    // `npm run worker` is `node --import tsx ... src/worker/index.ts`, and the
    // worker resolves `@/src/...` path aliases that only tsx provides. A
    // production install omits devDependencies, so tsx being a devDependency
    // would make the worker unable to start in production at all.
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.dependencies.tsx).toBeDefined();
    expect(pkg.devDependencies?.tsx).toBeUndefined();
  });
});

describe("spawnOptionsFor", () => {
  it("uses no shell and a process group on Linux, which is what production runs", () => {
    // The pairing that makes signal forwarding work: nothing between this
    // process and its children, and a group leader so a signal reaches the
    // whole tree including npm's node child.
    expect(spawnOptionsFor("linux")).toEqual({ shell: false, detached: true });
    expect(spawnOptionsFor("darwin")).toEqual({ shell: false, detached: true });
  });

  it("falls back to a shell on Windows, where a .cmd cannot be spawned directly", () => {
    // Node 20+ refuses to execute a .cmd without a shell (CVE-2024-27980), and
    // npm/npx are .cmd shims there -- it fails with EINVAL. Found by running the
    // launcher locally.
    expect(spawnOptionsFor("win32")).toEqual({ shell: true, detached: false });
  });
});
