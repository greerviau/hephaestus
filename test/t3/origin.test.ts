import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cachedEnvironments, findExecutable, resolveT3Origin } from "../../src/t3/origin.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hephaestus-origin-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("resolveT3Origin", () => {
  it("reads the running server's loopback origin from T3's runtime file", () => {
    mkdirSync(join(home, ".t3/userdata"), { recursive: true });
    writeFileSync(
      join(home, ".t3/userdata/server-runtime.json"),
      JSON.stringify({ origin: "http://127.0.0.1:4000", port: 4000 }),
    );

    expect(resolveT3Origin({}, home)).toBe("http://127.0.0.1:4000");
  });

  it("honours T3CODE_HOME", () => {
    mkdirSync(join(home, "custom/userdata"), { recursive: true });
    writeFileSync(
      join(home, "custom/userdata/server-runtime.json"),
      JSON.stringify({ port: 4100 }),
    );

    expect(resolveT3Origin({ T3CODE_HOME: join(home, "custom") }, home)).toBe(
      "http://127.0.0.1:4100",
    );
  });

  it("falls back to T3's default port", () => {
    expect(resolveT3Origin({}, home)).toBe("http://127.0.0.1:3773");
  });
});

describe("cachedEnvironments", () => {
  it("reuses a result until it is older than the time to live", async () => {
    let now = 0;
    let calls = 0;
    const source = cachedEnvironments(
      {
        environments: () => {
          calls += 1;
          return Promise.resolve({ localEnvironmentId: String(calls), environments: [] });
        },
      },
      30_000,
      () => now,
    );

    await source.environments();
    now = 29_000;
    expect((await source.environments()).localEnvironmentId).toBe("1");
    now = 31_000;
    expect((await source.environments()).localEnvironmentId).toBe("2");
  });

  it("keeps a failure briefly, so a page that stopped waiting sees it on the next load", async () => {
    let now = 0;
    let calls = 0;
    const source = cachedEnvironments(
      {
        environments: () => {
          calls += 1;
          return Promise.reject(new Error("ECONNREFUSED"));
        },
      },
      30_000,
      () => now,
    );
    await expect(source.environments()).rejects.toThrow("ECONNREFUSED");
    now = 5_000;
    await expect(source.environments()).rejects.toThrow("ECONNREFUSED");
    expect(calls).toBe(1);
    now = 11_000;
    await expect(source.environments()).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

describe("findExecutable", () => {
  it("finds an executable on PATH and returns its absolute path", () => {
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin/t3"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(home, "bin/notexec"), "", { mode: 0o644 });

    expect(findExecutable("t3", `/nowhere:${join(home, "bin")}`)).toBe(join(home, "bin/t3"));
    expect(findExecutable("notexec", join(home, "bin"))).toBeUndefined();
    expect(findExecutable("t3", "")).toBeUndefined();
  });
});

describe("resolveT3Origin with a recorded data directory", () => {
  it("uses the directory install recorded when the service has no T3CODE_HOME", () => {
    mkdirSync(join(home, "custom/userdata"), { recursive: true });
    writeFileSync(
      join(home, "custom/userdata/server-runtime.json"),
      JSON.stringify({ port: 17773 }),
    );

    expect(resolveT3Origin({}, home, join(home, "custom"))).toBe("http://127.0.0.1:17773");
  });
});
