import { spawnSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem, uptime } from "node:os";
import type { Database } from "better-sqlite3";
import { GATEWAY_SERVICE_NAME, SERVICE_NAME } from "./paths.js";
import { parseWindow } from "./factory/stats.js";

/** The machine's numbers, read from the system. Tests supply their own. */
export interface HostProbe {
  loadAverage(): number[];
  cpuCount(): number;
  totalMemory(): number;
  freeMemory(): number;
  /** Bytes total and free on the disk that holds `path`, or undefined when it cannot be read. */
  disk(path: string): { total: number; free: number } | undefined;
  /** Seconds since the machine booted. */
  uptimeSeconds(): number;
  /** Seconds since Hephaestus's own process started. */
  processUptimeSeconds(): number;
  /** What `systemctl --user is-active` says of a unit, or undefined when systemd cannot be asked. */
  serviceState(unit: string): string | undefined;
}

export const systemProbe: HostProbe = {
  loadAverage: () => loadavg(),
  cpuCount: () => cpus().length,
  totalMemory: () => totalmem(),
  freeMemory: () => freemem(),
  disk(path) {
    try {
      const stats = statfsSync(path);
      return { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize };
    } catch {
      return undefined;
    }
  },
  uptimeSeconds: () => uptime(),
  processUptimeSeconds: () => process.uptime(),
  serviceState(unit) {
    const result = spawnSync("systemctl", ["--user", "is-active", unit], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    if (result.error !== undefined) return undefined;
    const state = result.stdout.trim();
    return state === "" ? undefined : state;
  },
};

export interface HostHealth {
  cpu: { cores: number; load: { oneMinute: number; fiveMinutes: number; fifteenMinutes: number } };
  memory: { totalBytes: number; freeBytes: number; usedPercent: number };
  /** Null when the disk could not be read. */
  disk: { totalBytes: number; freeBytes: number; usedPercent: number } | null;
  uptimeSeconds: number;
  hephaestus: {
    processUptimeSeconds: number;
    service: string | null;
    hermesGateway: string | null;
  };
  workers: {
    label: string;
    enabled: boolean;
    deployedVersion: number | null;
    problem: string | null;
  }[];
  /** Failures Hephaestus recorded in the window, newest first. */
  recentErrors: { source: string; at: string; message: string }[];
  errorWindow: string;
}

const GIB = 1024 ** 3;

function percent(used: number, total: number): number {
  return total <= 0 ? 0 : Math.round((used / total) * 1000) / 10;
}

/**
 * The host's CPU, memory, disk, and uptime, the state of Hephaestus's
 * services and workers, and the failures recorded in the window. It only
 * reads.
 */
export function hostHealth(
  db: Database,
  options: { path: string; window?: string | undefined; now?: Date; probe?: HostProbe },
): HostHealth {
  const probe = options.probe ?? systemProbe;
  const window = parseWindow(options.window ?? "24h", options.now ?? new Date());
  const [one = 0, five = 0, fifteen = 0] = probe.loadAverage();
  const total = probe.totalMemory();
  const free = probe.freeMemory();
  const disk = probe.disk(options.path);

  const errors = [
    ...(
      db
        .prepare(
          `SELECT 'tool call ' || tool AS source, at, result AS message FROM mcp_calls
           WHERE ok = 0 AND at >= ? AND at <= ?`,
        )
        .all(window.since, window.until) as { source: string; at: string; message: string }[]
    ).map((row) => ({ ...row, message: errorText(row.message) })),
    ...(
      db
        .prepare(
          `SELECT 'worker task ' || kind AS source, updated_at AS at, detail AS message FROM worker_tasks
           WHERE status = 'failed' AND updated_at >= ? AND updated_at <= ?`,
        )
        .all(window.since, window.until) as { source: string; at: string; message: string }[]
    ).map((row) => ({ ...row, message: errorText(row.message) })),
    ...(db
      .prepare(
        `SELECT 'thread launch' AS source, updated_at AS at, COALESCE(error, '') AS message FROM factory_launches
           WHERE status = 'failed' AND updated_at >= ? AND updated_at <= ?`,
      )
      .all(window.since, window.until) as { source: string; at: string; message: string }[]),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20)
    .map((row) => ({ ...row, message: row.message.slice(0, 300) }));

  const workers = (
    db
      .prepare(
        "SELECT label, enabled, deployed_version AS deployedVersion, instance_problem AS problem FROM workers ORDER BY label",
      )
      .all() as {
      label: string;
      enabled: number;
      deployedVersion: number | null;
      problem: string | null;
    }[]
  ).map((row) => ({ ...row, enabled: row.enabled === 1 }));

  return {
    cpu: {
      cores: probe.cpuCount(),
      load: { oneMinute: one, fiveMinutes: five, fifteenMinutes: fifteen },
    },
    memory: { totalBytes: total, freeBytes: free, usedPercent: percent(total - free, total) },
    disk:
      disk === undefined
        ? null
        : {
            totalBytes: disk.total,
            freeBytes: disk.free,
            usedPercent: percent(disk.total - disk.free, disk.total),
          },
    uptimeSeconds: Math.round(probe.uptimeSeconds()),
    hephaestus: {
      processUptimeSeconds: Math.round(probe.processUptimeSeconds()),
      service: probe.serviceState(SERVICE_NAME) ?? null,
      hermesGateway: probe.serviceState(GATEWAY_SERVICE_NAME) ?? null,
    },
    workers,
    recentErrors: errors,
    errorWindow: window.label,
  };
}

/** A tool-call result or task detail is JSON; the message inside is what matters. */
function errorText(raw: string): string {
  try {
    const value = JSON.parse(raw) as { error?: unknown; reason?: unknown };
    for (const field of [value.error, value.reason]) if (typeof field === "string") return field;
  } catch {
    // Not JSON: keep the text as it is.
  }
  return raw;
}

function duration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${String(days)} d ${String(hours)} h`;
  if (hours > 0) return `${String(hours)} h ${String(minutes)} min`;
  return `${String(minutes)} min`;
}

const gib = (bytes: number): string => (bytes / GIB).toFixed(1);

/** The health report as bullet lines for a chat, with no table. */
export function formatHostHealth(health: HostHealth): string {
  const lines = ["Host health:"];
  const { load } = health.cpu;
  lines.push(
    `- CPU: ${String(health.cpu.cores)} cores, load average ${load.oneMinute.toFixed(2)} (1 min), ${load.fiveMinutes.toFixed(2)} (5 min), ${load.fifteenMinutes.toFixed(2)} (15 min).`,
  );
  lines.push(
    `- Memory: ${String(health.memory.usedPercent)}% used, ${gib(health.memory.freeBytes)} GiB free of ${gib(health.memory.totalBytes)} GiB.`,
  );
  lines.push(
    health.disk === null
      ? "- Disk: could not be read."
      : `- Disk: ${String(health.disk.usedPercent)}% used, ${gib(health.disk.freeBytes)} GiB free of ${gib(health.disk.totalBytes)} GiB.`,
  );
  lines.push(`- Host uptime: ${duration(health.uptimeSeconds)}.`);
  const state = (value: string | null): string => value ?? "unknown (systemd could not be asked)";
  lines.push(
    `- Hephaestus service: ${state(health.hephaestus.service)}, process up ${duration(health.hephaestus.processUptimeSeconds)}.`,
  );
  lines.push(`- Hermes gateway service: ${state(health.hephaestus.hermesGateway)}.`);
  if (health.workers.length === 0) lines.push("- Workers: none set up.");
  else {
    lines.push("- Workers:");
    for (const worker of health.workers) {
      const parts = [
        worker.enabled ? "enabled" : "disabled",
        worker.deployedVersion === null
          ? "no config deployed"
          : `config version ${String(worker.deployedVersion)}`,
        worker.problem === null ? "no problem reported" : `problem: ${worker.problem}`,
      ];
      lines.push(`  - ${worker.label}: ${parts.join(", ")}.`);
    }
  }
  if (health.recentErrors.length === 0) {
    lines.push(`- Recent errors: none recorded in the last ${health.errorWindow}.`);
  } else {
    lines.push(`- Recent errors in the last ${health.errorWindow}:`);
    for (const error of health.recentErrors.slice(0, 10)) {
      lines.push(`  - ${error.at} ${error.source}: ${error.message}`);
    }
  }
  return lines.join("\n");
}
