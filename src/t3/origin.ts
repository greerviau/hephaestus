import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { EnvironmentSource } from "../web/environments.js";
import type { Environments } from "./adapter.js";

const DEFAULT_PORT = 3773;

/**
 * The loopback origin of this host's T3 server, from the port in T3's runtime
 * file. Hephaestus always talks to T3 over loopback, even when T3 also listens on the LAN.
 */
export function resolveT3Origin(env: NodeJS.ProcessEnv, home: string): string {
  const root =
    env.T3CODE_HOME !== undefined && isAbsolute(env.T3CODE_HOME)
      ? env.T3CODE_HOME
      : join(home, ".t3");
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
  let cached: { at: number; value: Environments } | undefined;
  return {
    async environments() {
      if (cached !== undefined && now() - cached.at < ttlMs) return cached.value;
      const value = await source.environments();
      cached = { at: now(), value };
      return value;
    },
  };
}
