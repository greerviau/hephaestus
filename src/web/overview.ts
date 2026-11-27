import { isProposal } from "../config/store.js";
import { setupChecklist } from "./setup.js";
import type { Task } from "../factory/tasks.js";
import type { WorkerView } from "../workers/manager.js";
import { expiresIn, expiringSoon, readEnvironments } from "./workers.js";
import {
  ACTIVE_STAGES,
  STORE_ERROR,
  taskActions,
  taskLabel,
  escalationActions,
  heldIssueRow,
  notice,
  read,
  runningThreads,
  stagePill,
  t3Error,
  workerNeedsOwner,
  type FactoryPages,
} from "./factory.js";
import {
  buttonLink,
  callout,
  empty,
  escapeHtml,
  icon,
  layout,
  loading,
  pageHead,
  postButton,
  rowList,
  section,
  when,
  type Row,
} from "./html.js";
import { sendHtml, type Route } from "./http.js";
import { ADMITTING_RELOAD_SECONDS, admissionsFor } from "./admissions.js";

/** The page reloads this often, and sooner while it waits for T3 to answer. */
const RELOAD_SECONDS = 10;
const LOADING_RELOAD_SECONDS = 5;

const DOT = " &middot; ";

function workerStep(view: WorkerView): string {
  if (view.tasks["claude-sign-in"]?.status === "running") {
    return `Paste the Claude setup token into the thread "Hephaestus: sign in Factory Claude" on ${view.label} in T3.`;
  }
  if (view.tasks["codex-sign-in"]?.status === "running") {
    return "Approve the Codex sign-in code shown on the Workers page.";
  }
  return view.blocker ?? "";
}

/**
 * What Home says about a worker whose sign-in check stopped on the provider's
 * usage limit, which is neither a missing sign-in nor the owner's to fix.
 */
function limitNotice(view: WorkerView): string {
  if (!view.enabled) return "";
  const names = [
    ...(view.claude === "limited" ? ["Factory Claude"] : []),
    ...(view.codex === "limited" ? ["Factory Codex"] : []),
  ];
  if (names.length === 0) return "";
  const text = names.some((name) => view.blocker?.startsWith(`${name} reached`) === true)
    ? (view.blocker ?? "")
    : `${names.join(" and ")} reached the provider's usage limit, so the sign-in check could not run. Hephaestus checks again on its own.`;
  return callout("info", `${view.label}: usage limit reached`, escapeHtml(text));
}

