import { isProposal, type ConfigVersion } from "../config/store.js";
import type { TrackedIssue } from "../factory/intake.js";
import type { Task, TaskStore } from "../factory/tasks.js";
import type { WorkerView } from "../workers/manager.js";
import { read, workerNeedsOwner, type FactoryPages, type Read } from "./factory.js";

type Notification = ReturnType<TaskStore["notifications"]>[number];

/** The reads that what needs the owner comes from, narrowed to a project where they belong to one. */
export interface OwnerSources {
  /** Every task of the project, not only those that wait for the owner. */
  tasks: Read<Task[]>;
  issues: Read<TrackedIssue[]>;
  proposals: Read<ConfigVersion[]>;
  notifications: Read<Notification[]>;
  /** Every worker, not only those whose next step is the owner's. */
  workers: Read<WorkerView[]>;
}

/** What waits for the owner. A part whose read failed is empty. */
export interface OwnerItems {
  tasks: Task[];
  issues: TrackedIssue[];
  proposals: ConfigVersion[];
  workers: WorkerView[];
  notifications: Notification[];
}

/**
 * Reads the sources for `project`, or for every project when it is
 * undefined. Proposals and workers belong to the whole factory, so a project
 * leaves them as they are.
 */
export function ownerSources(
  factory: Pick<FactoryPages, "tasks" | "intake" | "store" | "workers">,
  project: string | undefined,
): OwnerSources {
  const inProject = (repo: string): boolean => project === undefined || repo === project;
  return {
    tasks: read("tasks", () => factory.tasks.list().filter((item) => inProject(item.repo))),
    issues: read("issues", () =>
      factory.intake
        .issues(["awaiting-owner", "held-cap"])
        .filter((issue) => inProject(issue.repo)),
    ),
    proposals: read("proposals", () =>
      factory.store.list().filter((version) => isProposal(version) && version.state === "draft"),
    ),
    notifications: read("notifications", () => factory.tasks.notifications()),
    workers: read("workers", () => factory.workers?.views() ?? []),
  };
}

/**
 * Picks out of the sources what needs the owner. Home lists these, and the
 * sidebar counts them, so the two agree for any project. T3 links about to
 * expire are not here: only Home reads T3, because every page would have to
 * wait on it to count them.
 */
export function ownerItems(sources: OwnerSources, project: string | undefined): OwnerItems {
  const tasks = sources.tasks.ok ? sources.tasks.value : [];
  // The tasks read are the project's, so they say which notifications are too.
  const shown = new Set(tasks.map((item) => item.id));
  return {
    tasks: tasks.filter((item) => item.stage === "Escalated" && item.escalatedTo === "owner"),
    issues: sources.issues.ok ? sources.issues.value : [],
    proposals: sources.proposals.ok ? sources.proposals.value : [],
    workers: sources.workers.ok ? sources.workers.value.filter(workerNeedsOwner) : [],
    notifications: (sources.notifications.ok ? sources.notifications.value : []).filter(
      (item) =>
        // An escalation is listed from its task's state; its notification stays in Activity.
        item.kind !== "escalation" &&
        // One about another project's task is left out, as on Activity; one about no task stays.
        (project === undefined || item.taskId === null || shown.has(item.taskId)),
    ),
  };
}

/** How many things `ownerItems` finds. */
export function ownerCount(items: OwnerItems): number {
  return (
    items.tasks.length +
    items.issues.length +
    items.proposals.length +
    items.workers.length +
    items.notifications.length
  );
}
