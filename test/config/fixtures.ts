import { DEFAULT_FACTORY, type FactoryConfig } from "../../src/config/document.js";

export function sampleConfig(): FactoryConfig {
  return {
    factory: structuredClone(DEFAULT_FACTORY),
    projects: {
      "octo/app": { policy: { preset: "standard", overrides: {} } },
    },
    roles: {
      communicator: { persona: "Plan the work.", skills: ["triage"] },
      lead: { persona: "Lead the work.", skills: [] },
      improver: { persona: "Improve the config.", skills: [] },
    },
    instructions: { factory: "# Factory instructions\n" },
    skills: { triage: { "SKILL.md": "# Triage\n" } },
  };
}
