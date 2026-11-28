import {
  ROLE_NAMES,
  type CronJob,
  type FactoryConfig,
  type ModelChoice,
} from "../config/document.js";
import { EFFORT, MODELS, providerOfInstance, type EffortProvider } from "../config/effort.js";
import {
  checkbox,
  choiceOptions,
  escapeHtml,
  fold,
  modelSelect,
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

/** The coding jobs, each a model setting that exists today. The provider of the first two is fixed. */
const JOBS = [
  {
    key: "claude",
    job: "Implement",
    does: "",
    provider: "Factory Claude",
  },
  {
    key: "codex",
    job: "Review",
    does: "",
    provider: "Factory Codex",
  },
  {
    key: "setup",
    job: "Housekeeping",
    does: "Deploys config to workers and signs them in. Runs on one of your T3 provider instances.",
    provider: undefined,
  },
] as const;

type JobKey = (typeof JOBS)[number]["key"];

function choiceOf(config: FactoryConfig, key: JobKey): ModelChoice {
  return key === "setup" ? config.factory.setup : config.factory.models[key];
}

/** The provider whose effort levels a job offers. Housekeeping's follows its instance id. */
function providerOf(key: JobKey, instanceId: string): EffortProvider | undefined {
  return key === "setup" ? providerOfInstance(instanceId) : key;
}

/**
 * A job's effort selector: the provider's levels only. A choice without effort shows a
 * placeholder that is disabled, so the browser sends no effort and the save leaves it unset.
 * A saved or typed level the provider does not list stays as an option, so the form shows it
 * and saving it again gets the config's refusal rather than silently dropping it.
 */
function effortSelect(
  key: JobKey,
  job: string,
  provider: EffortProvider | undefined,
  current: string,
): string {
  const levels = provider === undefined ? [] : EFFORT[provider].levels;
  const placeholder = provider === undefined ? "No effort levels" : "Select effort";
  const options = `<option value="" disabled hidden${current === "" ? " selected" : ""}>${placeholder}</option>${choiceOptions(levels, current)}`;
  return `<select class="effort" name="${key}.effort" aria-label="${job} effort">${options}</select>`;
}

/**
 * A job's model selector: the models T3 offers for its provider, with the saved model first
 * when the list lacks it, so saving keeps it. An instance whose provider is not known has no
 * list, so its model stays a text field.
 */
function modelField(
  key: JobKey,
  job: string,
  provider: EffortProvider | undefined,
  current: string,
): string {
  if (provider === undefined) {
    return `<input type="text" name="${key}.model" value="${escapeHtml(current)}" aria-label="${job} model" required>`;
  }
  return modelSelect(`${key}.model`, MODELS[provider], current, ` aria-label="${job} model"`);
}

/** The Models tab's Coding section: a row per job, and each job's provider options in a fold. */
export function codingModelsFields(config: FactoryConfig, submitted?: URLSearchParams): string {
  const value = valueFrom(submitted);
  const rows = JOBS.map(({ key, job, does, provider }) => {
    const where =
      provider === undefined
        ? `<input type="text" class="w-144" name="setup.instanceId" value="${escapeHtml(value("setup.instanceId", config.factory.setup.instanceId))}" aria-label="Housekeeping provider instance" placeholder="claudeAgent" required>`
        : `<span class="muted">${provider}</span>`;
    const instanceId = value("setup.instanceId", config.factory.setup.instanceId);
    const jobProvider = providerOf(key, instanceId);
    const model = modelField(
      key,
      job,
      jobProvider,
      value(`${key}.model`, choiceOf(config, key).model),
    );
    const effort = effortSelect(
      key,
      job,
      jobProvider,
      value(`${key}.effort`, choiceOf(config, key).effort ?? ""),
    );
    return `<li class="row job"><div class="main"><span class="title">${job}</span>${does === "" ? "" : `<span class="subline">${does}</span>`}</div><div class="aside">${where}${model}${effort}</div></li>`;
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
