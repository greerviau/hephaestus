import { describe, expect, it } from "vitest";
import { PRESET_NAMES, PRESETS, resolvePolicy } from "../../src/config/policy.js";

describe("policy presets", () => {
  it("yolo auto-merges on green checks with no review and no escalation paths", () => {
    expect(resolvePolicy({ preset: "yolo", overrides: {} })).toEqual({
      autoMerge: true,
      requireReview: false,
      ownerApprovesEveryMerge: false,
      escalationPaths: [],
      maxReviewRounds: 2,
      openIssueCap: 5,
      autoRevert: true,
      allowNoChecks: false,
      requiredChecks: [],
    });
  });

  it("standard needs a cross-provider review and honours escalation paths", () => {
    expect(resolvePolicy({ preset: "standard", overrides: {} })).toEqual({
      autoMerge: true,
      requireReview: true,
      ownerApprovesEveryMerge: false,
      escalationPaths: [".github/workflows/**"],
      maxReviewRounds: 2,
      openIssueCap: 5,
      autoRevert: true,
      allowNoChecks: false,
      requiredChecks: [],
    });
  });

  it("strict makes every merge wait for the owner", () => {
    const strict = resolvePolicy({ preset: "strict", overrides: {} });

    expect(strict.ownerApprovesEveryMerge).toBe(true);
    expect(strict.autoMerge).toBe(false);
    expect(strict.autoRevert).toBe(true);
  });

  it("applies a project override to its own setting only", () => {
    const resolved = resolvePolicy({ preset: "standard", overrides: { maxReviewRounds: 4 } });

    expect(resolved).toEqual({ ...PRESETS.standard, maxReviewRounds: 4 });
  });
});

describe("PRESET_NAMES", () => {
  it("lists the presets from most to least strict", () => {
    expect(PRESET_NAMES).toEqual(["strict", "standard", "yolo"]);
  });
});
