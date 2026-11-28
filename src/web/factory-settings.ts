import {
  ROLE_NAMES,
  type CronJob,
  type FactoryConfig,
  type ModelChoice,
} from "../config/document.js";
import {
  EFFORT,
  INSTANCES,
  MODELS,
  PROVIDERS,
  PROVIDER_LABELS,
  providerOfInstance,
  type EffortProvider,
} from "../config/effort.js";
import {
  checkbox,
  escapeHtml,
  fold,
  modelSelect,
  placeholderOption,
  section,
  setting,
} from "./html.js";

/** Reads a form field: what the owner typed when a refused form comes back, else the saved value. */
type Value = (name: string, saved: string) => string;

function valueFrom(submitted: URLSearchParams | undefined): Value {
  return (name, saved) => submitted?.get(name) ?? saved;
}

const NUMBERS = [
  {
    key: "tasksPerWorker",
    label: "Tasks per worker",
    full: "Tasks in progress per worker",
    hint: "Tasks waiting on you do not count.",
  },
  {
    key: "threadsPerWorker",
    label: "Threads per worker",
    // The refusal names the limit in full, as it did before the row had a short label.
    full: "Running factory threads per worker",
    hint: "",
  },
  {
    key: "threads",
    label: "Threads in total",
    full: "Running factory threads in all",
    hint: "",
  },
  {
    key: "startsPerDay",
    label: "Thread starts per day",
    full: "Factory threads started per day",
    hint: "Across all workers, by UTC day.",
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

/** The Factory tab's fields: the thread limits, the triage alert wait, and each scheduled job. */
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
      "f-triage-alert",
      "triageAlertMinutes",
      "Tell me after (minutes)",
      "Alerts you when the lead leaves a task untriaged this long. 0 turns it off.",
      value("triageAlertMinutes", String(factory.triageAlertMinutes)),
    ),
  ].join("");
  const jobs = ROLE_NAMES.flatMap((role) =>
    (config.roles[role].cron ?? []).map((job) => jobSetting(role, job, value, submitted)),
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
  const triageAlert = whole("triageAlertMinutes", "Tell me after (minutes)");
  if (triageAlert !== undefined) next.factory.triageAlertMinutes = triageAlert;
  for (const role of ROLE_NAMES) {
    for (const job of next.roles[role].cron ?? []) applyJob(role, job, form, errors);
  }
  return { config: next, errors };
}

