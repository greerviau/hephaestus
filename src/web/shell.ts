import { isProposal } from "../config/store.js";
import { here, read, workerNeedsOwner, type FactoryPages } from "./factory.js";
import { PROJECT_FILTER_PATH, backTo, type Shell } from "./html.js";
import { cookie, readBody, redirect, type Route, type ShellSource } from "./http.js";

export const PROJECT_COOKIE = "hephaestus_project";
/** A year: the picker is a standing preference, and a stale one is ignored anyway. */
const PROJECT_COOKIE_SECONDS = 365 * 24 * 60 * 60;
const MAX_FORM_BYTES = 4096;

function factoryProjects(factory: Pick<FactoryPages, "store">): string[] {
  const version = read("projects", () => factory.store.current());
  return version.ok ? Object.keys(version.value?.document.projects ?? {}).sort() : [];
}

/**
 * The project the picker's cookie names, or undefined for all projects.
 * Home, Work, Activity, and Analytics filter by it. A cookie that names a
 * repo that is not a factory project now is ignored.
 */
function chosen(raw: string | undefined, projects: readonly string[]): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  let repo: string;
  try {
    repo = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return projects.includes(repo) ? repo : undefined;
}

/**
 * How many things wait for the owner, across every project: tasks escalated
 * to the owner, issues waiting to be admitted, proposals, workers whose next
 * step is the owner's, and notifications. T3 links about to expire are left
 * out, because every page would have to wait on T3 to count them. A part
 * that cannot be read counts as none.
 */
function needsYou(factory: FactoryPages, proposals: number): number {
  const tasks = read("tasks", () =>
    factory.tasks
      .list()
      .filter((task) => task.stage === "Escalated" && task.escalatedTo === "owner"),
  );
  const issues = read("issues", () => factory.intake.issues(["awaiting-owner", "held-cap"]));
  const workers = read("workers", () => (factory.workers?.views() ?? []).filter(workerNeedsOwner));
  // An escalation is counted from its task, as on Home.
  const notifications = read("notifications", () =>
    factory.tasks.notifications().filter((item) => item.kind !== "escalation"),
  );
  return [tasks, issues, workers, notifications].reduce(
    (sum, part) => sum + (part.ok ? part.value.length : 0),
    proposals,
  );
}

/** Reads what the sidebar shows for a request; the server calls it once per page. */
export function shellSource(factory: FactoryPages): ShellSource {
  return (request, url): Shell => {
    const paused = read("the pause switch", () => factory.pipeline.paused());
    const running = read("running threads", () => factory.pipeline.runningThreads());
    const drafts = read("proposals", () =>
      factory.store.list().filter((version) => isProposal(version) && version.state === "draft"),
    );
    const proposals = drafts.ok ? drafts.value.length : 0;
    const projects = factoryProjects(factory);
    const version = factory.version?.();
    const { updating: locked } = factory;
    const status =
      locked === undefined || (version?.behind ?? 0) === 0
        ? undefined
        : read("the update lock", locked);
    const updating = status?.ok === true ? status.value : undefined;
    const deploys = factory.deploys?.status();
    return {
      paused: paused.ok ? paused.value : undefined,
      runningThreads: running.ok ? running.value : undefined,
      needsYou: needsYou(factory, proposals),
      proposals,
      projects,
      project: chosen(cookie(request, PROJECT_COOKIE), projects),
      ...(version === undefined
        ? {}
        : {
            version: {
              ...version,
              updatable: factory.updater !== undefined,
              ...(updating === undefined ? {} : { updating }),
            },
          }),
      ...(deploys === undefined || (deploys.running === undefined && deploys.last === undefined)
        ? {}
        : { deploys }),
      // A page a form posted to has no address to come back to.
      back: request.method === "GET" ? here(url) : undefined,
    };
  };
}

/** The sidebar's project picker: sets or clears the project cookie, then returns to the page. */
export function shellRoutes(factory: Pick<FactoryPages, "store">): Route[] {
  return [
    {
      method: "POST",
      path: new RegExp(`^${PROJECT_FILTER_PATH}$`),
      handle: async ({ request, response }) => {
        const fields = new URLSearchParams((await readBody(request, MAX_FORM_BYTES)) ?? "");
        const repo = fields.get("project") ?? "";
        const known = repo !== "" && factoryProjects(factory).includes(repo);
        response.setHeader(
          "set-cookie",
          known
            ? `${PROJECT_COOKIE}=${encodeURIComponent(repo)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(PROJECT_COOKIE_SECONDS)}`
            : `${PROJECT_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
        );
        redirect(response, backTo(fields.get("back"), "/"));
      },
    },
  ];
}
