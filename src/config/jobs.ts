import {
  DEFAULT_FACTORY,
  type FactorySettings,
  type JobModelChoice,
  type ModelChoice,
} from "./document.js";
import { PROVIDERS, type EffortProvider } from "./effort.js";

/** The factory's coding jobs. */
export type FactoryJob = "implement" | "review";

/** The slot in `FactorySettings.models` that holds each job's choice. */
export const JOB_SLOTS = { implement: "claude", review: "codex" } as const satisfies Record<
  FactoryJob,
  EffortProvider
>;

/** A job's model choice, without the provider it names. */
export function jobChoice(factory: Pick<FactorySettings, "models">, job: FactoryJob): ModelChoice {
  const choice: JobModelChoice = { ...factory.models[JOB_SLOTS[job]] };
  delete choice.provider;
  return choice;
}

/** The provider a job runs on: the one its choice names, else the one its slot is named after. */
export function jobProvider(
  factory: Pick<FactorySettings, "models">,
  job: FactoryJob,
): EffortProvider {
  return factory.models[JOB_SLOTS[job]].provider ?? JOB_SLOTS[job];
}

/** The providers the coding jobs use, in the order the Models page lists providers. */
export function providersInUse(factory: Pick<FactorySettings, "models">): EffortProvider[] {
  const used = new Set([jobProvider(factory, "implement"), jobProvider(factory, "review")]);
  return PROVIDERS.filter((provider) => used.has(provider));
}

/**
 * The model a thread of `job` runs on `provider`. That is the job's own choice while the job
 * uses that provider. A task that began on a provider the job no longer uses keeps running there,
 * so it takes the choice of the other job on that provider, or the provider's default model.
 */
export function modelFor(
  factory: Pick<FactorySettings, "models">,
  job: FactoryJob,
  provider: EffortProvider,
): ModelChoice {
  const other: FactoryJob = job === "implement" ? "review" : "implement";
  for (const each of [job, other]) {
    if (jobProvider(factory, each) === provider) return jobChoice(factory, each);
  }
  return { model: DEFAULT_FACTORY.models[provider].model };
}
