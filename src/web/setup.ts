import type { WorkerView } from "../workers/manager.js";
import { read, type FactoryPages } from "./factory.js";
import { card, escapeHtml, icon } from "./html.js";

interface Step {
  title: string;
  done: boolean;
  /** Safe HTML: what to do next, with a link to where it is done. */
  next: string;
}

/**
 * The setup steps a new factory needs, in order, each with its state and a
 * link to finish it. Overview shows the card until every step is done.
 */
export function setupSteps(factory: FactoryPages, workers: WorkerView[]): Step[] | undefined {
  const version = read("config", () => factory.store.current());
  if (!version.ok) return undefined;
  const configRepo = factory.configRepo?.();
  const projects = Object.keys(version.value?.document.projects ?? {}).length;
  const ready = workers.filter((worker) => worker.ready);
  const waiting = workers.find((worker) => !worker.ready);
  const model = factory.hermesModel?.();
  return [
    {
      title: "Name the config repo",
      done: configRepo !== undefined && configRepo !== "",
      next: 'On <a href="/environments">Workers</a>, name a private repo for config versions. Hephaestus creates it if it does not exist.',
    },
    {
      title: "Add a worker",
      done: workers.length > 0,
      next: 'On <a href="/environments">Workers</a>, click Use as a worker on a linked machine.',
    },
    {
      title: "Sign the worker in",
      done: ready.length > 0,
      next:
        waiting?.blocker === undefined
          ? 'On <a href="/environments">Workers</a>, sign in Factory Claude and Factory Codex.'
          : `${escapeHtml(waiting.label)}: ${escapeHtml(waiting.blocker)} <a href="/environments">Open Workers</a>.`,
    },
    {
      title: "Add a project",
      done: projects > 0,
      next: 'On <a href="/projects">Projects</a>, add a repo for the factory to work on.',
    },
    {
      title: "Deploy the config",
      done: version.value?.state === "deployed",
      next: 'On <a href="/settings">Settings</a>, approve and deploy a version.',
    },
    {
      title: "Give the factory Hermes a model",
      done: model !== undefined,
      next: "On the Hermes host, run <code>HERMES_HOME=~/.hephaestus/hermes hermes model</code>. The planner, lead, and improver use it.",
    },
  ];
}

/** The setup checklist card, or nothing once setup is complete. */
export function setupCard(factory: FactoryPages, workers: WorkerView[]): string {
  const steps = setupSteps(factory, workers);
  if (steps === undefined || steps.every((step) => step.done)) return "";
  const done = steps.filter((step) => step.done).length;
  const items = steps
    .map(
      (step) =>
        `<li class="${step.done ? "done" : "todo"}">${icon(step.done ? "ok" : "q", step.done ? "s-good" : "s-neutral")}<div><strong>${escapeHtml(step.title)}</strong>${step.done ? "" : `<p class="sub">${step.next}</p>`}</div></li>`,
    )
    .join("");
  return card({
    title: "Set up the factory",
    className: "setup",
    meta: `<span class="meta">${String(done)} of ${String(steps.length)} done</span>`,
    body: `<ol class="setup-steps">${items}</ol><p class="sub">Optional: connect a messaging platform to the factory gateway, so you can ask the planner for work. See the <a href="https://github.com/greerviau/hephaestus/blob/main/docs/hermes.md">factory Hermes docs</a>.</p>`,
  });
}
