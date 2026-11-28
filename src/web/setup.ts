import type { InstanceState, WorkerView } from "../workers/manager.js";
import { read, type FactoryPages } from "./factory.js";
import { buttonLink, escapeHtml } from "./html.js";

interface Step {
  title: string;
  done: boolean;
  /** What to do next. */
  next: string;
  /** The page where the step is done, and the text of the link to it. */
  href: string;
  link: string;
}

/**
 * Whether an instance counts as signed in for setup. A check stopped by the
 * provider's usage limit says nothing about the sign-in, so the limit is not a
 * missing sign-in; Home names the limit on its own.
 */
function counted(state: InstanceState): boolean {
  return state === "signed-in" || state === "limited";
}

/**
 * The setup steps a new factory needs, in order, each with its state and
 * the page that finishes it. Undefined when the config could not be read.
 */
function setupSteps(factory: FactoryPages, workers: WorkerView[]): Step[] | undefined {
  const version = read("config", () => factory.store.current());
  if (!version.ok) return undefined;
  const configRepo = factory.configRepo?.();
  const projects = Object.keys(version.value?.document.projects ?? {}).length;
  const enabled = workers.filter((worker) => worker.enabled);
  // Signed in is about both factory instances, not readiness, which a routine redeploy interrupts.
  const signedIn = enabled.filter((worker) => counted(worker.claude) && counted(worker.codex));
  const waiting = enabled.find((worker) => !counted(worker.claude) || !counted(worker.codex));
  const model = factory.hermesModel?.();
  return [
    {
      title: "Name the config repo",
      done: configRepo !== undefined && configRepo !== "",
      next: "A private repo for config versions. Created if missing.",
      href: "/config",
      link: "Open config",
    },
    {
      title: "Add a worker",
      done: enabled.length > 0,
      next: "Click Use as a worker on a linked machine.",
      href: "/workers",
      link: "Open workers",
    },
    {
      title: "Sign the worker in",
      done: signedIn.length > 0,
      next:
        waiting?.blocker === undefined
          ? "Sign in Factory Claude and Factory Codex."
          : `${waiting.label}: ${waiting.blocker}`,
      href: "/workers",
      link: "Open workers",
    },
    {
      title: "Add a project",
      done: projects > 0,
      next: "Add a repo for the factory to work on.",
      href: "/projects",
      link: "Open projects",
    },
    {
      title: "Deploy the config",
      done: version.value?.state === "deployed",
      next: "Approve and deploy a version.",
      href: "/config/versions",
      link: "Open config",
    },
    {
      title: "Give the factory a model",
      done: model !== undefined,
      next: "Pick a provider, sign in, and choose a model.",
      href: "/config/models/planning",
      link: "Open models",
    },
  ];
}

export interface SetupChecklist {
  done: number;
  total: number;
  /** Safe HTML: the steps, then the optional one. */
  html: string;
}

/**
 * The setup checklist Home shows until every step is done. Undefined once
 * setup is complete, and when the config could not be read.
 */
export function setupChecklist(
  factory: FactoryPages,
  workers: WorkerView[],
): SetupChecklist | undefined {
  const steps = setupSteps(factory, workers);
  if (steps === undefined || steps.every((step) => step.done)) return undefined;
  const next = steps.find((step) => !step.done);
  const items = steps
    .map((step) =>
      step.done
        ? `<li class="done"><div><strong>${escapeHtml(step.title)}</strong></div></li>`
        : `<li${step === next ? ' class="next"' : ""}><div><strong>${escapeHtml(step.title)}</strong><span class="subline">${escapeHtml(step.next)}</span></div>${buttonLink(step.href, step.link, step === next ? { variant: "primary" } : {})}</li>`,
    )
    .join("");
  return {
    done: steps.filter((step) => step.done).length,
    total: steps.length,
    html: `<ol class="setup">${items}</ol><p class="empty">Optional: <a href="/chat">connect a chat</a>.</p>`,
  };
}
