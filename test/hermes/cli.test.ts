import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hermesRunner } from "../../src/hermes/cli.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hephaestus-hermes-cli-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("hermesRunner", () => {
  it("reports the error Hermes printed on stdout, without the install warning on stderr", async () => {
    const fake = join(dir, "hermes");
    writeFileSync(
      fake,
      [
        "#!/bin/sh",
        'echo "⚠ install out of sync (pnpm: not installed or outdated)" >&2',
        'echo "Error: No distribution.yaml in /x."',
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(fake, 0o755);

    await expect(hermesRunner(fake, dir)(["profile", "install", "/x"])).rejects.toThrow(
      /No distribution\.yaml/,
    );
  });

  it("sets HERMES_HOME to the factory root", async () => {
    const fake = join(dir, "hermes");
    writeFileSync(fake, '#!/bin/sh\necho "$HERMES_HOME"\n');
    chmodSync(fake, 0o755);

    expect((await hermesRunner(fake, "/factory/root")(["x"])).trim()).toBe("/factory/root");
  });
});
