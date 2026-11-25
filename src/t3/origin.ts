import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { EnvironmentSource } from "../web/environments.js";
import type { Environments } from "./adapter.js";

const DEFAULT_PORT = 3773;

/**
 * The loopback origin of this host's T3 server, from the port in T3's runtime
 * file. Hephaestus always talks to T3 over loopback, even when T3 also listens on the LAN.
 */
export function resolveT3Origin(
  env: NodeJS.ProcessEnv,
  home: string,
  recordedHome?: string,
): string {
  const root =
    env.T3CODE_HOME !== undefined && isAbsolute(env.T3CODE_HOME)
      ? env.T3CODE_HOME
      : (recordedHome ?? join(home, ".t3"));
  try {
    const runtime = JSON.parse(
      readFileSync(join(root, "userdata", "server-runtime.json"), "utf8"),
    ) as {
      port?: unknown;
    };
    if (typeof runtime.port === "number") return `http://127.0.0.1:${String(runtime.port)}`;
  } catch {
    // T3 is not running, or not installed here; use its default port.
  }
  return `http://127.0.0.1:${String(DEFAULT_PORT)}`;
}

/** Wraps an environment source so pages do not call T3 on every request. */
export function cachedEnvironments(
  source: EnvironmentSource,
  ttlMs: number,
  now: () => number = Date.now,
): EnvironmentSource {
  let cached: { at: number; value: Environments } | { at: number; error: unknown } | undefined;
  let pending: Promise<Environments> | undefined;
  // A failure is kept briefly too, so a page that gave up waiting sees it on the next load.
  const errorTtlMs = Math.min(ttlMs, 10_000);
  return {
    environments() {
      if (cached !== undefined) {
        const age = now() - cached.at;
        if ("value" in cached && age < ttlMs) return Promise.resolve(cached.value);
        if ("error" in cached && age < errorTtlMs) {
          return Promise.reject(
            cached.error instanceof Error ? cached.error : new Error(String(cached.error)),
          );
        }
      }
      pending ??= source.environments().then(
        (value) => {
          cached = { at: now(), value };
          pending = undefined;
          return value;
        },
        (error: unknown) => {
          cached = { at: now(), error };
          pending = undefined;
          throw error;
        },
      );
      return pending;
    },
  };
}

/**
 * The absolute path of `name` on `path`. Install records it, because the
 * systemd user manager's PATH is usually shorter than a login shell's.
 */
export function findExecutable(name: string, path: string | undefined): string | undefined {
  for (const dir of (path ?? "").split(":")) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}
