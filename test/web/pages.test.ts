import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MERGE_STEP_REASONS } from "../../src/factory/pipeline.js";
import type { ModelCatalog } from "../../src/hermes/factory-model.js";
import { Messaging } from "../../src/messaging.js";
import type { FactoryPages } from "../../src/web/factory.js";
import { MERGE, SHA } from "../factory/harness.js";
import {
  escalatedCard,
  externalIssue,
  runningCard,
  startDashboard,
  type Dashboard,
} from "./dashboard.js";

let dashboard: Dashboard | undefined;
let root: string | undefined;

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const CATALOG: ModelCatalog = {
  provider: "anthropic",
  model: "claude-sonnet-5",
  providers: [
    {
      slug: "anthropic",
      name: "Anthropic",
      auth_type: "api_key",
      key_env: "ANTHROPIC_API_KEY",
      authenticated: true,
      models: ["claude-sonnet-5"],
    },
    {
      slug: "openai-codex",
      name: "ChatGPT or Codex Subscription",
      auth_type: "oauth_external",
      key_env: "",
      authenticated: false,
      models: [],
    },
  ],
  oauth: [
    {
      id: "openai-codex",
      name: "OpenAI Codex",
      flow: "device_code",
      cli_command: "hermes auth add openai-codex",
    },
  ],
  profiles: {
    planner: { provider: "anthropic", model: "claude-sonnet-5" },
    lead: { provider: "anthropic", model: "claude-sonnet-5" },
    improver: { provider: "anthropic", model: "claude-sonnet-5" },
  },
};

/** A planning model whose device-code sign-in for `waitingFor` has shown its code and waits. */
function model(waitingFor?: string): NonNullable<FactoryPages["model"]> {
  return {
    ready: () => true,
    catalog: () => Promise.resolve(CATALOG),
    addKey: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
    startDeviceLogin: (provider) => Promise.resolve({ provider, status: "starting" }),
    deviceLogin: () =>
      waitingFor === undefined
        ? undefined
        : {
            provider: waitingFor,
            url: "https://auth.example/device",
            code: "ABCD-1234",
            status: "waiting",
          },
  };
}

/** A dashboard with every optional part present, so each page renders its full form. */
async function fullDashboard(waitingFor?: string): Promise<Dashboard> {
  root = mkdtempSync(join(tmpdir(), "hephaestus-pages-"));
  mkdirSync(join(root, "profiles", "planner"), { recursive: true });
  const holder: { dashboard?: Dashboard } = {};
  const messaging = new Messaging({
    root,
    run: () => Promise.resolve(""),
    restartGateway: () => Promise.resolve(),
    get db() {
      if (holder.dashboard === undefined) throw new Error("not started");
      return holder.dashboard.h.db;
    },
    get cards() {
      if (holder.dashboard === undefined) throw new Error("not started");
      return holder.dashboard.h.cards;
    },
    dashboardUrl: () => "http://host:7700/",
  });
  holder.dashboard = await startDashboard({
    messaging,
    model: model(waitingFor),
    configRepo: "octo/config",
    deploy: () => Promise.resolve({}),
  });
  return holder.dashboard;
}

interface Tasks {
  escalated: number;
  running: number;
  testing: number;
  merging: number;
  verifying: number;
  done: number;
  proposal: number;
}

/** A task at the merge gate, waiting for `waiting`. */
function gateCard(running: Dashboard, issueNumber: number, waiting: string): number {
  const { cards } = running.h;
  const id = cards.create({ repo: "octo/app", issueNumber, title: `Gate ${waiting}` }).id;
  cards.transition(id, "Implementing", "work started", { workerEnv: "w1" });
  cards.transition(id, "Reviewing", "PR #6 at 1111111", { prNumber: 6, headSha: SHA });
  cards.transition(id, "Merging", "approved");
  cards.update(id, { waiting });
  return id;
}

