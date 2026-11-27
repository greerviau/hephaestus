import { describe, expect, it } from "vitest";
import { formatHostHealth, hostHealth, systemProbe, type HostProbe } from "../src/host-health.js";
import { openStore } from "../src/store.js";

const NOW = new Date("2026-11-25T12:00:00Z");
const GIB = 1024 ** 3;

const probe: HostProbe = {
  loadAverage: () => [0.5, 1, 1.5],
  cpuCount: () => 8,
  totalMemory: () => 16 * GIB,
  freeMemory: () => 4 * GIB,
  disk: () => ({ total: 100 * GIB, free: 40 * GIB }),
  uptimeSeconds: () => 90_000,
  processUptimeSeconds: () => 3_700,
  serviceState: (unit) => (unit === "hephaestus.service" ? "active" : undefined),
};

describe("hostHealth", () => {
  it("reports CPU, memory, disk, uptime, services, workers, and recent errors", () => {
    const db = openStore(":memory:");
    db.prepare(
      `INSERT INTO workers (environment_id, label, enabled, deployed_version, instance_problem, created_at, updated_at)
       VALUES ('e1', 'Worker one', 1, 3, 'not signed in', 'x', 'x')`,
    ).run();
    const call = db.prepare(
      "INSERT INTO mcp_calls (role, tool, arguments, ok, result, at) VALUES ('lead', ?, '{}', ?, ?, ?)",
    );
    call.run(
      "start_work",
      0,
      JSON.stringify({ error: "card is not admitted" }),
      "2026-11-25T10:00:00Z",
    );
    call.run("start_work", 1, "{}", "2026-11-25T10:30:00Z");
    call.run("escalate", 0, JSON.stringify({ error: "too old" }), "2026-11-01T10:00:00Z");
    db.prepare(
      `INSERT INTO factory_launches (client_request_id, environment_id, title, provider_instance_id, model, config_version, status, error, created_at, updated_at)
       VALUES ('r1', 'e1', 't', 'i', 'm', 1, 'failed', 'T3 was unreachable', 'x', '2026-11-25T11:00:00Z')`,
    ).run();

    const health = hostHealth(db, { path: "/", window: "24h", now: NOW, probe });
    expect(health.cpu).toEqual({
      cores: 8,
      load: { oneMinute: 0.5, fiveMinutes: 1, fifteenMinutes: 1.5 },
    });
    expect(health.memory).toMatchObject({ usedPercent: 75 });
    expect(health.disk).toMatchObject({ usedPercent: 60 });
    expect(health.uptimeSeconds).toBe(90_000);
    expect(health.hephaestus).toEqual({
      processUptimeSeconds: 3700,
      service: "active",
      hermesGateway: null,
    });
    expect(health.workers).toEqual([
      { label: "Worker one", enabled: true, deployedVersion: 3, problem: "not signed in" },
    ]);
    expect(health.recentErrors.map((error) => [error.source, error.message])).toEqual([
      ["thread launch", "T3 was unreachable"],
      ["tool call start_work", "card is not admitted"],
    ]);

    const text = formatHostHealth(health);
    expect(text).toContain("CPU: 8 cores, load average 0.50 (1 min)");
    expect(text).toContain("Memory: 75% used, 4.0 GiB free of 16.0 GiB");
    expect(text).toContain("Disk: 60% used");
    expect(text).toContain("Host uptime: 1 d 1 h");
    expect(text).toContain("Hephaestus service: active");
    expect(text).toContain("Hermes gateway service: unknown (systemd could not be asked)");
    expect(text).toContain("Worker one: enabled, config version 3, problem: not signed in");
    expect(text).not.toMatch(/\|/);
  });

  it("says when the disk cannot be read and no errors are recorded", () => {
    const db = openStore(":memory:");
    const health = hostHealth(db, {
      path: "/",
      now: NOW,
      probe: { ...probe, disk: () => undefined },
    });
    expect(health.disk).toBeNull();
    const text = formatHostHealth(health);
    expect(text).toContain("Disk: could not be read.");
    expect(text).toContain("Workers: none set up.");
    expect(text).toContain("Recent errors: none recorded in the last 24h.");
  });

  it("reads real numbers from the system", () => {
    const db = openStore(":memory:");
    const health = hostHealth(db, {
      path: "/",
      now: NOW,
      probe: { ...systemProbe, serviceState: () => undefined },
    });
    expect(health.cpu.cores).toBeGreaterThan(0);
    expect(health.memory.totalBytes).toBeGreaterThan(0);
    expect(health.uptimeSeconds).toBeGreaterThan(0);
  });
});
