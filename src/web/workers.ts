import type { Environment, Environments } from "../t3/adapter.js";
import { T3ToolError } from "../t3/connection.js";
import {
  taskReason,
  type InstanceState,
  type WorkerManager,
  type WorkerTask,
  type WorkerView,
} from "../workers/manager.js";
import {
  backTo,
  buttonLink,
  callout,
  dialog,
  empty,
  escapeHtml,
  externalLink,
  keyValues,
  layout,
  loading,
  menu,
  pageHead,
  postButton,
  statusText,
  type Crumb,
  type MenuItem,
  type Shell,
  type StatusTone,
} from "./html.js";
import { readBody, redirect, sendHtml, sendJson, type Route } from "./http.js";

export interface EnvironmentSource {
  environments(): Promise<Environments>;
}

/** What the Workers page needs to set workers up. */
interface WorkerControls {
  manager: WorkerManager;
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
function publicReason(error: unknown): string {
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

/** How often the page reloads while T3 has not answered, and once it shows live worker state. */
const LOADING_RELOAD_SECONDS = 5;
const RELOAD_SECONDS = 10;

const WORKERS_PATH = "/workers";

function workersPage(shell: Shell | undefined, body: string, refreshSeconds?: number): string {
  return layout(
    "Workers",
    `${pageHead({
      title: "Workers",
      lede: "Machines linked to this host's T3. Factory threads run only on workers that are ready.",
    })}${body}`,
    { section: "/workers", shell, ...(refreshSeconds === undefined ? {} : { refreshSeconds }) },
  );
}

/** The Workers page with one machine's row held open, which a reload would otherwise close. */
function rowPath(environmentId: string): string {
  return `${WORKERS_PATH}?open=${encodeURIComponent(environmentId)}`;
}

/** A path segment as the id it names. One that is not valid encoding names no machine, so it stays as sent. */
function pathPart(segment: string | undefined): string {
  try {
    return decodeURIComponent(segment ?? "");
  } catch {
    return segment ?? "";
  }
}

function actionPath(environmentId: string, name: string): string {
  return `${WORKERS_PATH}/${encodeURIComponent(environmentId)}/${name}`;
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

/** Home warns this long before a link expires. */
const LINK_WARNING_MS = 7 * DAY_MS;

export function expiresIn(environment: Environment, now: number): string {
  const left = Date.parse(environment.expiresAt) - now;
  if (left <= 0) return "expired";
  const days = Math.floor(left / DAY_MS);
  return days === 1 ? "expires in 1 day" : `expires in ${String(days)} days`;
}

export function expiringSoon(environment: Environment, now: number): boolean {
  return Date.parse(environment.expiresAt) - now <= LINK_WARNING_MS;
}

/**
 * The Workers page: T3's linked machines with their link state, and worker
 * setup when `workers` is given.
 */
export function workersRoutes(
  source: EnvironmentSource,
  now: () => number = Date.now,
  workers?: WorkerControls,
  t3WaitMs = 2000,
): Route[] {
  /** The linked machine with this id, or undefined after the response says why there is none. */
  async function linked(
    context: Parameters<Route["handle"]>[0],
    environmentId: string,
  ): Promise<Environment | undefined> {
    let environment: Environment | undefined;
    try {
      environment = (await source.environments()).environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
    } catch (error) {
      sendHtml(context.response, 502, workersPage(context.shell, t3Callout(publicReason(error))));
      return undefined;
    }
    if (environment === undefined) {
      sendHtml(context.response, 404, workersPage(context.shell, empty("No such linked machine.")));
    }
    return environment;
  }

  const workerRoutes: Route[] =
    workers === undefined
      ? []
      : [
          {
            // The steps take longer to read than the Workers page waits between reloads, so they have a page that stays put.
            method: "GET",
            path: /^\/workers\/([^/]+)\/sign-in-claude$/,
            handle: async (context) => {
              const environmentId = pathPart(context.params[0]);
              const environment = await linked(context, environmentId);
              if (environment === undefined) return;
              const back = backTo(context.url.searchParams.get("back"), rowPath(environmentId));
              const crumbs: Crumb[] = [
                ["Workers", WORKERS_PATH],
                [environment.label, rowPath(environmentId)],
                ["Sign in Factory Claude"],
              ];
              sendHtml(
                context.response,
                200,
                layout(
                  "Sign in Factory Claude",
                  `${pageHead({
                    title: "Sign in Factory Claude",
                    lede: `On ${escapeHtml(environment.label)}. The token goes into T3, not into this page.`,
                  })}<form method="post" action="${escapeHtml(actionPath(environmentId, "sign-in-claude"))}"><input type="hidden" name="back" value="${escapeHtml(back)}"><ol class="steps"><li>Press Start sign-in. Hephaestus starts a thread on the machine.</li><li>On any machine signed in to Claude, run <code>claude setup-token</code>.</li><li>In T3, open the thread "${CLAUDE_THREAD}" on ${escapeHtml(environment.label)} and paste the token there.</li><li>The Workers page shows Factory Claude as signed in once the token is accepted.</li></ol><div class="savebar"><button type="submit" class="primary">Start sign-in</button>${buttonLink(back, "Cancel")}</div></form>`,
                  { section: "/workers", shell: context.shell, crumbs },
                ),
              );
            },
          },
          {
            method: "POST",
            path: /^\/workers\/([^/]+)\/([a-z-]+)$/,
            handle: async (context) => {
              const { request, response, params } = context;
              const environmentId = pathPart(params[0]);
              const action = params[1] ?? "";
              if (!(ACTIONS as readonly string[]).includes(action)) {
                sendHtml(response, 404, workersPage(context.shell, empty("No such action.")));
                return;
              }
              const form = new URLSearchParams((await readBody(request, 4096)) ?? "");
              const environment = await linked(context, environmentId);
              if (environment === undefined) return;
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
                    context.shell,
                    callout(
                      "err",
                      "That did not work",
                      escapeHtml(ownerReason(error)),
                      buttonLink(rowPath(environmentId), "Back to Workers"),
                    ),
                  ),
                );
                return;
              }
              redirect(response, backTo(form.get("back"), rowPath(environmentId)));
            },
          },
        ];
  return [
    ...workerRoutes,
    {
      method: "GET",
      path: /^\/workers$/,
      handle: async ({ response, shell, url }) => {
        const answer = await readEnvironments(source, t3WaitMs);
        if (answer.state === "loading") {
          sendHtml(
            response,
            200,
            workersPage(
              shell,
              loading("Asking T3 for the linked machines..."),
              LOADING_RELOAD_SECONDS,
            ),
          );
          return;
        }
        if (answer.state === "error") {
          sendHtml(response, 502, workersPage(shell, t3Callout(answer.reason), RELOAD_SECONDS));
          return;
        }
        const { environments } = answer.value;
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
              shell,
              callout(
                "err",
                "Hephaestus could not read its store",
                "Worker state is unknown, so worker actions are off. The service log has the error. Reload to try again.",
              ),
              RELOAD_SECONDS,
            ),
          );
          return;
        }
        if (environments.length === 0) {
          sendHtml(
            response,
            200,
            workersPage(
              shell,
              empty(
                "No machine is linked to this host's T3 yet. Link one in T3, then use it as a worker here.",
              ),
              RELOAD_SECONDS,
            ),
          );
          return;
        }
        const named = url.searchParams.get("open");
        // Until one machine is a worker, the step to take is inside every row, so none starts closed.
        const noneYet =
          workers !== undefined &&
          !environments.some((environment) => views.get(environment.environmentId)?.enabled);
        const rows = environments.map((environment, index) =>
          machineRow({
            environment,
            view: views.get(environment.environmentId),
            controls: workers !== undefined,
            now: now(),
            index,
            named: named === environment.environmentId,
            open: noneYet,
          }),
        );
        sendHtml(
          response,
          200,
          workersPage(
            shell,
            `<div class="grid-head" style="grid-template-columns:minmax(0,1fr) 160px 200px 16px" aria-hidden="true"><span>Machine</span><span>T3 link</span><span>${workers === undefined ? "" : "Worker"}</span><span></span></div>${rows.join("")}`,
            RELOAD_SECONDS,
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

/** The thread the Claude sign-in opens on the worker, as T3 lists it. */
const CLAUDE_THREAD = "Hephaestus: sign in Factory Claude";

function t3Callout(reason: string): string {
  return callout(
    "err",
    "T3 could not be reached",
    `Linked machines and worker state are unknown until T3 answers (${escapeHtml(reason)}). Reload to try again.`,
    buttonLink(WORKERS_PATH, "Reload"),
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const INSTANCE_STATES: Record<InstanceState, readonly [StatusTone, string]> = {
  "signed-in": ["done", "Signed in"],
  "signed-out": ["you", "Not signed in"],
  checking: ["wait", "Checking"],
  missing: ["you", "Missing"],
  disabled: ["you", "Disabled"],
  unknown: ["you", "Unknown"],
  limited: ["you", "Usage limit reached"],
};

/** A factory instance's sign-in state, with why its last sign-in or check failed. */
function instanceState(
  state: InstanceState,
  signIn: WorkerTask | undefined,
  check: WorkerTask | undefined,
): string {
  const [tone, label] =
    signIn?.status === "running" && state !== "signed-in"
      ? (["wait", "Signing in"] as const)
      : INSTANCE_STATES[state];
  const problems = [
    signIn?.status === "failed" ? `Sign-in failed: ${taskReason(signIn)}` : "",
    check?.status === "failed" ? `Check failed: ${taskReason(check)}` : "",
  ].filter((problem) => problem !== "");
  return `${statusText(tone, label)}${problems.map((problem) => `<span class="note t-bad">${escapeHtml(problem)}</span>`).join("")}`;
}

interface MachineRow {
  environment: Environment;
  view: WorkerView | undefined;
  /** Whether worker setup is available, so the row shows worker state and actions. */
  controls: boolean;
  now: number;
  /** The row's place on the page, for the ids of its dialogs. */
  index: number;
  /** Whether the address names this row, which holds it open across reloads. */
  named: boolean;
  /** Whether a row that is not a worker starts open. */
  open: boolean;
}

/** One machine: its states on the summary line, and the details and actions inside. */
function machineRow(row: MachineRow): string {
  const { environment, view, now } = row;
  const id = environment.environmentId;
  const soon = expiringSoon(environment, now);
  const expiry = expiresIn(environment, now);
  const enabled = view?.enabled === true;
  const link = !environment.reachable
    ? statusText("bad", capitalize(environment.status))
    : soon
      ? statusText(expiry === "expired" ? "bad" : "you", capitalize(expiry))
      : statusText("done", capitalize(environment.status));
  const worker = !row.controls
    ? ""
    : view === undefined || !enabled
      ? statusText("off", "Not a worker")
      : view.ready
        ? statusText("done", "Ready")
        : view.ownerStep
          ? statusText("you", "Needs you")
          : statusText("wait", "Setting up");

  const notes: string[] = [];
  const pairs: [string, string][] = [
    ["Environment", `<code>${escapeHtml(id)}</code>`],
    [
      "T3 link",
      `${escapeHtml(environment.status)}${environment.lastCallFailed ? ", last call failed" : ""}`,
    ],
    ["Access", escapeHtml(environment.access)],
    [
      "Link expiry",
      `${capitalize(expiry)} <span class="muted">${escapeHtml(environment.expiresAt)}</span>`,
    ],
  ];
  let actions = "";
  let dialogs = "";
  if (row.controls && (view === undefined || !enabled)) {
    actions = postButton(actionPath(id, "enable"), "Use as a worker", { variant: "primary" });
  } else if (row.controls && view !== undefined) {
    const claude = view.tasks["claude-sign-in"];
    const codex = view.tasks["codex-sign-in"];
    if (codex?.status === "running") {
      notes.push(
        typeof codex.detail.code === "string" && typeof codex.detail.url === "string"
          ? callout(
              "warn",
              "Approve the Codex sign-in",
              `Open ${externalLink(codex.detail.url, codex.detail.url)} and enter this code within 15 minutes. This page updates when it is approved.<br><span class="code-big">${escapeHtml(codex.detail.code)}</span>`,
            )
          : callout(
              "info",
              "Waiting for the Codex sign-in code",
              "The code shows here once the sign-in thread prints it.",
            ),
      );
    }
    if (claude?.status === "running") {
      notes.push(
        callout(
          "warn",
          "Paste the Claude token in T3",
          `Open the thread "${CLAUDE_THREAD}" on ${escapeHtml(environment.label)} in T3 and paste the token that <code>claude setup-token</code> prints.`,
        ),
      );
    }
    if (view.blocker !== undefined) pairs.push(["Next step", escapeHtml(view.blocker)]);
    pairs.push(
      [
        "Deployed config",
        view.deployedVersion === null ? "none" : `v${String(view.deployedVersion)}`,
      ],
      ["Factory Claude", instanceState(view.claude, claude, view.tasks["test-claude"])],
      ["Factory Codex", instanceState(view.codex, codex, view.tasks["test-codex"])],
    );

    const claudePath = `${actionPath(id, "sign-in-claude")}?back=${encodeURIComponent(rowPath(id))}`;
    const needs = (state: InstanceState, task: WorkerTask | undefined): boolean =>
      state !== "signed-in" &&
      state !== "checking" &&
      state !== "limited" &&
      task?.status !== "running";
    const buttons: string[] = [];
    const more: MenuItem[] = [];
    // A sign-in that is running cannot be started again, so it has no button; the callout above is its next step.
    if (needs(view.claude, claude)) {
      buttons.push(buttonLink(claudePath, "Sign in Claude", { variant: "primary" }));
    } else if (claude?.status !== "running") {
      more.push({ label: "Sign in Claude again", href: claudePath });
    }
    if (needs(view.codex, codex)) {
      buttons.push(
        postButton(
          actionPath(id, "sign-in-codex"),
          codex?.status === "failed" ? "Restart Codex sign-in" : "Sign in Codex",
          buttons.length === 0 ? { variant: "primary" } : {},
        ),
      );
    } else if (codex?.status !== "running") {
      more.push({ label: "Sign in Codex again", action: actionPath(id, "sign-in-codex") });
    }
    const stopId = `stop-${String(row.index)}`;
    more.push({ label: "Stop using as a worker", dialog: stopId, danger: true });
    dialogs = dialog({
      id: stopId,
      title: "Stop using worker",
      body: `<p>Stop using <strong>${escapeHtml(environment.label)}</strong> as a worker?</p><p class="muted">No new thread starts on it. Its factory setup stays in place, so you can use it again later.</p>`,
      action: actionPath(id, "disable"),
      submit: "Stop using",
      danger: true,
    });
    actions = `${buttons.join("")}${postButton(actionPath(id, "deploy"), "Deploy config")}${postButton(actionPath(id, "check"), "Check sign-in")}${menu(more, `More actions for ${environment.label}`)}`;
  }
  if (soon) {
    notes.push(
      callout(
        "warn",
        expiry === "expired" ? "The T3 link expired" : `The T3 link ${expiry}`,
        "Link the machine again in T3. Hephaestus reaches a worker only through that link.",
      ),
    );
  }
  const attention = soon || (enabled && !view.ready) || (!enabled && row.open);
  return `<details class="xrow"${row.named || attention ? " open" : ""}><summary><a class="title" href="${escapeHtml(row.named ? WORKERS_PATH : rowPath(id))}">${escapeHtml(environment.label)}</a><span>${link}</span><span>${worker}</span></summary><div class="xbody">${notes.join("")}${keyValues(pairs)}${actions === "" ? "" : `<div class="savebar">${actions}</div>`}</div></details>${dialogs}`;
}
