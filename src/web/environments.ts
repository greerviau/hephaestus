import type { Environment, Environments } from "../t3/adapter.js";
import { T3ToolError } from "../t3/connection.js";
import { taskReason, type WorkerManager, type WorkerView } from "../workers/manager.js";
import {
  banner,
  card,
  empty,
  escapeHtml,
  layout,
  loading,
  pageHead,
  pill,
  postButton,
  status,
  table,
} from "./html.js";
import { readBody, redirect, sendHtml, sendJson, type Route } from "./http.js";

export interface EnvironmentSource {
  environments(): Promise<Environments>;
}

/** What the Workers page needs to set workers up. */
export interface WorkerControls {
  manager: WorkerManager;
  configRepo(): string | undefined;
  setConfigRepo(slug: string): void;
}

const ACTIONS = [
  "enable",
  "disable",
  "deploy",
  "sign-in-claude",
  "sign-in-codex",
  "check",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A short reason that is safe to show: T3's error code, or a system error
 * code such as ECONNREFUSED. Upstream message text is left out, because it can
 * carry response bodies. The full error goes to the service log.
 */
export function publicReason(error: unknown): string {
  console.error("T3 request failed", error);
  if (error instanceof T3ToolError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z_]+$/.test(code)) return code;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof cause === "string" && /^[A-Z_]+$/.test(cause)) return cause;
  return "unknown error";
}
/**
 * An error's text when Hephaestus raised it itself, which tells the owner
 * what to do next. An error from T3, GitHub, or a command carries a cause or
 * a code, and only its short reason is shown.
 */
export function ownerReason(error: unknown): string {
  if (
    error instanceof Error &&
    !(error instanceof T3ToolError) &&
    error.cause === undefined &&
    (error as { code?: unknown }).code === undefined
  ) {
    return error.message;
  }
  return `T3 or GitHub failed (${publicReason(error)}). The service log has the details.`;
}

const RELOAD_SECONDS = 5;

function workersPage(body: string, refreshSeconds?: number): string {
  return layout(
    "Workers",
    `${pageHead({
      title: "Workers",
      lede: "Environments linked to this host's T3 server. Factory threads run only on workers that are ready.",
    })}${body}`,
    { section: "/environments", ...(refreshSeconds === undefined ? {} : { refreshSeconds }) },
  );
}

export type T3Read =
  { state: "ok"; value: Environments } | { state: "loading" } | { state: "error"; reason: string };

