import { describe, expect, it } from "vitest";
import { PRESETS, type PresetName } from "../../src/config/policy.js";
import {
  decideMerge,
  matchesGlob,
  parseImplementResult,
  parseReviewResult,
  type GateInput,
} from "../../src/factory/gate.js";

const SHA = "f".repeat(40);

describe("result blocks", () => {
  it("reads the last implement result block", () => {
    const text = `Done.\n\n\`\`\`hephaestus-result\n{"status": "done", "pr": 7, "headSha": "${SHA}"}\n\`\`\``;
    expect(parseImplementResult(text)).toEqual({ status: "done", pr: 7, headSha: SHA });
  });

  it("counts a malformed block as no result", () => {
    expect(parseImplementResult("no block")).toBeUndefined();
    expect(parseImplementResult("```hephaestus-result\n{not json}\n```")).toBeUndefined();
    expect(
      parseImplementResult(
        '```hephaestus-result\n{"status": "done", "pr": 7, "headSha": "abc"}\n```',
      ),
    ).toBeUndefined();
    expect(
      parseReviewResult(
        `\`\`\`hephaestus-result\n{"verdict": "maybe", "headSha": "${SHA}"}\n\`\`\``,
      ),
    ).toBeUndefined();
  });

  it("reads a blocked result and a review verdict", () => {
    expect(
      parseImplementResult(
        '```hephaestus-result\n{"status": "blocked", "reason": "no access"}\n```',
      ),
    ).toEqual({ status: "blocked", reason: "no access" });
    expect(
      parseReviewResult(
        `\`\`\`hephaestus-result\n{"verdict": "changes", "headSha": "${SHA}", "findings": "1. fix"}\n\`\`\``,
      ),
    ).toEqual({ verdict: "changes", headSha: SHA, findings: "1. fix" });
  });
});

describe("matchesGlob", () => {
  it.each([
    [".github/workflows/**", ".github/workflows/ci.yml", true],
    [".github/workflows/**", ".github/dependabot.yml", false],
    ["**/*.lock", "a/b/c.lock", true],
    ["**/*.lock", "c.lock", true],
    ["*.md", "docs/readme.md", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["infra/?.tf", "infra/a.tf", true],
  ])("%s against %s is %s", (pattern, path, expected) => {
    expect(matchesGlob(pattern, path)).toBe(expected);
  });
});

function input(preset: PresetName, overrides: Partial<GateInput> = {}): GateInput {
  return {
    policy: PRESETS[preset],
    checks: "success",
    failedChecks: [],
    files: ["src/app.ts"],
    approvedAtHead: true,
    ownerApprovedAtHead: false,
    ...overrides,
  };
}

describe("decideMerge under each preset", () => {
  it.each<[PresetName, Partial<GateInput>, string]>([
    ["yolo", {}, "merge"],
    ["yolo", { approvedAtHead: false }, "merge"],
    ["yolo", { files: [".github/workflows/ci.yml"] }, "merge"],
    ["yolo", { checks: "pending" }, "wait"],
    ["yolo", { checks: "failure", failedChecks: ["test"] }, "escalate:lead"],
    ["standard", {}, "merge"],
    ["standard", { checks: "none" }, "merge"],
    ["standard", { approvedAtHead: false }, "escalate:lead"],
    ["standard", { files: [".github/workflows/ci.yml"] }, "escalate:owner"],
    ["standard", { files: [".github/workflows/ci.yml"], ownerApprovedAtHead: true }, "merge"],
    ["standard", { checks: "failure", failedChecks: ["test"] }, "escalate:lead"],
    ["strict", {}, "escalate:owner"],
    ["strict", { ownerApprovedAtHead: true }, "merge"],
    ["strict", { approvedAtHead: false, ownerApprovedAtHead: true }, "escalate:lead"],
  ])("%s with %j: %s", (preset, overrides, expected) => {
    const decision = decideMerge(input(preset, overrides));
    expect(decision.action === "escalate" ? `escalate:${decision.to}` : decision.action).toBe(
      expected,
    );
  });

  it("names the escalation path a PR touches", () => {
    const decision = decideMerge(
      input("standard", { files: ["a.ts", ".github/workflows/ci.yml"] }),
    );
    expect(decision).toEqual({
      action: "escalate",
      to: "owner",
      reason: "the PR touches an escalation path: .github/workflows/ci.yml",
    });
  });

  it("escalates to the owner when auto-merge is off", () => {
    const decision = decideMerge(
      input("standard", { policy: { ...PRESETS.standard, autoMerge: false } }),
    );
    expect(decision).toMatchObject({ action: "escalate", to: "owner" });
  });
});
