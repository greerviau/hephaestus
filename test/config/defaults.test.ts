import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, importSkill } from "../../src/config/defaults.js";
import { validateConfig } from "../../src/config/document.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hephaestus-skill-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("defaultConfig", () => {
  it("ships a valid config with the three role templates and the factory instructions", () => {
    const config = defaultConfig([]);

    expect(validateConfig(config)).toBe(config);
    expect(config.roles.planner.persona).toContain("file_issue");
    expect(config.roles.lead.persona).toContain("start_work");
    expect(config.roles.improver.persona).toContain("propose_version");
    expect(config.instructions.factory).toContain("hephaestus-result");
    expect(config.projects).toEqual({});
  });

  it("includes imported skills", () => {
    const config = defaultConfig([{ name: "review", files: { "SKILL.md": "# Review\n" } }]);

    expect(config.skills.review).toEqual({ "SKILL.md": "# Review\n" });
  });
});

describe("importSkill", () => {
  it("reads a skill folder's text files, named after the folder", () => {
    const skill = join(dir, "review");
    mkdirSync(join(skill, "references"), { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "# Review\n");
    writeFileSync(join(skill, "references/checklist.md"), "- one\n");

    expect(importSkill(skill)).toEqual({
      name: "review",
      files: { "SKILL.md": "# Review\n", "references/checklist.md": "- one\n" },
    });
  });

  it("refuses a folder without SKILL.md", () => {
    expect(() => importSkill(dir)).toThrow(/SKILL\.md/);
  });

  it("refuses a binary file", () => {
    const skill = join(dir, "pictures");
    mkdirSync(skill);
    writeFileSync(join(skill, "SKILL.md"), "# Pictures\n");
    writeFileSync(join(skill, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));

    expect(() => importSkill(skill)).toThrow(/logo\.png/);
  });
});