/** T3's linked environments, or loading when T3 has not answered within `waitMs`. */
export async function readEnvironments(source: EnvironmentSource, waitMs: number): Promise<T3Read> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T3Read>((resolve) => {
    timer = setTimeout(() => {
      resolve({ state: "loading" });
    }, waitMs);
  });
  const answer = source.environments().then(
    (value): T3Read => ({ state: "ok", value }),
    (error: unknown): T3Read => ({ state: "error", reason: publicReason(error) }),
  );
  try {
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Overview warns this long before a link expires. */
export const LINK_WARNING_MS = 7 * DAY_MS;

export function expiresIn(environment: Environment, now: number): string {
  const left = Date.parse(environment.expiresAt) - now;
  if (left <= 0) return "expired";
  const days = Math.floor(left / DAY_MS);
  return days === 1 ? "expires in 1 day" : `expires in ${String(days)} days`;
}

export function expiringSoon(environment: Environment, now: number): boolean {
  return Date.parse(environment.expiresAt) - now <= LINK_WARNING_MS;
}

/** The Environments page: T3's linked environments with reachability, access and link expiry. */
export function environmentRoutes(
  source: EnvironmentSource,
  now: () => number = Date.now,
  workers?: WorkerControls,
  t3WaitMs = 2000,
): Route[] {
  const workerRoutes: Route[] =
    workers === undefined
      ? []
      : [
          {
            method: "POST",
            path: /^\/environments\/config-repo$/,
            handle: async ({ request, response }) => {
              const slug = new URLSearchParams((await readBody(request, 4096)) ?? "")
                .get("slug")
                ?.trim();
              if (slug === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
                sendHtml(
                  response,
                  400,
                  workersPage(
                    `${banner("err", "Config repo not saved", "Name the repo as owner/name.")}<p><a href="/environments">Back to Workers</a></p>`,
                  ),
                );
                return;
              }
              workers.setConfigRepo(slug);
              redirect(response, "/environments");
            },
          },
          {
            method: "POST",
            path: /^\/environments\/([^/]+)\/([a-z-]+)$/,
            handle: async ({ response, params }) => {
              const [environmentId = "", action = ""] = params;
              if (!(ACTIONS as readonly string[]).includes(action)) {
                sendHtml(response, 404, workersPage(empty("No such action.")));
                return;
              }
              let environment: Environment | undefined;
              try {
                environment = (await source.environments()).environments.find(
                  (candidate) => candidate.environmentId === environmentId,
                );
              } catch (error) {
                sendHtml(response, 502, workersPage(t3Banner(publicReason(error))));
                return;
              }
              if (environment === undefined) {
                sendHtml(response, 404, workersPage(empty("No such linked environment.")));
                return;
              }
              const { manager } = workers;
              try {
                if (action === "enable" || action === "disable") {
                  manager.setEnabled(environmentId, environment.label, action === "enable");
                } else if (action === "deploy") await manager.deploy(environmentId);
                else if (action === "sign-in-claude")
                  await manager.startClaudeSignIn(environmentId);
                else if (action === "sign-in-codex") await manager.startCodexSignIn(environmentId);
                else await manager.startTests(environmentId);
              } catch (error) {
                sendHtml(
                  response,
                  409,
                  workersPage(
                    `${banner("err", "That did not work", ownerReason(error))}<p><a href="/environments">Back to Workers</a></p>`,
                  ),
                );
                return;
              }
              redirect(response, "/environments");
            },
          },
        ];
  return [
    ...workerRoutes,
    {
      method: "GET",
      path: /^\/environments$/,
      handle: async ({ response }) => {
        const answer = await readEnvironments(source, t3WaitMs);
        if (answer.state === "loading") {
          sendHtml(
            response,
            200,
            workersPage(
              card({
                title: "Linked environments",
                body: loading("Asking T3 for the linked environments..."),
                busy: true,
              }),
              RELOAD_SECONDS,
            ),
          );
          return;
        }
        if (answer.state === "error") {
          sendHtml(response, 502, workersPage(t3Banner(answer.reason)));
          return;
        }
        const result = answer.value;
        let views: Map<string, WorkerView>;
        try {
          views = new Map(
            (workers?.manager.views() ?? []).map((view) => [view.environmentId, view]),
          );
        } catch (error) {
          console.error("Reading workers for the dashboard failed", error);
          sendHtml(
            response,
            503,
            workersPage(
              banner(
                "err",
                "Hephaestus could not read its store",
                "Worker state is unknown, so worker actions are off. The service log has the error. Reload to try again.",
              ),
            ),
          );
          return;
        }
        const rows = result.environments.map((environment) => [
          `${escapeHtml(environment.label)}<span class="sub"><code>${escapeHtml(environment.environmentId)}</code></span>`,
          `${
            environment.reachable
              ? status("good", "ok", escapeHtml(environment.status))
              : status("crit", "x", escapeHtml(environment.status))
          }${environment.lastCallFailed ? `<span class="sub s-crit">last call failed</span>` : ""}`,
          escapeHtml(environment.access),
          `${expiringSoon(environment, now()) ? status("warn", "warn", expiresIn(environment, now())) : escapeHtml(expiresIn(environment, now()))}<span class="sub">${escapeHtml(environment.expiresAt)}</span>`,
          ...(workers === undefined
            ? []
            : [workerCell(environment, views.get(environment.environmentId))]),
        ]);
        const columns = [
          { label: "Environment", className: "title-cell" },
          { label: "Reachability" },
          { label: "Access" },
          { label: "Link expiry" },
          ...(workers === undefined ? [] : [{ label: "Worker" }]),
        ];
        sendHtml(
          response,
          200,
          workersPage(
            `<div class="grid">${workers === undefined ? "" : card({ title: "Config repo", body: configRepoForm(workers.configRepo()) })}${card(
              {
                title: "Linked environments",
                meta: `<span class="meta">${String(result.environments.length)} linked</span>`,
                body:
                  rows.length === 0
                    ? empty(
                        "No environment is linked to this host's T3 yet. Link one in T3, then mark it as a worker here.",
                      )
                    : table(columns, rows),
              },
            )}</div>`,
          ),
        );
      },
    },
    {
      method: "GET",
      path: /^\/api\/environments$/,
      handle: async ({ response }) => {
        try {
          sendJson(response, 200, await source.environments());
        } catch (error) {
          sendJson(response, 502, { error: publicReason(error) });
        }
      },
    },
  ];
}

function t3Banner(reason: string): string {
  return banner(
    "err",
    "T3 could not be reached",
    `Linked environments and worker state are unknown until T3 answers (${reason}). Reload to try again.`,
  );
}

function configRepoForm(slug: string | undefined): string {
  return `<form method="post" action="/environments/config-repo" class="filterbar">
  <div class="field grow"><label for="slug">Private config repo</label>
  <input type="text" id="slug" name="slug" value="${escapeHtml(slug ?? "")}" placeholder="owner/hephaestus-config" required></div>
  <button type="submit" class="btn-secondary">Save</button>
</form>
${slug === undefined ? '<p class="hint">Workers fetch config versions from this repo. Hephaestus creates it, private, on the first deploy.</p>' : ""}`;
}

function action(environmentId: string, name: string, label: string, primary = false): string {
  return postButton(`/environments/${encodeURIComponent(environmentId)}/${name}`, label, {
    variant: primary ? "primary" : "secondary",
  });
}

function instanceLine(name: string, state: string): string {
  const text = `${name}: ${state === "limited" ? "usage limit reached" : state.replace("-", " ")}`;
  return state === "signed-in"
    ? status("good", "ok", escapeHtml(text))
    : state === "checking"
      ? status("neutral", "clock", escapeHtml(text))
      : status("warn", "q", escapeHtml(text));
}

/** The worker column: setup state, the next step, and the actions that take it. */
function workerCell(environment: Environment, view: WorkerView | undefined): string {
  const id = environment.environmentId;
  if (view === undefined || !view.enabled) {
    return `${pill("off", "Not a worker")}<div class="btn-row">${action(id, "enable", "Use as a worker", true)}</div>`;
  }
  const lines = [
    view.ready ? pill("done", "Ready") : status("warn", "warn", escapeHtml(view.blocker ?? "")),
    `<span class="sub">Deployed version: ${view.deployedVersion === null ? "none" : String(view.deployedVersion)}</span>`,
    instanceLine("Factory Claude", view.claude),
    instanceLine("Factory Codex", view.codex),
  ];
  const claude = view.tasks["claude-sign-in"];
  if (claude?.status === "running") {
    lines.push(
      `<p class="hint">Open the thread "Hephaestus: sign in Factory Claude" on ${escapeHtml(environment.label)} in T3 and paste the token that <code>claude setup-token</code> prints.</p>`,
    );
  } else if (claude?.status === "failed") {
    lines.push(status("crit", "x", `Claude sign-in failed: ${escapeHtml(taskReason(claude))}`));
  }
  const codex = view.tasks["codex-sign-in"];
  if (codex?.status === "running") {
    lines.push(
      typeof codex.detail.code === "string" && typeof codex.detail.url === "string"
        ? `<p class="hint">Open <a href="${escapeHtml(codex.detail.url)}" rel="noreferrer">${escapeHtml(codex.detail.url)}</a> and enter this code within 15 minutes:</p><span class="devcode">${escapeHtml(codex.detail.code)}</span>`
        : '<p class="hint">Waiting for the Codex sign-in code.</p>',
    );
  } else if (codex?.status === "failed") {
    lines.push(status("crit", "x", `Codex sign-in failed: ${escapeHtml(taskReason(codex))}`));
  }
  for (const kind of ["test-claude", "test-codex"] as const) {
    const test = view.tasks[kind];
    if (test?.status === "failed") {
      lines.push(
        status(
          "crit",
          "x",
          `${kind === "test-claude" ? "Claude" : "Codex"} check: ${escapeHtml(taskReason(test))}`,
        ),
      );
    }
  }
  const buttons = [
    action(id, "deploy", "Deploy"),
    action(id, "sign-in-claude", "Sign in Claude", view.claude !== "signed-in"),
    action(id, "sign-in-codex", "Sign in Codex", view.codex !== "signed-in"),
    action(id, "check", "Check sign-in"),
    action(id, "disable", "Stop using"),
  ];
  return `<div class="stack-8">${lines.join("")}</div><div class="btn-row">${buttons.join("")}</div>`;
}
