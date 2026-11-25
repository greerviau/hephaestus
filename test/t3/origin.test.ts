import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cachedEnvironments, resolveT3Origin } from "../../src/t3/origin.js";

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
});
