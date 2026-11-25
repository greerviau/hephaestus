import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretsFile } from "../../src/config/secrets.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hephaestus-secrets-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SecretsFile", () => {
  it("stores, lists and deletes secrets in a file only the owner can read", () => {
    const path = join(dir, "secrets.json");
    const secrets = new SecretsFile(path);

    secrets.set("github-token", "ghp_example");
    secrets.set("mcp-credential", "abc");

    expect(new SecretsFile(path).get("github-token")).toBe("ghp_example");
    expect(secrets.names()).toEqual(["github-token", "mcp-credential"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    secrets.delete("github-token");
    expect(secrets.get("github-token")).toBeUndefined();
  });

  it("reads a missing file as empty", () => {
    expect(new SecretsFile(join(dir, "missing.json")).names()).toEqual([]);
  });

  it("rejects names that are not simple identifiers", () => {
    expect(() => {
      new SecretsFile(join(dir, "secrets.json")).set("../escape", "x");
    }).toThrow(/name/);
  });
});

describe("SecretsFile lookups", () => {
  it("returns undefined for a missing secret named like an Object member", () => {
    expect(new SecretsFile(join(dir, "s.json")).get("constructor")).toBeUndefined();
  });
});