/** The time zone Hermes reads a cron expression in: the host's own, as Hephaestus runs there. */
function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The time of day, as HH:MM, of a schedule that runs once a day at a fixed minute; else undefined. */
export function dailyTime(schedule: string): string | undefined {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(schedule.trim());
  if (match === null) return undefined;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** A plain sentence that says when a job runs. */
export function scheduleSummary(job: CronJob, timeZone = hostTimeZone()): string {
  if (job.enabled === false) return "Off: this job does not run.";
  const time = dailyTime(job.schedule);
  const when =
    time === undefined ? `on the custom schedule ${job.schedule}` : `every day at ${time}`;
  return `Runs ${when}, Hermes host time (${timeZone}).`;
}

const CUSTOM_HINT =
  "Replaces the time of day when filled in. Five cron fields (minute, hour, day of month, month, weekday), such as 30 2 * * *, or a form such as every 2h.";

/** A scheduled job's row: an on switch, a time of day, a custom schedule in a fold, and what it adds up to. */
function jobSetting(
  role: string,
  job: CronJob,
  value: Value,
  submitted: URLSearchParams | undefined,
): string {
  const id = `f-cron-${role}-${job.name}`;
  const base = `cron.${role}.${job.name}`;
  const time = dailyTime(job.schedule);
  const on = submitted === undefined ? job.enabled !== false : submitted.has(`${base}.on`);
  const custom = value(`${base}.custom`, time === undefined ? job.schedule : "");
  const control = `<div class="schedule">${checkbox(`${base}.on`, "On", { checked: on })}<input type="time" id="${escapeHtml(id)}" name="${escapeHtml(`${base}.time`)}" value="${escapeHtml(value(`${base}.time`, time ?? ""))}" aria-label="${escapeHtml(`${role}: ${job.name} time of day`)}">${fold(
    "Custom schedule",
    `<input type="text" class="w-220" name="${escapeHtml(`${base}.custom`)}" value="${escapeHtml(custom)}" aria-label="${escapeHtml(`${role}: ${job.name} custom schedule`)}" placeholder="every 2h"><span class="hint">${escapeHtml(CUSTOM_HINT)}</span>`,
    custom.trim() !== "",
  )}</div>`;
  return setting(id, `${role}: ${job.name}`, escapeHtml(scheduleSummary(job)), control);
}

/** A custom schedule Hermes reads: five cron fields, or an every form. */
function customSchedule(text: string): boolean {
  return text.split(/\s+/).length === 5 || /^every \S+/.test(text);
}

/** Applies one job's fields. A form without them leaves the job as it is. */
function applyJob(role: string, job: CronJob, form: URLSearchParams, errors: string[]): void {
  const base = `cron.${role}.${job.name}`;
  if (!form.has(`${base}.time`) && !form.has(`${base}.custom`)) return;
  const label = `${role}: ${job.name}`;
  const on = form.has(`${base}.on`);
  const custom = (form.get(`${base}.custom`) ?? "").trim();
  const time = (form.get(`${base}.time`) ?? "").trim();
  let schedule: string | undefined;
  if (custom !== "") {
    if (customSchedule(custom)) schedule = custom;
    else
      errors.push(
        `${label}: write the custom schedule as five cron fields, such as 30 2 * * *, or as every 2h.`,
      );
  } else if (time !== "") {
    // A browser's time picker sends HH:MM, or HH:MM:SS when it shows seconds.
    const match = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(time);
    if (match === null) errors.push(`${label}: give a time of day as HH:MM, such as 02:30.`);
    else schedule = `${String(Number(match[2]))} ${String(Number(match[1]))} * * *`;
  } else if (on) {
    errors.push(`${label}: give a time of day, or a custom schedule.`);
  }
  if (schedule !== undefined) job.schedule = schedule;
  if (on) delete job.enabled;
  else job.enabled = false;
}

/**
 * The coding jobs, each a model setting that exists today. Implement and Review run on the
 * factory instances, which deploy installs as one provider each, so their provider is fixed.
 * Housekeeping runs on one of the owner's instances, whose provider its id names.
 */
const JOBS = [
  { key: "claude", job: "Implement", does: "", instance: "Factory Claude" },
  { key: "codex", job: "Review", does: "", instance: "Factory Codex" },
  {
    key: "setup",
    job: "Housekeeping",
    does: "Deploys config to workers and signs them in. Runs on one of your T3 provider instances.",
    instance: undefined,
  },
] as const;

type JobKey = (typeof JOBS)[number]["key"];

function choiceOf(config: FactoryConfig, key: JobKey): ModelChoice {
  return key === "setup" ? config.factory.setup : config.factory.models[key];
}

/** A provider named in a form, or undefined for any other text. */
function asProvider(text: string): EffortProvider | undefined {
  return PROVIDERS.find((provider) => provider === text);
}

/**
 * The options of a selector that follows its row's provider: every provider's values, each
 * marked with its provider, and only the chosen provider's shown. Sharing one list keeps every
 * row's choices the same. A saved or typed value the chosen provider lacks comes first in its
 * group, so the form shows it and saving keeps it or gets the config's refusal. A value of an
 * instance whose provider is not known gets a group of its own.
 */
function providerOptions(
  byProvider: Record<EffortProvider, readonly string[]>,
  provider: EffortProvider | undefined,
  current: string,
): string {
  const groups: [string, readonly string[]][] = PROVIDERS.map((each) => {
    const values = byProvider[each];
    return [
      each,
      each === provider && current !== "" && !values.includes(current)
        ? [current, ...values]
        : values,
    ];
  });
  if (provider === undefined && current !== "") groups.unshift(["", [current]]);
  return groups
    .flatMap(([group, values]) => {
      const shown = group === (provider ?? "");
      return values.map(
        (value) =>
          `<option value="${escapeHtml(value)}" data-for="${group}"${shown ? "" : " hidden disabled"}${shown && value === current ? " selected" : ""}>${escapeHtml(value)}</option>`,
      );
    })
    .join("");
}

/**
 * A job's provider selector. A factory job offers only its instance's provider; the other
 * stays listed, so every row lists the same providers. A housekeeping instance of a provider
 * the factory does not know shows as Other.
 */
function providerSelect(key: JobKey, job: string, provider: EffortProvider | undefined): string {
  const fixed = key === "setup" ? undefined : key;
  const other = provider === undefined ? '<option value="" selected>Other</option>' : "";
  const options = PROVIDERS.map(
    (each) =>
      `<option value="${each}"${fixed !== undefined && fixed !== each ? " disabled" : ""}${each === provider ? " selected" : ""}>${PROVIDER_LABELS[each]}</option>`,
  ).join("");
  return `<select name="${key}.provider" aria-label="${job} provider" data-provider>${other}${options}</select>`;
}

/**
 * A job's effort selector: the provider's levels only. A choice without effort shows a
 * placeholder that is disabled, so the browser sends no effort and the save leaves it unset.
 */
function effortSelect(
  key: JobKey,
  job: string,
  provider: EffortProvider | undefined,
  current: string,
): string {
  const levels = Object.fromEntries(PROVIDERS.map((each) => [each, EFFORT[each].levels])) as Record<
    EffortProvider,
    readonly string[]
  >;
  const text = provider === undefined ? "No effort levels" : "Select effort";
  return `<select class="effort" name="${key}.effort" aria-label="${job} effort" data-follows-provider data-placeholder="Select effort" data-placeholder-none="No effort levels">${placeholderOption(text, current)}${providerOptions(levels, provider, current)}</select>`;
}

/** A job's model selector: the models T3 offers for its provider. */
function modelChoice(
  key: JobKey,
  job: string,
  provider: EffortProvider | undefined,
  current: string,
): string {
  return modelSelect(
    `${key}.model`,
    providerOptions(MODELS, provider, current),
    current,
    ` aria-label="${job} model" data-follows-provider`,
  );
}

/** The housekeeping instance selector: the instances T3 creates for its provider. */
function instanceSelect(provider: EffortProvider | undefined, current: string): string {
  return `<select class="w-144" name="setup.instanceId" aria-label="Housekeeping provider instance" required data-follows-provider>${placeholderOption("Select instance", current)}${providerOptions(INSTANCES, provider, current)}</select>`;
}

/** The Models tab's Coding section: a row per job, and each job's provider options in a fold. */
export function codingModelsFields(config: FactoryConfig, submitted?: URLSearchParams): string {
  const value = valueFrom(submitted);
  const rows = JOBS.map(({ key, job, does, instance }) => {
    const instanceId = value("setup.instanceId", config.factory.setup.instanceId);
    // A refused form shows the provider it chose, with that provider's choices.
    const provider =
      key === "setup"
        ? submitted?.has("setup.provider") === true
          ? asProvider(submitted.get("setup.provider") ?? "")
          : providerOfInstance(instanceId)
        : key;
    const where =
      instance === undefined
        ? instanceSelect(provider, instanceId)
        : `<span class="muted">${instance}</span>`;
    const model = modelChoice(
      key,
      job,
      provider,
      value(`${key}.model`, choiceOf(config, key).model),
    );
    const effort = effortSelect(
      key,
      job,
      provider,
      value(`${key}.effort`, choiceOf(config, key).effort ?? ""),
    );
    return `<li class="row job" data-provider-row><div class="main"><span class="title">${job}</span>${does === "" ? "" : `<span class="subline">${does}</span>`}</div><div class="aside">${providerSelect(key, job, provider)}${where}${model}${effort}</div></li>`;
  }).join("");
  const options = JOBS.map(({ key, job }) => {
    const saved = Object.entries(choiceOf(config, key).options ?? {})
      .map(([id, option]) => `${id}=${optionText(option)}`)
      .join("\n");
    return setting(
      `f-${key}-options`,
      `${job} options`,
      "",
      `<textarea class="w-220" id="f-${key}-options" name="${key}.options" rows="2" placeholder="id=value">${escapeHtml(value(`${key}.options`, saved))}</textarea>`,
    );
  }).join("");
  return section({
    title: "Coding",
    right: '<span class="muted">run on workers</span>',
    body: `<ul class="rows">${rows}</ul>${fold(
      "Provider options",
      `<p class="hint">T3 option ids, one id=value per line.</p>${options}`,
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
  for (const { key, job, instance } of JOBS) {
    const saved = choiceOf(next, key);
    const choice = model(form, key, job, errors, saved);
    const posted = form.get(`${key}.provider`);
    if (key !== "setup") {
      // Deploy installs each factory instance as one provider, so another cannot run there.
      if (posted !== null && posted !== key) {
        errors.push(`${job} provider: ${instance} runs ${PROVIDER_LABELS[key]} only.`);
      }
      modelProblem(job, key, choice, saved, false, errors);
      next.factory.models[key] = choice;
      continue;
    }
    const instanceId = (form.get("setup.instanceId") ?? "").trim();
    if (instanceId === "") errors.push("Housekeeping provider instance: name one.");
    const named = providerOfInstance(
      instanceId === "" ? next.factory.setup.instanceId : instanceId,
    );
    // A form without the provider selector, such as one posted by a script, follows the instance.
    const chosen = posted === null ? named : asProvider(posted);
    if (posted !== null && posted !== "" && chosen === undefined) {
      errors.push(
        `${job} provider: choose ${PROVIDERS.map((each) => PROVIDER_LABELS[each]).join(" or ")}.`,
      );
    } else if (instanceId !== "" && chosen !== named) {
      errors.push(
        chosen === undefined
          ? `${job} provider instance: ${instanceId} is a ${PROVIDER_LABELS[named ?? "claude"]} instance, so choose that provider.`
          : `${job} provider instance: ${instanceId} is not a ${PROVIDER_LABELS[chosen]} instance.`,
      );
    }
    if (chosen !== undefined) {
      modelProblem(
        job,
        chosen,
        choice,
        saved,
        chosen !== providerOfInstance(config.factory.setup.instanceId),
        errors,
      );
      // The config checks effort against the instance's provider, which can differ from the one chosen.
      if (choice.effort !== undefined && !EFFORT[chosen].levels.includes(choice.effort)) {
        errors.push(`${job} effort: ${choice.effort} is not a ${PROVIDER_LABELS[chosen]} level.`);
      }
    }
    next.factory.setup = {
      ...choice,
      instanceId: instanceId === "" ? next.factory.setup.instanceId : instanceId,
    };
  }
  return { config: next, errors };
}

/**
 * Refuses a model another provider lists, when the owner chose it or switched provider. A
 * model no provider lists passes, so one T3 adds later can still be set, and a saved choice
 * left untouched always saves back.
 */
function modelProblem(
  job: string,
  provider: EffortProvider,
  choice: ModelChoice,
  saved: ModelChoice,
  switched: boolean,
  errors: string[],
): void {
  if (!switched && choice.model === saved.model) return;
  const owner = PROVIDERS.find((each) => each !== provider && MODELS[each].includes(choice.model));
  if (owner !== undefined) {
    errors.push(
      `${job} model: ${choice.model} is a ${PROVIDER_LABELS[owner]} model, not a ${PROVIDER_LABELS[provider]} one.`,
    );
  }
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
  // A form without the selector, such as one posted by a script, keeps the saved effort.
  const effort = form.has(`${key}.effort`)
    ? (form.get(`${key}.effort`) ?? "").trim()
    : (current.effort ?? "");
  return {
    model: name,
    ...(Object.keys(options).length === 0 ? {} : { options }),
    // An empty effort leaves it unset, so the model runs at its own default as before.
    ...(effort === "" ? {} : { effort }),
  };
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
