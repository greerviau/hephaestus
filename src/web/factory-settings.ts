import { ROLE_NAMES, type FactoryConfig, type ModelChoice } from "../config/document.js";
import { escapeHtml } from "./html.js";

const NUMBERS = [
  {
    key: "threadsPerWorker",
    label: "Running factory threads per worker",
    help: "Counts implement and review threads on one machine.",
  },
  { key: "threads", label: "Running factory threads in all", help: "Across every worker." },
  {
    key: "startsPerDay",
    label: "Factory threads started per day",
    help: "Per UTC day, across every worker. A cap on spend.",
  },
] as const;

/** The form fields for the factory's limits, models, and schedules, filled from `config`. */
export function factorySettingsForm(
  config: FactoryConfig,
  parentId: number | undefined,
  submitted?: URLSearchParams,
): string {
  const { factory } = config;
  // A refused form comes back with what the owner typed, not the saved values.
  const value = (name: string, saved: string): string => submitted?.get(name) ?? saved;
  const numbers = NUMBERS.map(
    ({ key, label, help }) =>
      `<div class="field"><label for="f-${key}">${escapeHtml(label)}</label><input type="number" id="f-${key}" name="limits.${key}" min="0" step="1" value="${escapeHtml(value(`limits.${key}`, String(factory.limits[key])))}" required><span class="meta">${escapeHtml(help)}</span></div>`,
  ).join("");
  const autoStart = `<div class="field"><label for="f-autostart">Start a card the lead has not started after (minutes)</label><input type="number" id="f-autostart" name="autoStartMinutes" min="0" step="1" value="${escapeHtml(value("autoStartMinutes", String(factory.autoStartMinutes)))}" required><span class="meta">0 waits for the lead.</span></div>`;
  const models = [
    modelFields(
      "claude",
      "Factory Claude model",
      "Implements cards.",
      factory.models.claude,
      value,
    ),
    modelFields("codex", "Factory Codex model", "Reviews PRs.", factory.models.codex, value),
    modelFields(
      "setup",
      "Setup model",
      "Runs deploy, sign-in, and check threads, on the provider instance named below.",
      factory.setup,
      value,
    ),
    `<div class="field"><label for="f-setup-instance">Setup provider instance</label><input type="text" id="f-setup-instance" name="setup.instanceId" value="${escapeHtml(value("setup.instanceId", factory.setup.instanceId))}" required><span class="meta">One of your own T3 provider instances on each worker, such as claudeAgent.</span></div>`,
  ].join("");
  const jobs = ROLE_NAMES.flatMap((role) =>
    (config.roles[role].cron ?? []).map(
      (job) =>
        `<div class="field"><label for="f-cron-${escapeHtml(role)}-${escapeHtml(job.name)}">${escapeHtml(`${role}: ${job.name}`)}</label><input type="text" id="f-cron-${escapeHtml(role)}-${escapeHtml(job.name)}" name="cron.${escapeHtml(role)}.${escapeHtml(job.name)}" value="${escapeHtml(value(`cron.${role}.${job.name}`, job.schedule))}" required><span class="meta">A cron expression, or a Hermes form such as every 2h.</span></div>`,
    ),
  ).join("");
  return `<form method="post" action="/settings/factory" class="form-grid">
<input type="hidden" name="parentId" value="${escapeHtml(String(parentId ?? ""))}">
<fieldset><legend>Limits</legend>${numbers}${autoStart}</fieldset>
<fieldset><legend>Models</legend>${models}</fieldset>
${jobs === "" ? "" : `<fieldset><legend>Schedules</legend>${jobs}</fieldset>`}
<label class="check"><input type="checkbox" name="deploy" checked> Approve and deploy now</label>
<div class="btn-row"><button type="submit" class="btn-primary">Save the factory settings</button></div>
</form>`;
}

function modelFields(
  key: string,
  label: string,
  help: string,
  choice: ModelChoice,
  value: (name: string, saved: string) => string,
): string {
  const options = value(
    `${key}.options`,
    Object.entries(choice.options ?? {})
      .map(([id, option]) => `${id}=${optionText(option)}`)
      .join("\n"),
  );
  return `<div class="field"><label for="f-${key}-model">${escapeHtml(label)}</label><input type="text" id="f-${key}-model" name="${key}.model" value="${escapeHtml(value(`${key}.model`, choice.model))}" required><span class="meta">${escapeHtml(help)}</span></div><div class="field"><label for="f-${key}-options">${escapeHtml(label)} options</label><textarea id="f-${key}-options" name="${key}.options" rows="2" placeholder="effort=high">${escapeHtml(options)}</textarea><span class="meta">Provider options by T3 option id, one id=value per line. true and false are switches.</span></div>`;
}

/** Applies the form to a copy of `config`. Values the config itself rejects surface when the version is created. */
export function applyFactorySettings(
  config: FactoryConfig,
  form: URLSearchParams,
): { config: FactoryConfig; errors: string[] } {
  const next = structuredClone(config);
  const errors: string[] = [];
  const whole = (name: string, label: string, min: number): number | undefined => {
    const value = Number((form.get(name) ?? "").trim());
    if (!Number.isInteger(value) || value < min) {
      errors.push(`${label}: give a whole number of ${String(min)} or more.`);
      return undefined;
    }
    return value;
  };
  for (const { key, label } of NUMBERS) {
    const value = whole(`limits.${key}`, label, 0);
    if (value !== undefined) next.factory.limits[key] = value;
  }
  const autoStart = whole("autoStartMinutes", "Auto-start minutes", 0);
  if (autoStart !== undefined) next.factory.autoStartMinutes = autoStart;
  for (const key of ["claude", "codex"] as const) {
    next.factory.models[key] = model(form, key, errors, next.factory.models[key]);
  }
  const setup = model(form, "setup", errors, next.factory.setup);
  const instanceId = (form.get("setup.instanceId") ?? "").trim();
  if (instanceId === "") errors.push("Setup provider instance: name one.");
  next.factory.setup = {
    ...setup,
    instanceId: instanceId === "" ? next.factory.setup.instanceId : instanceId,
  };
  for (const role of ROLE_NAMES) {
    for (const job of next.roles[role].cron ?? []) {
      const schedule = (form.get(`cron.${role}.${job.name}`) ?? "").trim();
      if (schedule === "") errors.push(`${role}: ${job.name}: give a schedule.`);
      else job.schedule = schedule;
    }
  }
  return { config: next, errors };
}

function model(
  form: URLSearchParams,
  key: string,
  errors: string[],
  current: ModelChoice,
): ModelChoice {
  const name = (form.get(`${key}.model`) ?? "").trim();
  if (name === "") {
    errors.push(`${key} model: name one.`);
    return current;
  }
  const options: Record<string, string | boolean> = {};
  for (const line of (form.get(`${key}.options`) ?? "").split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    const at = text.indexOf("=");
    if (at <= 0) {
      errors.push(`${key} model options: write each as id=value, not ${text}.`);
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
  return value === "true" || value === "false" || value.startsWith('"') || value.trim() !== value
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
