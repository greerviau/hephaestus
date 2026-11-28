import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  DEFAULT_FACTORY,
  normalizeConfig,
  validateConfig,
} from "../../src/config/document.js";
import { jobChoice, jobProvider, modelFor, providersInUse } from "../../src/config/jobs.js";
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

describe("skill files", () => {
  it("refuses a file whose path needs another file to be a folder", () => {
    const config = sampleConfig();
    config.skills.triage = { "SKILL.md": "x", "SKILL.md/notes.md": "y", "a/b/c.md": "z", a: "w" };

    expect(problems(config)).toEqual([
      'skills.triage."SKILL.md/notes.md" is inside "SKILL.md", which is a file, not a folder',
      'skills.triage."a/b/c.md" is inside "a", which is a file, not a folder',
    ]);
  });

  it("accepts files side by side in a folder, and names that only start alike", () => {
    const config = sampleConfig();
    config.skills.triage = {
      "SKILL.md": "x",
      "examples/good.md": "y",
      "examples/bad.md": "z",
      "examples-old/a.md": "w",
      example: "v",
    };

    expect(problems(config)).toEqual([]);
  });
});

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

describe("coding model effort", () => {
  it("accepts a config with no effort, as configs from before effort have", () => {
    const config = sampleConfig();
    config.factory.models.codex = { model: "gpt-6.2-sol", options: { effort: "high" } };
    expect(problems(config)).toEqual([]);
    expect(validateConfig(normalizeConfig(config)).factory.models.claude.effort).toBeUndefined();
  });

  it("accepts each provider's own levels", () => {
    const config = sampleConfig();
    config.factory.models.claude.effort = "ultrathink";
    config.factory.models.codex.effort = "ultra";
    config.factory.setup = { instanceId: "codex", model: "gpt-6.2-sol", effort: "xhigh" };
    expect(problems(config)).toEqual([]);
  });

  it("refuses a level the role's provider does not offer, naming the ones it does", () => {
    const config = sampleConfig();
    config.factory.models.claude.effort = "ultra";
    config.factory.models.codex.effort = "ultrathink";
    config.factory.setup.effort = "extreme";
    expect(problems(config)).toEqual([
      'factory.models.claude.effort must be one of low, medium, high, xhigh, max, ultrathink for Claude, not "ultra"',
      'factory.models.codex.effort must be one of low, medium, high, xhigh, max, ultra for Codex, not "ultrathink"',
      'factory.setup.effort must be one of low, medium, high, xhigh, max, ultrathink for Claude, not "extreme"',
    ]);
  });

  it("refuses effort for a housekeeping instance whose provider is not known", () => {
    const config = sampleConfig();
    config.factory.setup = { instanceId: "myCursor", model: "m", effort: "high" };
    expect(problems(config)).toEqual([
      "factory.setup.effort can only be set for a Claude or Codex provider instance",
    ]);
    delete config.factory.setup.effort;
    expect(problems(config)).toEqual([]);
  });

  it("refuses effort set both as effort and as the provider's effort option", () => {
    const config = sampleConfig();
    config.factory.models.codex = {
      model: "gpt-6.2-sol",
      effort: "high",
      options: { reasoningEffort: "low" },
    };
    expect(problems(config)).toEqual([
      "factory.models.codex sets effort twice: remove options.reasoningEffort or effort",
    ]);
  });
});

describe("coding job providers", () => {
  it("reads a config without providers as Implement on Claude and Review on Codex", () => {
    const config = validateConfig(normalizeConfig(sampleConfig()));
    expect(jobProvider(config.factory, "implement")).toBe("claude");
    expect(jobProvider(config.factory, "review")).toBe("codex");
    expect(providersInUse(config.factory)).toEqual(["claude", "codex"]);
  });

  it.each(["claude", "codex"] as const)("accepts both jobs on %s alone", (provider) => {
    const config = sampleConfig();
    const effort = provider === "claude" ? "ultrathink" : "ultra";
    config.factory.models.claude = { model: "m1", provider, effort };
    config.factory.models.codex = { model: "m2", provider, effort };
    expect(problems(config)).toEqual([]);
    expect(providersInUse(config.factory)).toEqual([provider]);
    expect(jobChoice(config.factory, "review")).toEqual({ model: "m2", effort });
  });

  it("checks a job's effort against the provider it names, and refuses an unknown provider", () => {
    const config = sampleConfig();
    config.factory.models.codex = { model: "m", provider: "claude", effort: "ultra" };
    expect(problems(config)).toEqual([
      'factory.models.codex.effort must be one of low, medium, high, xhigh, max, ultrathink for Claude, not "ultra"',
    ]);
    config.factory.models.codex = { model: "m", provider: "gemini" as "claude" };
    expect(problems(config)).toEqual(['factory.models.codex.provider must be "claude" or "codex"']);
  });

  it("gives a provider no job uses its default model, and a moved job's provider the other job's", () => {
    const config = sampleConfig();
    config.factory.models.claude = { model: "claude-opus-5-5", provider: "claude" };
    config.factory.models.codex = { model: "claude-haiku-5-5", provider: "claude" };
    expect(modelFor(config.factory, "review", "claude")).toEqual({ model: "claude-haiku-5-5" });
    // A review that began on Codex before the job moved keeps a Codex model.
    expect(modelFor(config.factory, "review", "codex")).toEqual({
      model: DEFAULT_FACTORY.models.codex.model,
    });
  });
});

describe("project skills", () => {
  it("loads a config whose projects name no skills, and accepts skills that exist", () => {
    const config = sampleConfig();
    expect(problems(config)).toEqual([]);
    config.projects["octo/app"] = {
      policy: { preset: "standard", overrides: {} },
      skills: ["triage"],
    };
    expect(problems(config)).toEqual([]);
  });

  it("refuses a project skill that is not in skills, and a list that is not names", () => {
    const config = sampleConfig();
    config.projects["octo/app"] = {
      policy: { preset: "standard", overrides: {} },
      skills: ["triage", "missing"],
    };
    config.projects["octo/lib"] = {
      policy: { preset: "standard", overrides: {} },
      skills: "triage" as never,
    };
    expect(problems(config)).toEqual([
      "projects.octo/lib.skills must be a list of skill names",
      "projects.octo/app.skills names unknown skill missing",
    ]);
  });
});

describe("cron jobs", () => {
  it("accepts a job turned off, and refuses an on switch that is not true or false", () => {
    const config = sampleConfig();
    config.roles.improver.cron = [
      { name: "nightly", schedule: "30 2 * * *", prompt: "Improve.", enabled: false },
    ];
    expect(problems(config)).toEqual([]);

    (config.roles.improver.cron[0] as unknown as Record<string, unknown>).enabled = "no";
    expect(problems(config)).toEqual(["roles.improver.cron[0].enabled must be true or false"]);
  });
});
