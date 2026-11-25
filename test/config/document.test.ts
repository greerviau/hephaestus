import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  DEFAULT_FACTORY,
  normalizeConfig,
  validateConfig,
} from "../../src/config/document.js";
import { sampleConfig } from "./fixtures.js";

function problems(value: unknown): string[] {
  try {
    validateConfig(normalizeConfig(value));
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.problems;
    throw error;
  }
  return [];
}

describe("factory settings", () => {
  it("fills in the defaults for a config without them", () => {
    const rest: Partial<ReturnType<typeof sampleConfig>> = sampleConfig();
    delete rest.factory;
    expect((normalizeConfig(rest) as { factory: unknown }).factory).toEqual(DEFAULT_FACTORY);
  });

  it("keeps given limits and fills in the missing ones", () => {
    const config = { ...sampleConfig(), factory: { limits: { threads: 9 } } };
    expect(
      (normalizeConfig(config) as typeof DEFAULT_FACTORY & { factory: typeof DEFAULT_FACTORY })
        .factory.limits,
    ).toEqual({
      ...DEFAULT_FACTORY.limits,
      threads: 9,
    });
  });

  it("rejects unknown thread skills, bad limits, and models without a name", () => {
    const config = sampleConfig();
    config.factory.threadSkills = ["missing"];
    config.factory.limits.threads = -1;
    config.factory.models.codex.model = "";
    expect(problems(config)).toEqual([
      "factory.models.codex.model must be a non-empty string",
      "factory.limits.threads must be a whole number of 0 or more",
      "factory.threadSkills names unknown skill missing",
    ]);
  });

  it("accepts a thread skill that exists", () => {
    const config = sampleConfig();
    config.factory.threadSkills = ["triage"];
    expect(problems(config)).toEqual([]);
  });
});
