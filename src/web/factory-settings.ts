import { ROLE_NAMES, type FactoryConfig, type ModelChoice } from "../config/document.js";
import { escapeHtml, fold, section, setting } from "./html.js";

/** Reads a form field: what the owner typed when a refused form comes back, else the saved value. */
type Value = (name: string, saved: string) => string;

function valueFrom(submitted: URLSearchParams | undefined): Value {
  return (name, saved) => submitted?.get(name) ?? saved;
}

const NUMBERS = [
  {
    key: "threadsPerWorker",
    label: "Threads per worker",
    // The refusal names the limit in full, as it did before the row had a short label.
    full: "Running factory threads per worker",
    hint: "Implement and review threads running on one machine.",
  },
  {
    key: "threads",
    label: "Threads in all",
    full: "Running factory threads in all",
    hint: "Across every worker.",
  },
  {
    key: "startsPerDay",
    label: "Thread starts per day",
    full: "Factory threads started per day",
    hint: "Per UTC day, across every worker. A cap on spend.",
  },
] as const;

function numberSetting(
  id: string,
  name: string,
  label: string,
  hint: string,
  value: string,
): string {
  return setting(
    id,
    label,
    hint,
    `<input type="number" id="${id}" name="${name}" min="0" step="1" value="${escapeHtml(value)}" required>`,
  );
}

/** The Factory tab's fields: the thread limits, the auto-start wait, and each scheduled job. */
export function limitsAndSchedulesFields(
  config: FactoryConfig,
  submitted?: URLSearchParams,
): string {
  const { factory } = config;
  const value = valueFrom(submitted);
  const limits = [
    ...NUMBERS.map(({ key, label, hint }) =>
      numberSetting(
        `f-${key}`,
        `limits.${key}`,
        label,
        hint,
        value(`limits.${key}`, String(factory.limits[key])),
      ),
    ),
    numberSetting(
      "f-autostart",
      "autoStartMinutes",
      "Auto-start after (minutes)",
      "Starts a task the lead has not started. 0 waits for the lead.",
      value("autoStartMinutes", String(factory.autoStartMinutes)),
    ),
  ].join("");
  const jobs = ROLE_NAMES.flatMap((role) =>
    (config.roles[role].cron ?? []).map((job) => {
      const id = escapeHtml(`f-cron-${role}-${job.name}`);
      const name = escapeHtml(`cron.${role}.${job.name}`);
      return setting(
        `f-cron-${role}-${job.name}`,
        `${role}: ${job.name}`,
        "A cron expression, or a form such as every 2h.",
        `<input type="text" class="w-220" id="${id}" name="${name}" value="${escapeHtml(value(`cron.${role}.${job.name}`, job.schedule))}" required>`,
      );
    }),
  ).join("");
  return `<fieldset class="sec"><legend>Limits</legend>${limits}</fieldset>${
    jobs === "" ? "" : `<fieldset class="sec"><legend>Schedules</legend>${jobs}</fieldset>`
  }`;
}

/** Applies the Factory tab's form to a copy of `config`. Values the config itself rejects surface when the version is created. */
export function applyLimitsAndSchedules(
  config: FactoryConfig,
  form: URLSearchParams,
): { config: FactoryConfig; errors: string[] } {
  const next = structuredClone(config);
  const errors: string[] = [];
  const whole = (name: string, label: string): number | undefined => {
    const text = (form.get(name) ?? "").trim();
    const value = Number(text);
    // Number("") is 0, and a limit of 0 stops every thread, so an empty field is refused.
    if (text === "" || !Number.isInteger(value) || value < 0) {
      errors.push(`${label}: give a whole number of 0 or more.`);
      return undefined;
    }
    return value;
  };
  for (const { key, full } of NUMBERS) {
    const value = whole(`limits.${key}`, full);
    if (value !== undefined) next.factory.limits[key] = value;
  }
  const autoStart = whole("autoStartMinutes", "Auto-start minutes");
  if (autoStart !== undefined) next.factory.autoStartMinutes = autoStart;
  for (const role of ROLE_NAMES) {
    for (const job of next.roles[role].cron ?? []) {
      const schedule = (form.get(`cron.${role}.${job.name}`) ?? "").trim();
      if (schedule === "") errors.push(`${role}: ${job.name}: give a schedule.`);
      else job.schedule = schedule;
    }
  }
  return { config: next, errors };
}

