import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** A unit of work is a task everywhere; the old name must not creep back in. */
const OLD_NAME = /\bcards?\b/i;

/**
 * The only place the old name stays: the migration that renames it, which has to name the old
 * tables, columns, and words to find them in an installed database.
 */
const ALLOWED = new Set(["src/store.ts"]);

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function sources(): string[] {
  const roots = ["src", "templates", "docs", ".agents"].flatMap((dir) => files(join(ROOT, dir)));
  const text = roots.filter((path) => /\.(ts|md|py|yaml|yml|sh|json)$/.test(path));
  return [...text, join(ROOT, "README.md"), join(ROOT, "AGENTS.md")].filter(
    (path) => !ALLOWED.has(relative(ROOT, path)),
  );
}

describe("naming", () => {
  it("never calls a unit of work a card in prompts, skills, tool definitions, or code", () => {
    const found = sources().flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          OLD_NAME.test(line)
            ? [`${relative(ROOT, path)}:${String(index + 1)}: ${line.trim()}`]
            : [],
        ),
    );
    expect(found).toEqual([]);
  });

  it("keeps the old name out of the shipped roles and starter skills", () => {
    for (const path of files(join(ROOT, "templates"))) {
      expect(readFileSync(path, "utf8"), relative(ROOT, path)).not.toMatch(OLD_NAME);
    }
  });
});
