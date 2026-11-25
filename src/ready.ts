import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "./config.js";
import { INSTANCE_HEADER } from "./server.js";

/**
 * Polls the dashboard on loopback until it answers with this install's
 * instance id. Another server on the same port does not count.
 */
export async function waitForDashboard(
  config: Config,
  { timeoutMs = 15_000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${String(config.port)}/login`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(intervalMs * 4) });
      await response.body?.cancel();
      if (response.headers.get(INSTANCE_HEADER) === config.instanceId) return;
    } catch {
      // Not listening yet.
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `The dashboard did not answer on port ${String(config.port)} within ${String(timeoutMs / 1000)} s. ` +
      "Check `journalctl --user -u hephaestus.service`; another program may hold the port.",
  );
}