/** The coding jobs, each a model setting that exists today. The provider of the first two is fixed. */
const JOBS = [
  {
    key: "claude",
    job: "Implement",
    does: "Writes the change, runs the tests, and opens the PR.",
    provider: "Factory Claude",
  },
  {
    key: "codex",
    job: "Review",
    does: "Reads the PR, runs the tests, and approves or asks for changes.",
    provider: "Factory Codex",
  },
  {
    key: "setup",
    job: "Housekeeping",
    does: "Deploys config to workers, signs them in, and checks them.",
    provider: undefined,
  },
] as const;

type JobKey = (typeof JOBS)[number]["key"];

function choiceOf(config: FactoryConfig, key: JobKey): ModelChoice {
  return key === "setup" ? config.factory.setup : config.factory.models[key];
}

/** The Models tab's Coding section: a row per job, and each job's provider options in a fold. */
export function codingModelsFields(config: FactoryConfig, submitted?: URLSearchParams): string {
  const value = valueFrom(submitted);
  const rows = JOBS.map(({ key, job, does, provider }) => {
    const where =
      provider === undefined
        ? `<input type="text" class="w-144" name="setup.instanceId" value="${escapeHtml(value("setup.instanceId", config.factory.setup.instanceId))}" aria-label="Housekeeping provider instance" placeholder="claudeAgent" required>`
        : `<span class="muted">${provider}</span>`;
    return `<li class="row job"><div class="main"><span class="title">${job}</span><span class="subline">${does}</span></div><div class="aside">${where}<input type="text" name="${key}.model" value="${escapeHtml(value(`${key}.model`, choiceOf(config, key).model))}" aria-label="${job} model" required></div></li>`;
  }).join("");
  const options = JOBS.map(({ key, job }) => {
    const saved = Object.entries(choiceOf(config, key).options ?? {})
      .map(([id, option]) => `${id}=${optionText(option)}`)
      .join("\n");
    return setting(
      `f-${key}-options`,
      `${job} options`,
      "Provider options by T3 option id, one id=value per line. true and false are switches.",
      `<textarea class="w-220" id="f-${key}-options" name="${key}.options" rows="2" placeholder="effort=high">${escapeHtml(value(`${key}.options`, saved))}</textarea>`,
    );
  }).join("");
  return section({
    title: "Coding",
    right: '<span class="muted">run on workers</span>',
    body: `<ul class="rows">${rows}</ul><p class="hint note">The provider of Implement and Review is fixed. Housekeeping runs on one of your own T3 provider instances, such as claudeAgent.</p>${fold(
      "Provider options",
      options,
      // A refused form opens the fold, or what was typed there would be hidden.
      submitted !== undefined,
    )}`,
  });
}

/** Applies the Models tab's form to a copy of `config`. */
export function applyCodingModels(
  config: FactoryConfig,
  form: URLSearchParams,
): { config: FactoryConfig; errors: string[] } {
  const next = structuredClone(config);
  const errors: string[] = [];
  for (const { key, job } of JOBS) {
    const choice = model(form, key, job, errors, choiceOf(next, key));
    if (key !== "setup") {
      next.factory.models[key] = choice;
      continue;
    }
    const instanceId = (form.get("setup.instanceId") ?? "").trim();
    if (instanceId === "") errors.push("Housekeeping provider instance: name one.");
    next.factory.setup = {
      ...choice,
      instanceId: instanceId === "" ? next.factory.setup.instanceId : instanceId,
    };
  }
  return { config: next, errors };
}

function model(
  form: URLSearchParams,
  key: JobKey,
  job: string,
  errors: string[],
  current: ModelChoice,
): ModelChoice {
  const name = (form.get(`${key}.model`) ?? "").trim();
  if (name === "") {
    errors.push(`${job} model: name one.`);
    return current;
  }
  const options: Record<string, string | boolean> = {};
  for (const line of (form.get(`${key}.options`) ?? "").split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    const at = text.indexOf("=");
    if (at <= 0) {
      errors.push(`${job} model options: write each as id=value, not ${text}.`);
      continue;
    }
    const value = text.slice(at + 1).trim();
    options[text.slice(0, at).trim()] = optionValue(value);
  }
  return Object.keys(options).length === 0 ? { model: name } : { model: name, options };
}

/** How an option shows in the form: a switch as true or false, and a string that would read as one, quoted. */
function optionText(value: string | boolean): string {
  if (typeof value === "boolean") return String(value);
  // Quoted whenever the bare text would read back differently: as a switch, as several lines, or trimmed.
  return value === "true" || value === "false" || /["\r\n]/.test(value) || value.trim() !== value
    ? JSON.stringify(value)
    : value;
}

/** An option from the form: true and false are switches, a quoted value is a string as written. */
function optionValue(text: string): string | boolean {
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not a quoted string after all; keep the text as written.
    }
  }
  return text;
}
