import type { ModelChoice } from "./document.js";

export type EffortProvider = "claude" | "codex";

/**
 * The effort levels T3 offers for each provider's models, and the T3 option id that carries
 * the level. The Models page's selectors and config validation both read this list.
 */
export const EFFORT: Record<EffortProvider, { optionId: string; levels: readonly string[] }> = {
  claude: { optionId: "effort", levels: ["low", "medium", "high", "xhigh", "max", "ultrathink"] },
  codex: {
    optionId: "reasoningEffort",
    levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
};

/**
 * The models T3 offers for each provider, as the Models page lists them in its model
 * selectors. Config validation does not read this list, so a model T3 adds later can still be
 * set on the JSON tab, and a saved model missing here stays selectable on the page.
 */
export const MODELS: Record<EffortProvider, readonly string[]> = {
  claude: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-haiku-5-5"],
  codex: [
    "gpt-6.2-sol",
    "gpt-6.2-astra",
    "gpt-6.1-terra",
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6-luna",
  ],
};

/**
 * The effort level each listed model starts at on the Models page, so its effort dropdown
 * always shows a real level. Every model in `MODELS` has one, and each is one of its
 * provider's `EFFORT` levels.
 */
export const MODEL_EFFORT: Readonly<Record<string, string>> = {
  "claude-opus-5-5": "high",
  "claude-sonnet-5-5": "high",
  "claude-fable-5-2": "high",
  "claude-haiku-5-5": "medium",
  "gpt-6.2-sol": "medium",
  "gpt-6.2-astra": "medium",
  "gpt-6.1-terra": "medium",
  "gpt-6.1-sol": "medium",
  "gpt-6-astra": "medium",
  "gpt-6-luna": "low",
};

/** The level a model of this provider that `MODEL_EFFORT` does not list starts at. */
const PROVIDER_EFFORT: Record<EffortProvider, string> = { claude: "high", codex: "medium" };

/**
 * The level the Models page preselects for a model that sets no effort: its own default, or
 * its provider's for a model the list does not name.
 */
export function defaultEffort(provider: EffortProvider, model: string): string {
  const level = MODEL_EFFORT[model];
  return level !== undefined && EFFORT[provider].levels.includes(level)
    ? level
    : PROVIDER_EFFORT[provider];
}

export const PROVIDER_LABELS: Record<EffortProvider, string> = { claude: "Claude", codex: "Codex" };

/** The providers the factory supports, in the order the Models page lists them. */
export const PROVIDERS: readonly EffortProvider[] = ["claude", "codex"];

/**
 * The provider instances T3 creates for each provider, as the Models page lists them for
 * housekeeping. A saved instance missing here stays selectable under the provider it names.
 */
export const INSTANCES: Record<EffortProvider, readonly string[]> = {
  claude: ["claudeAgent"],
  codex: ["codex"],
};

/** The T3 option ids that set effort, for reading back which effort a launch used. */
export const EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(
  Object.values(EFFORT).map(({ optionId }) => optionId),
);

/**
 * The provider behind a housekeeping instance id. T3 names its own instances after their
 * driver, such as claudeAgent and codex, so an id that starts with a provider's name is taken
 * as that provider. Any other id has no known effort levels.
 */
export function providerOfInstance(instanceId: string): EffortProvider | undefined {
  const id = instanceId.trim().toLowerCase();
  if (id.startsWith("claude") || id === "hephaestus-claude") return "claude";
  if (id.startsWith("codex") || id === "hephaestus-codex") return "codex";
  return undefined;
}

/**
 * What the config says is wrong with a choice's effort, or undefined when nothing is. An
 * absent effort is always fine: T3 then uses the model's own default.
 */
export function effortProblem(
  path: string,
  effort: unknown,
  provider: EffortProvider | undefined,
  options: unknown,
): string | undefined {
  if (effort === undefined) return undefined;
  if (provider === undefined) {
    return `${path}.effort can only be set for a Claude or Codex provider instance`;
  }
  const { optionId, levels } = EFFORT[provider];
  if (typeof effort !== "string" || !levels.includes(effort)) {
    return `${path}.effort must be one of ${levels.join(", ")} for ${PROVIDER_LABELS[provider]}, not ${JSON.stringify(effort)}`;
  }
  if (typeof options === "object" && options !== null && Object.hasOwn(options, optionId)) {
    return `${path} sets effort twice: remove options.${optionId} or effort`;
  }
  return undefined;
}

/**
 * The model and T3 options a thread launches with. A choice's effort becomes the provider's
 * effort option; without one, the options go to T3 as the config has them.
 */
export function launchModel(
  choice: ModelChoice,
  provider: EffortProvider | undefined,
): { model: string; options?: { id: string; value: string | boolean }[] } {
  const options = Object.entries(choice.options ?? {}).map(([id, value]) => ({ id, value }));
  if (choice.effort !== undefined && provider !== undefined) {
    options.push({ id: EFFORT[provider].optionId, value: choice.effort });
  }
  return options.length === 0 ? { model: choice.model } : { model: choice.model, options };
}

/** The effort a launch's options set, if any. */
export function effortOf(
  options: { id: string; value: string | boolean }[] | undefined,
): string | null {
  const found = options?.find((option) => EFFORT_OPTION_IDS.has(option.id));
  return found === undefined ? null : String(found.value);
}