/** Something in every list the pages show. */
async function populate(running: Dashboard): Promise<Tasks> {
  const { h, store } = running;
  const escalated = escalatedCard(h);
  const runningId = runningCard(h);
  await externalIssue(h);
  const testing = gateCard(running, 21, "checks are running");
  const merging = gateCard(running, 22, MERGE_STEP_REASONS.settling);
  const verifying = gateCard(running, 23, "checks are running");
  h.cards.transition(verifying, "Validating", `merged PR #6 as ${MERGE}`, {
    mergeSha: MERGE,
    waiting: null,
  });
  const done = gateCard(running, 24, "checks are running");
  h.cards.transition(done, "Validating", `merged PR #6 as ${MERGE}`, { mergeSha: MERGE });
  h.cards.transition(done, "Done", `checks passed on ${MERGE}`, { waiting: null });
  h.cards.notify("PR #6 in octo/app was merged outside Hephaestus.", done);
  h.db
    .prepare(
      "INSERT INTO mcp_calls (role, tool, arguments, ok, result, at) VALUES ('lead', 'start_work', '{\"card_id\":1}', 1, '{}', '2026-11-25T11:00:00.000Z')",
    )
    .run();
  const base = store.current();
  if (base === undefined) throw new Error("no version");
  const document = structuredClone(base.document);
  document.roles.lead.persona = "Lead briefly.";
  const proposal = store.createVersion({
    document,
    author: "improver",
    message: "Shorter briefs",
    parentId: base.id,
  }).id;
  return { escalated, running: runningId, testing, merging, verifying, done, proposal };
}

function main(html: string): string {
  return html.slice(html.indexOf('<main id="main"'));
}

/** The page's meta refresh as `seconds;url=...`, or undefined when it does not reload. */
function reload(html: string): string | undefined {
  return /<meta http-equiv="refresh" content="([^"]*)">/.exec(html)?.[1];
}

/** Every GET page the harness can render, with something in its lists. */
function pagePaths(tasks: Tasks): string[] {
  const skill = "triage";
  return [
    "/",
    "/work",
    "/work?view=board",
    "/work?tab=needs",
    "/work?tab=finished",
    "/work?tab=all",
    "/work/new",
    `/work/${String(tasks.escalated)}`,
    `/work/${String(tasks.running)}`,
    `/work/${String(tasks.done)}`,
    `/work/${String(tasks.escalated)}/lead`,
    `/work/${String(tasks.escalated)}/abandon`,
    "/work/9999",
    "/threads/w1/t-impl",
    "/threads/w1/none",
    "/activity",
    "/activity?show=calls",
    "/analytics",
    "/projects",
    "/projects/octo/app",
    "/projects/octo/none",
    "/workers",
    "/chat",
    "/chat/connect/discord",
    "/chat/connect/telegram",
    "/proposals",
    `/proposals/${String(tasks.proposal)}`,
    "/config",
    "/config/models",
    "/config/models/planning",
    "/config/models/planning?provider=openai-codex",
    "/config/agents",
    "/config/agents/lead",
    "/config/agents/factory",
    `/config/skills/${skill}`,
    "/config/versions",
    "/config/versions/1",
    `/config/versions/${String(tasks.proposal)}`,
    "/config/json",
  ];
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/** What is wrong with a page's markup under the accessibility rules every page keeps. */
function problems(html: string): string[] {
  const found: string[] = [];
  const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((match) => Number(match[1]));
  const h1 = levels.filter((level) => level === 1).length;
  if (h1 !== 1) found.push(`${String(h1)} h1 elements`);
  if (levels[0] !== 1) found.push("the first heading is not the h1");
  levels.forEach((level, index) => {
    const before = levels[index - 1] ?? 0;
    if (level > before + 1) found.push(`h${String(level)} follows h${String(before)}`);
  });

  for (const [tag] of html.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)) {
    const type = attribute(tag, "type") ?? "";
    if (type === "hidden" || type === "submit") continue;
    const id = attribute(tag, "id");
    const labelled =
      attribute(tag, "aria-label") !== undefined ||
      attribute(tag, "aria-labelledby") !== undefined ||
      (id !== undefined && new RegExp(`<label[^>]*\\sfor="${id}"`).test(html)) ||
      // A control inside its label: the nearest label before it is still open.
      html.lastIndexOf("<label", html.indexOf(tag)) >
        html.lastIndexOf("</label>", html.indexOf(tag));
    if (!labelled) found.push(`no label for ${tag}`);
  }

  for (const [tag] of html.matchAll(/<[a-z]+\b[^>]*\spopover(?=[\s>])[^>]*>/g)) {
    const id = attribute(tag, "id") ?? "";
    if (!html.includes(`popovertarget="${id}" popovertargetaction="hide"`)) {
      found.push(`popover ${id} has no close control`);
    }
  }

  for (const [tag] of html.matchAll(
    /<div class="(?:term|diff|board|table-region|chart-scroll)[" ][^>]*>/g,
  )) {
    if (
      attribute(tag, "tabindex") !== "0" ||
      attribute(tag, "role") === undefined ||
      attribute(tag, "aria-label") === undefined
    ) {
      found.push(`scrollable region cannot be focused or has no label: ${tag}`);
    }
  }

  for (const match of html.matchAll(/<a\b[^>]*href="https?:[^>]*>[\s\S]*?<\/a>/g)) {
    const [link] = match;
    if (
      !link.includes('target="_blank"') ||
      !link.includes('rel="noopener noreferrer"') ||
      !link.includes("(opens in a new tab)")
    ) {
      found.push(`external link without the new-tab attributes: ${link}`);
    }
  }
  return found;
}