function count(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

export function overviewRoutes(factory: FactoryPages): Route[] {
  const now = factory.now ?? Date.now;
  return [
    {
      method: "GET",
      path: /^\/$/,
      handle: async ({ response, url, shell }) => {
        const t3 = await readEnvironments(factory.environments, factory.t3WaitMs ?? 2000);
        const admissions = admissionsFor(factory.intake);
        const project = shell?.project;
        const inProject = (repo: string): boolean => project === undefined || repo === project;
        const tasks = read("tasks", () =>
          factory.tasks.list().filter((item) => inProject(item.repo)),
        );
        const issues = read("issues", () =>
          factory.intake
            .issues(["awaiting-owner", "held-cap"])
            .filter((issue) => inProject(issue.repo)),
        );
        const proposals = read("proposals", () =>
          factory.store
            .list()
            .filter((version) => isProposal(version) && version.state === "draft"),
        );
        const notifications = read("notifications", () => factory.tasks.notifications());
        const workers = read("workers", () => factory.workers?.views() ?? []);
        const paused = read("the pause switch", () => factory.pipeline.paused());
        const blocked = read("the thread caps", () => factory.pipeline.blockedBecause(undefined));
        const labels = new Map(
          (workers.ok ? workers.value : []).map((view) => [view.environmentId, view.label]),
        );

        const inProgress = tasks.ok
          ? tasks.value.filter(
              (item) =>
                ACTIVE_STAGES.includes(item.stage) ||
                (item.stage === "Escalated" && item.escalatedTo !== "owner"),
            )
          : [];
        const finished = tasks.ok
          ? tasks.value
              .filter((item) => item.stage === "Done" || item.stage === "Abandoned")
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          : [];
        const threads = read("threads", () =>
          inProgress.map((item) => runningThreads(factory.events.forTask(item.id), labels)),
        );
        const storeFailed = [
          tasks,
          issues,
          proposals,
          notifications,
          workers,
          paused,
          threads,
        ].some((result) => !result.ok);

        const needs: Row[] = [];
        if (tasks.ok) {
          for (const item of tasks.value) {
            if (item.stage !== "Escalated" || item.escalatedTo !== "owner") continue;
            const reason = escapeHtml(item.reason ?? "Escalated to you.");
            needs.push({
              kind: taskActions(item).approveMerge ? "merge" : "task",
              title: taskLabel(item),
              href: `/work/${String(item.id)}`,
              // The repo says nothing new when the page shows one project.
              sub: project === undefined ? `${reason}${DOT}${escapeHtml(item.repo)}` : reason,
              aside: escalationActions(item, "/"),
            });
          }
        }
        if (issues.ok) {
          for (const issue of issues.value) {
            needs.push(heldIssueRow(issue, "/", admissions.state(issue.repo, issue.number)));
          }
        }
        if (proposals.ok) {
          for (const version of proposals.value) {
            const href = `/proposals/${String(version.id)}`;
            needs.push({
              kind: "proposal",
              title: `Proposal v${String(version.id)}: ${version.title}`,
              href,
              sub: `${version.author === "improver" ? "The improver proposed a config change" : "A Hephaestus update brings starter skills"}. Approving it deploys it.`,
              aside: buttonLink(href, "Review proposal"),
            });
          }
        }
        if (t3.state === "ok") {
          for (const environment of t3.value.environments) {
            if (!expiringSoon(environment, now())) continue;
            needs.push({
              kind: "worker",
              title: `${environment.label}: the T3 link ${expiresIn(environment, now())}`,
              href: "/workers",
              sub: "Link it again from this host before then, or factory threads on it stop.",
              aside: buttonLink("/workers", "Open workers"),
            });
          }
        }
        if (workers.ok) {
          for (const view of workers.value.filter(workerNeedsOwner)) {
            needs.push({
              kind: "worker",
              title: view.label,
              href: "/workers",
              sub: escapeHtml(workerStep(view)),
              aside: buttonLink("/workers", "Open workers"),
            });
          }
        }
        if (notifications.ok) {
          // The tasks read above are the chosen project's, so they say which notifications are too.
          const shown = new Set((tasks.ok ? tasks.value : []).map((item) => item.id));
          for (const item of notifications.value) {
            // Escalations are listed from the task's state above; their notifications stay in Activity.
            if (item.kind === "escalation") continue;
            // A notification about another project's task is left out, as on Activity; one about no task stays.
            if (project !== undefined && item.taskId !== null && !shown.has(item.taskId)) continue;
            needs.push({
              kind: "notice",
              title: item.text,
              href: item.taskId === null ? undefined : `/work/${String(item.taskId)}`,
              sub: when(item.at, now()),
              aside: postButton(`/notifications/${String(item.id)}/dismiss`, "Dismiss", {
                fields: { back: "/" },
              }),
            });
          }
        }

        const isWaiting = (item: Task): boolean =>
          item.waiting !== null ||
          item.stage === "Admitted" ||
          item.stage === "Queued" ||
          item.stage === "Escalated";
        const running = inProgress.filter((item) => !isWaiting(item)).length;
        const waiting = inProgress.length - running;

        // With any source unread, an empty list or an exact count would be a claim the page cannot make.
        const incomplete =
          t3.state !== "ok" ||
          [tasks, issues, proposals, notifications, workers].some((part) => !part.ok);
        const needing = !tasks.ok
          ? "What needs you could not be read."
          : incomplete
            ? `At least ${count(needs.length, "thing needs", "things need")} you.`
            : needs.length === 0
              ? "Nothing needs you."
              : `${count(needs.length, "thing needs", "things need")} you.`;
        const working = tasks.ok
          ? ` ${count(running, "task is", "tasks are")} running and ${String(waiting)} ${waiting === 1 ? "is" : "are"} waiting.`
          : "";

        const isPaused = paused.ok && paused.value;
        const boxes = [
          // The paused box below already says what pausing did.
          isPaused && url.searchParams.get("notice") === "paused" ? "" : notice(url),
          storeFailed ? STORE_ERROR : "",
          t3.state === "error" ? t3Error(t3.reason) : "",
          ...(workers.ok ? workers.value.map(limitNotice) : []),
          isPaused
            ? callout(
                "warn",
                "The factory is paused",
                "No thread starts or resumes until you resume it. Running threads finish.",
                postButton("/factory/resume", "Resume factory", {
                  fields: { back: "/" },
                  variant: "primary",
                }),
              )
            : blocked.ok && blocked.value !== undefined
              ? callout("info", "No factory thread starts now", escapeHtml(blocked.value))
              : "",
        ].join("");

        const checking = t3.state === "loading" ? loading("Checking T3 links...") : "";
        const needsBody =
          needs.length > 0
            ? rowList(needs) + checking
            : checking !== ""
              ? checking
              : !tasks.ok
                ? empty("Tasks could not be read.")
                : incomplete
                  ? `<p class="calm">${icon("warn")}Some of what may need you could not be read. Reload to try again.</p>`
                  : `<p class="calm">${icon("ok", "t-done")}Nothing needs you. The factory asks here when it does.</p>`;

        const progress = !tasks.ok
          ? empty("Tasks could not be read.")
          : inProgress.length === 0
            ? empty("No tasks in progress.")
            : rowList(
                inProgress.map((item, index) => {
                  const doing = [
                    ...(item.waiting === null ? [] : [item.waiting]),
                    ...(threads.ok ? (threads.value[index] ?? []) : []),
                  ];
                  const fallback = item.stage === "Escalated" ? item.reason : null;
                  return {
                    title: taskLabel(item),
                    href: `/work/${String(item.id)}`,
                    wholeRow: true,
                    sub: (doing.length > 0 ? doing : [fallback ?? item.repo])
                      .map(escapeHtml)
                      .join(DOT),
                    aside: stagePill(item),
                  };
                }),
              );
        const recent = !tasks.ok
          ? empty("Tasks could not be read.")
          : finished.length === 0
            ? empty("Finished tasks appear here with their outcome.")
            : rowList(
                finished.slice(0, 5).map((item) => ({
                  title: taskLabel(item),
                  href: `/work/${String(item.id)}`,
                  wholeRow: true,
                  sub: when(item.updatedAt, now()),
                  aside: stagePill(item),
                })),
              );

        const sections =
          section({
            title: "Needs you",
            count: incomplete ? undefined : needs.length,
            body: needsBody,
          }) +
          `<div class="cols">${section({
            title: "In progress",
            count: tasks.ok ? inProgress.length : undefined,
            right: '<a href="/work">Open work</a>',
            body: progress,
          })}${section({
            title: "Recently finished",
            right:
              finished.length === 0
                ? undefined
                : `<a href="/work?tab=finished">All ${String(finished.length)} finished</a>`,
            body: recent,
          })}</div>`;

        const setup = setupChecklist(factory, workers.ok ? workers.value : []);
        // A new factory has nothing to list, so the checklist is the whole page until something is.
        const quiet =
          setup !== undefined &&
          needs.length === 0 &&
          inProgress.length === 0 &&
          finished.length === 0 &&
          !incomplete;
        const page =
          setup === undefined
            ? pageHead({ title: "Home", lede: needing + working }) + boxes + sections
            : pageHead({
                title: "Set up the factory",
                lede: `${String(setup.done)} of ${String(setup.total)} steps done.`,
              }) +
              boxes +
              setup.html +
              (quiet ? "" : sections);

        sendHtml(
          response,
          200,
          layout("Home", page, {
            section: "/",
            shell,
            refreshSeconds: admissions.busy()
              ? ADMITTING_RELOAD_SECONDS
              : t3.state === "loading"
                ? LOADING_RELOAD_SECONDS
                : RELOAD_SECONDS,
          }),
        );
      },
    },
  ];
}
