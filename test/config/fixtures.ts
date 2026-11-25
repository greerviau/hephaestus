import type { FactoryConfig } from "../../src/config/document.js";

export function sampleConfig(): FactoryConfig {
  return {
    projects: {
      "octo/app": { policy: { preset: "standard", overrides: {} } },
    },
    roles: {
      planner: { persona: "Plan the work.", skills: ["triage"] },
      lead: { persona: "Lead the work.", skills: [] },
      improver: { persona: "Improve the config.", skills: [] },
    },
    instructions: { factory: "# Factory instructions\n" },
    skills: { triage: { "SKILL.md": "# Triage\n" } },
  };
}