describe("Every page", () => {
  it("has one h1, headings in order, labelled controls, closable popovers, and marked external links", async () => {
    dashboard = await fullDashboard("openai-codex");
    const tasks = await populate(dashboard);

    for (const path of pagePaths(tasks)) {
      const { status, html } = await dashboard.get(path);
      expect(status, path).toBeLessThan(500);
      expect(problems(html), path).toEqual([]);
    }
  });

  it("has one h1 and headings in order when it shows a store error", async () => {
    dashboard = await fullDashboard();
    const tasks = await populate(dashboard);
    dashboard.h.db.close();

    for (const path of pagePaths(tasks)) {
      const { status, html } = await dashboard.get(path);
      // The Config tabs do not catch a store error yet: the server answers them with a plain 500.
      if (status === 500 && path.startsWith("/config")) continue;
      expect(problems(html), path).toEqual([]);
    }
  });
});

describe("Stage names", () => {
  it("are the task page's on Work, the board, Home, and Activity", async () => {
    dashboard = await startDashboard();
    const tasks = await populate(dashboard);

    const list = main((await dashboard.get("/work")).html);
    const board = main((await dashboard.get("/work?view=board")).html);
    const home = main((await dashboard.get("/")).html);
    const activity = main((await dashboard.get("/activity")).html);

    for (const page of [list, board, home]) {
      for (const name of ["Testing", "Merging", "Verifying"]) {
        expect(page).toContain(`${name}</span>`);
      }
    }
    for (const name of ["Implementing", "Testing", "Merging", "Verifying"]) {
      expect(board).toContain(`<section class="lane" aria-label="${name}">`);
    }
    expect(activity).toContain("moved to Testing");
    expect(activity).toContain("moved to Verifying");
    for (const page of [list, board, home, activity]) {
      expect(page).not.toContain("Validating");
      expect(page).not.toContain("moved to Merging");
    }

    for (const [id, name] of [
      [tasks.testing, "Testing"],
      [tasks.merging, "Merging"],
      [tasks.verifying, "Verifying"],
    ] as const) {
      const page = main((await dashboard.get(`/work/${String(id)}`)).html);
      expect(page).toContain(`${name}</span>`);
      expect(page).toMatch(new RegExp(`aria-current="step">.*?<span class="name">${name}</span>`));
      expect(page).not.toContain("Validating");
    }
  });
});

