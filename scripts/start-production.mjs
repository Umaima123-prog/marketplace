/**
 * Production launcher: Next.js and the BullMQ worker as two child PROCESSES.
 *
 * The architecture requires the worker to be a separate process from Next
 * (ARCHITECTURE §2) -- a sync that runs inside a page request ties catalog
 * freshness to whoever loads a page and dies when the invocation does. It does
 * NOT require a separate host service, so one Railway service supervises both.
 *
 * Why a launcher rather than `next start & npm run worker`:
 *
 *   - `&` leaves the shell as PID 1 with no signal forwarding, so a Railway
 *     deploy's SIGTERM reaches the shell and not the children. The worker never
 *     runs its graceful shutdown, so in-flight jobs lose their BullMQ lock and
 *     wait for the stalled-job timer instead of being released.
 *   - A shell reports its own exit status, not the children's. If the worker
 *     dies, the web process keeps serving and the platform never restarts
 *     anything -- the failure is silent, which is the worst kind here: orders
 *     accumulate in PENDING_SYNC with nothing draining them.
 *
 * This file therefore does three things a shell cannot: forward signals to the
 * whole process tree, treat either child's unexpected exit as a service
 * failure, and exit non-zero so the platform restarts.
 *
 * It starts no queues, opens no database connection, and reads no secret. Every
 * variable the children need is inherited from the environment.
 */
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/** How long a child gets to exit on its own before it is killed outright. */
export const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 15_000);

/**
 * What to run.
 *
 * Both are `critical`: the service is "Next.js AND the worker", so losing
 * either one means the deployment is no longer doing its job and should be
 * restarted rather than left half-working.
 *
 * @param {Record<string, string | undefined>} [env] - defaults to the real
 *   environment; injectable so the port handling can be tested without one.
 */
export function childSpecs(env = process.env) {
  // Railway injects PORT. The fallback only matters when running this locally.
  const port = String(env.PORT ?? 3000);
  return [
    {
      name: "next",
      command: "npx",
      args: ["next", "start", "--port", port],
      critical: true,
    },
    {
      name: "worker",
      command: "npm",
      args: ["run", "worker"],
      critical: true,
    },
  ];
}

/**
 * Spawn options, which differ by platform for reasons worth stating.
 *
 * PRODUCTION (Linux) uses `shell: false` and `detached: true`. That pairing is
 * the whole point: no shell between this process and its children, and each
 * child is a process-group leader so a signal can reach the entire tree.
 * `npm run worker` is npm spawning node, so signalling only npm would orphan
 * the worker with its Redis connection and job locks still held.
 *
 * WINDOWS (local use only) must use a shell: `npm` and `npx` are `.cmd` shims,
 * and since Node 20 `spawn` refuses to execute a `.cmd` without a shell
 * (the CVE-2024-27980 mitigation) -- it fails with EINVAL. Process groups do not
 * work the same way there either, so `detached` is off and signalling falls back
 * to killing the child directly. This path exists so the launcher can be run and
 * smoke-tested locally; it is not the path production takes.
 */
export function spawnOptionsFor(platform = process.platform) {
  const windows = platform === "win32";
  return { shell: windows, detached: !windows };
}

/** Timestamped, prefixed, and on stdout -- Railway captures both streams. */
function log(message) {
  process.stdout.write(`[launcher] ${new Date().toISOString()} ${message}\n`);
}

function main() {
  const specs = childSpecs();
  /** @type {Map<string, {child: import("node:child_process").ChildProcess, exited: boolean}>} */
  const running = new Map();

  let shuttingDown = false;
  let exitCode = 0;
  /** @type {NodeJS.Timeout | null} */
  let killTimer = null;

  /**
   * Signals the child's whole process GROUP, not just the child.
   *
   * `npm run worker` is npm spawning node, so signalling the npm process alone
   * would leave the worker orphaned and still holding its Redis connection and
   * job locks. `detached: true` below makes each child a group leader, so a
   * negative pid reaches the child and everything it spawned.
   *
   * Process groups are POSIX; on Windows (local use only) fall back to the
   * direct kill, which is the best available.
   */
  function signalTree(entry, signal) {
    const { child } = entry;
    if (child.pid === undefined) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      // ESRCH simply means it is already gone, which is the desired state.
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH") {
        log(`failed to signal ${entry.name}: ${/** @type {Error} */ (error).message}`);
      }
    }
  }

  function finishIfAllExited() {
    if (![...running.values()].every((entry) => entry.exited)) return;
    if (killTimer) clearTimeout(killTimer);
    log(`all children exited; exiting with code ${exitCode}`);
    process.exit(exitCode);
  }

  function shutdown(reason, signal = "SIGTERM") {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason}); forwarding ${signal} to children`);

    for (const entry of running.values()) {
      if (!entry.exited) signalTree(entry, signal);
    }

    // A child that ignores the signal must not hold the deploy open forever.
    killTimer = setTimeout(() => {
      for (const entry of running.values()) {
        if (!entry.exited) {
          log(`${entry.name} did not exit within ${SHUTDOWN_GRACE_MS}ms; sending SIGKILL`);
          signalTree(entry, "SIGKILL");
        }
      }
    }, SHUTDOWN_GRACE_MS);
    // Do not let the timer itself keep the event loop alive.
    killTimer.unref?.();

    finishIfAllExited();
  }

  for (const spec of specs) {
    log(`starting ${spec.name}: ${spec.command} ${spec.args.join(" ")}`);

    const child = spawn(spec.command, spec.args, {
      // Both children write straight to the service's stdout/stderr, so
      // Railway's log stream shows Next and the worker interleaved with no
      // buffering or re-encoding in between.
      stdio: "inherit",
      env: process.env,
      ...spawnOptionsFor(),
    });

    const entry = { child, exited: false, name: spec.name };
    running.set(spec.name, entry);

    child.on("error", (error) => {
      // Failure to SPAWN (a missing binary, for instance) rather than a failure
      // while running. Nothing is retried: a service that cannot start its own
      // processes should fail loudly and let the platform restart it.
      log(`${spec.name} failed to start: ${error.message}`);
      entry.exited = true;
      exitCode = exitCode || 1;
      shutdown(`${spec.name} failed to start`);
    });

    child.on("exit", (code, signal) => {
      entry.exited = true;
      const how = signal ? `signal ${signal}` : `code ${code}`;

      if (shuttingDown) {
        log(`${spec.name} exited during shutdown (${how})`);
        finishIfAllExited();
        return;
      }

      // An unexpected exit, INCLUDING a clean one: a long-running server that
      // returns 0 on its own has still stopped serving, and leaving the other
      // child alive would present a half-working deployment as healthy.
      log(`${spec.name} exited unexpectedly (${how}); taking the service down`);
      exitCode = code && code !== 0 ? code : 1;
      shutdown(`${spec.name} exited`);
    });
  }

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => shutdown(`received ${signal}`, signal));
  }

  log(`supervising ${specs.length} children (grace ${SHUTDOWN_GRACE_MS}ms)`);
}

// Only run when executed directly, so the helpers above stay unit-testable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
