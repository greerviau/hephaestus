import { here, read, type FactoryPages } from "./factory.js";
import { PROJECT_FILTER_PATH, backTo, type Shell } from "./html.js";
import { cookie, readBody, redirect, type Route, type ShellSource } from "./http.js";
import { ownerCount, ownerItems, ownerSources } from "./needs-owner.js";

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

/** Reads what the sidebar shows for a request; the server calls it once per page. */
export function shellSource(factory: FactoryPages): ShellSource {
  return (request, url): Shell => {
    const paused = read("the pause switch", () => factory.pipeline.paused());
    const running = read("running threads", () => factory.pipeline.runningThreads());
    const projects = factoryProjects(factory);
    const project = chosen(cookie(request, PROJECT_COOKIE), projects);
    // The count on Home is Home's own list of what needs the owner, for the project it shows.
    const needs = ownerItems(ownerSources(factory, project), project);
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
      needsYou: ownerCount(needs),
      proposals: needs.proposals.length,
      projects,
      project,
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