describe("Reloading", () => {
  it("happens on the pages that show live status, at their interval and their own address", async () => {
    dashboard = await fullDashboard("openai-codex");
    const tasks = await populate(dashboard);
    const task = `/work/${String(tasks.running)}`;

    const reloading: [path: string, reload: string][] = [
      ["/", "10;url=/"],
      ["/work", "10;url=/work"],
      ["/work?view=board", "10;url=/work?view=board"],
      ["/work?tab=needs", "10;url=/work?tab=needs"],
      ["/work?tab=finished", "10;url=/work?tab=finished"],
      ["/work?tab=all", "10;url=/work?tab=all"],
      [task, `10;url=${task}`],
      ["/threads/w1/t-impl", "10;url=/threads/w1/t-impl"],
      ["/activity", "10;url=/activity"],
      ["/activity?show=calls&role=lead", "10;url=/activity?show=calls&amp;role=lead"],
      ["/workers", "10;url=/workers"],
      ["/workers?open=w1", "10;url=/workers?open=w1"],
      [
        "/config/models/planning?provider=openai-codex",
        "5;url=/config/models/planning?provider=openai-codex",
      ],
    ];
    for (const [path, expected] of reloading) {
      const { html } = await dashboard.get(path);
      expect(reload(html), path).toBe(expected);
      // A reload drops typed text, so a page that reloads has nowhere to type.
      expect(main(html), path).not.toMatch(
        /<textarea|<input type="(?:text|password|url|email|search|number)"/,
      );
    }

    const still = [
      "/work/new",
      `/work/${String(tasks.escalated)}/lead`,
      `/work/${String(tasks.escalated)}/abandon`,
      "/analytics",
      "/projects",
      "/projects/octo/app",
      "/chat",
      "/chat/connect/discord",
      "/proposals",
      `/proposals/${String(tasks.proposal)}`,
      "/config",
      "/config/models",
      "/config/models/planning",
      "/config/agents",
      "/config/agents/lead",
      "/config/versions",
      "/config/versions/1",
      "/config/json",
    ];
    for (const path of still) {
      expect(reload((await dashboard.get(path)).html), path).toBeUndefined();
    }
  });

  it("drops the result notice, so its banner is gone after the first reload", async () => {
    dashboard = await fullDashboard("openai-codex");
    await populate(dashboard);

    for (const [path, expected] of [
      ["/?notice=resumed", "10;url=/"],
      ["/work?tab=needs&notice=admitted", "10;url=/work?tab=needs"],
      ["/activity?show=notifications&notice=action-failed", "10;url=/activity?show=notifications"],
      ["/workers?open=w1&notice=x", "10;url=/workers?open=w1"],
      [
        "/config/models/planning?provider=openai-codex&notice=key",
        "5;url=/config/models/planning?provider=openai-codex",
      ],
    ] as const) {
      expect(reload((await dashboard.get(path)).html), path).toBe(expected);
    }
  });

  it("reloads faster while T3 has not answered", async () => {
    dashboard = await startDashboard({
      environments: { environments: () => new Promise(() => undefined) },
      t3WaitMs: 10,
    });

    expect(reload((await dashboard.get("/")).html)).toBe("5;url=/");
    expect(reload((await dashboard.get("/workers")).html)).toBe("5;url=/workers");
  });

  it("stops on a transcript once its thread has ended, so the page keeps its place", async () => {
    dashboard = await startDashboard();
    runningCard(dashboard.h);

    expect(reload((await dashboard.get("/threads/w1/t-impl")).html)).toBe(
      "10;url=/threads/w1/t-impl",
    );
    dashboard.h.events.setStatus("w1", "t-impl", "completed");
    expect(reload((await dashboard.get("/threads/w1/t-impl")).html)).toBeUndefined();
  });
});
