import type { Environment, Environments } from "../t3/adapter.js";
import { T3ToolError } from "../t3/connection.js";
import { taskReason, type WorkerManager, type WorkerView } from "../workers/manager.js";
import { escapeHtml, layout } from "./html.js";
import { readBody, redirect, sendHtml, sendJson, type Route } from "./http.js";

export interface EnvironmentSource {
  environments(): Promise<Environments>;
}

/** What the Environments page needs to set workers up. */
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
/** Overview warns this long before a link expires. */
export const LINK_WARNING_MS = 7 * DAY_MS;

function expiresIn(environment: Environment, now: number): string {
  const left = Date.parse(environment.expiresAt) - now;
  if (left <= 0) return "expired";
  const days = Math.floor(left / DAY_MS);
  return days === 1 ? "expires in 1 day" : `expires in ${String(days)} days`;
}

function expiringSoon(environment: Environment, now: number): boolean {
  return Date.parse(environment.expiresAt) - now <= LINK_WARNING_MS;
}

/** The Environments page: T3's linked environments with reachability, access and link expiry. */
export function environmentRoutes(
  source: EnvironmentSource,
  now: () => number = Date.now,
  workers?: WorkerControls,
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
                  layout("Config repo", '<p class="error">Name the repo as owner/name.</p>'),
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
                sendHtml(response, 404, layout("Not found", "<p>Not found.</p>"));
                return;
              }
              let environment: Environment | undefined;
              try {
                environment = (await source.environments()).environments.find(
                  (candidate) => candidate.environmentId === environmentId,
                );
              } catch (error) {
                sendHtml(
                  response,
                  502,
                  layout(
                    "Environments",
                    `<p class="error">T3 could not be reached: ${escapeHtml(publicReason(error))}</p>`,
                  ),
                );
                return;
              }
              if (environment === undefined) {
                sendHtml(response, 404, layout("Not found", "<p>No such linked environment.</p>"));
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
                  layout(
                    "Environments",
                    `<p class="error">${escapeHtml(error instanceof Error ? error.message : String(error))}</p><p><a href="/environments">Back</a></p>`,
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
        let result: Environments;
        try {
          result = await source.environments();
        } catch (error) {
          sendHtml(
            response,
            502,
            layout(
              "Environments",
              `<h1>Environments</h1>\n<p class="error">T3 could not be reached: ${escapeHtml(publicReason(error))}</p>`,
            ),
          );
          return;
        }
        const views = new Map(
          (workers?.manager.views() ?? []).map((view) => [view.environmentId, view]),
        );
        const rows = result.environments
          .map(
            (environment) => `<tr>
  <td>${escapeHtml(environment.label)}</td>
  <td><code>${escapeHtml(environment.environmentId)}</code></td>
  <td>${escapeHtml(environment.status)}${environment.lastCallFailed ? '<br><span class="error">last call failed</span>' : ""}</td>
  <td>${escapeHtml(environment.access)}</td>
  <td>${escapeHtml(environment.expiresAt)}<br><span${expiringSoon(environment, now()) ? ' class="error"' : ""}>${expiresIn(environment, now())}</span></td>
  ${workers === undefined ? "" : `<td>${workerCell(environment, views.get(environment.environmentId))}</td>`}
</tr>`,
          )
          .join("\n");
        sendHtml(
          response,
          200,
          layout(
            "Environments",
            `<h1>Environments</h1>
<p>Environments linked to this host's T3 server. Factory threads run only on workers that are ready.</p>
${workers === undefined ? "" : configRepoForm(workers.configRepo())}
<table>
<thead><tr><th>Name</th><th>Id</th><th>Reachability</th><th>Access</th><th>Link expiry</th>${workers === undefined ? "" : "<th>Worker</th>"}</tr></thead>
<tbody>
${rows}
</tbody>
</table>`,
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

/** Overview warnings for links that expire within 7 days, as HTML. */
export async function linkExpiryWarnings(
  source: EnvironmentSource,
  now: () => number = Date.now,
): Promise<string> {
  let result: Environments;
  try {
    result = await source.environments();
  } catch (error) {
    return `<p class="error">T3 could not be reached: ${escapeHtml(publicReason(error))}</p>`;
  }
  const soon = result.environments.filter((environment) => expiringSoon(environment, now()));
  if (soon.length === 0) return "";
  const items = soon
    .map(
      (environment) =>
        `<li>${escapeHtml(environment.label)}: the T3 link ${expiresIn(environment, now())}. Link it again from this host before then.</li>`,
    )
    .join("");
  return `<h2>Needs you</h2>\n<ul class="error">${items}</ul>`;
}

function configRepoForm(slug: string | undefined): string {
  return `<form method="post" action="/environments/config-repo" class="actions">
  <label for="slug">Private config repo</label>
  <input id="slug" name="slug" value="${escapeHtml(slug ?? "")}" placeholder="owner/hephaestus-config" required>
  <button type="submit">Save</button>
  ${slug === undefined ? "<span>Workers fetch config versions from this repo. Hephaestus creates it, private, on the first deploy.</span>" : ""}
</form>`;
}

function action(environmentId: string, name: string, label: string): string {
  return `<form method="post" action="/environments/${encodeURIComponent(environmentId)}/${name}"><button type="submit">${label}</button></form>`;
}

function instanceLine(name: string, state: string): string {
  return `${name}: ${escapeHtml(state.replace("-", " "))}`;
}

/** The worker column: setup state, the next step, and the actions that take it. */
function workerCell(environment: Environment, view: WorkerView | undefined): string {
  const id = environment.environmentId;
  if (view === undefined || !view.enabled) {
    return action(id, "enable", "Use as a worker");
  }
  const lines = [
    view.ready
      ? "<strong>Ready</strong>"
      : `<span class="error">${escapeHtml(view.blocker ?? "")}</span>`,
    `Deployed version: ${view.deployedVersion === null ? "none" : String(view.deployedVersion)}`,
    instanceLine("Factory Claude", view.claude),
    instanceLine("Factory Codex", view.codex),
  ];
  const claude = view.tasks["claude-sign-in"];
  if (claude?.status === "running") {
    lines.push(
      `Open the thread "Hephaestus: sign in Factory Claude" on ${escapeHtml(environment.label)} in T3 and paste the token that <code>claude setup-token</code> prints.`,
    );
  } else if (claude?.status === "failed") {
    lines.push(
      `<span class="error">Claude sign-in failed: ${escapeHtml(taskReason(claude))}</span>`,
    );
  }
  const codex = view.tasks["codex-sign-in"];
  if (codex?.status === "running") {
    lines.push(
      typeof codex.detail.code === "string" && typeof codex.detail.url === "string"
        ? `Open <a href="${escapeHtml(codex.detail.url)}" rel="noreferrer">${escapeHtml(codex.detail.url)}</a> and enter <code>${escapeHtml(codex.detail.code)}</code> within 15 minutes.`
        : "Waiting for the Codex sign-in code.",
    );
  } else if (codex?.status === "failed") {
    lines.push(`<span class="error">Codex sign-in failed: ${escapeHtml(taskReason(codex))}</span>`);
  }
  for (const kind of ["test-claude", "test-codex"] as const) {
    const test = view.tasks[kind];
    if (test?.status === "failed") {
      lines.push(
        `<span class="error">${kind === "test-claude" ? "Claude" : "Codex"} check: ${escapeHtml(taskReason(test))}</span>`,
      );
    }
  }
  const buttons = [
    action(id, "deploy", "Deploy"),
    action(id, "sign-in-claude", "Sign in Claude"),
    action(id, "sign-in-codex", "Sign in Codex"),
    action(id, "check", "Check sign-in"),
    action(id, "disable", "Stop using"),
  ];
  return `${lines.join("<br>")}<div class="actions">${buttons.join("")}</div>`;
}
