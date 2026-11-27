import type { FactoryPages } from "../../src/web/factory.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "better-sqlite3";
import { hashPassword, writePasswordHash } from "../../src/auth.js";
import { ConfigStore } from "../../src/config/store.js";
import { analytics } from "../../src/factory/analytics.js";
import { FactoryMcp } from "../../src/factory/mcp.js";
import { createDashboardServer } from "../../src/server.js";
import { openStore } from "../../src/store.js";
import type { Environments } from "../../src/t3/adapter.js";
import type { WorkerView } from "../../src/workers/manager.js";
import { workersRoutes, type EnvironmentSource } from "../../src/web/workers.js";
import { dashboardRoutes } from "../../src/web/dashboard.js";
import { shellSource } from "../../src/web/shell.js";
import { BackgroundDeploys } from "../../src/web/deploys.js";
import type { Deploy } from "../../src/web/settings.js";
import { sampleConfig } from "../config/fixtures.js";
import { SHA, harness, pr, type Harness } from "../factory/harness.js";

export const PASSWORD = "correct horse battery";
export const NOW = Date.parse("2026-11-25T12:00:00Z");
const DAY = 86_400_000;

export function linked(expiresInDays = 30): Environments {
  return {
    localEnvironmentId: "local",
    environments: [
      {
        environmentId: "w1",
        label: "worker one",
        reachable: true,
        status: "reachable",
        access: "full-access",
        expiresAt: new Date(NOW + expiresInDays * DAY).toISOString(),
        lastCallFailed: false,
      },
    ],
  };
}

export interface Dashboard {
  base: string;
  cookie: string;
  h: Harness;
  store: ConfigStore;
  mcp: FactoryMcp;
  sessions: Database;
  get(path: string): Promise<{ status: number; html: string }>;
  post(path: string, fields?: Record<string, string>): Promise<Response>;
  /** Resolves once every background deploy has ended. */
  deploysSettled(): Promise<void>;
  close(): Promise<void>;
}

export interface DashboardOptions {
  environments?: EnvironmentSource;
  workers?: WorkerView[];
  deploy?: Deploy;
  t3WaitMs?: number;
  github?: { repos(): Promise<string[]>; canonicalName(repo: string): Promise<string> };
  configRepo?: string;
  hermesModel?: string;
  messaging?: FactoryPages["messaging"];
  model?: FactoryPages["model"];
  updater?: FactoryPages["updater"];
  updating?: FactoryPages["updating"];
  version?: FactoryPages["version"];
}

/** A dashboard on a factory harness. Sessions live in a database of their own, so tests can break the factory's. */
export async function startDashboard(options: DashboardOptions = {}): Promise<Dashboard> {
  const h = harness();
  const store = new ConfigStore(h.db);
  const first = store.createVersion({ document: sampleConfig(), author: "t", message: "first" });
  store.approve(first.id);
  store.markDeployed(first.id);
  const mcp = new FactoryMcp({
    db: h.db,
    tasks: h.tasks,
    intake: h.intake,
    pipeline: h.pipeline,
    store,
    events: h.events,
    tokens: () => ({}),
  });
  const sessions = openStore(":memory:");
  writePasswordHash(sessions, hashPassword(PASSWORD));
  const workers = options.workers;
  const deploys = options.deploy === undefined ? undefined : new BackgroundDeploys(options.deploy);
  let configRepo = options.configRepo;
  const factory: FactoryPages = {
    tasks: h.tasks,
    intake: h.intake,
    pipeline: h.pipeline,
    events: h.events,
    mcp,
    store,
    analytics: (query) => analytics(h.db, { ...query, now: new Date(NOW) }),
    ...(workers === undefined ? {} : { workers: { views: () => workers } }),
    environments: options.environments ?? { environments: () => Promise.resolve(linked()) },
    ...(deploys === undefined ? {} : { deploys }),
    ...(options.github === undefined ? {} : { github: options.github }),
    configRepo: () => configRepo,
    setConfigRepo: (slug) => {
      configRepo = slug;
    },
    ...(options.messaging === undefined ? {} : { messaging: options.messaging }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.updater === undefined ? {} : { updater: options.updater }),
    ...(options.updating === undefined ? {} : { updating: options.updating }),
    ...(options.version === undefined ? {} : { version: options.version }),
    hermesModel: () => options.hermesModel,
    now: () => NOW,
    t3WaitMs: options.t3WaitMs ?? 1000,
  };
  const server: Server = createDashboardServer({
    db: sessions,
    instanceId: "test",
    shell: shellSource(factory),
    routes: [
      ...dashboardRoutes(factory),
      // Without worker setup, which needs a real manager; the Workers tests cover that.
      ...workersRoutes(factory.environments, () => NOW, undefined, options.t3WaitMs ?? 1000),
    ],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const login = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD }).toString(),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return {
    base,
    cookie,
    h,
    store,
    mcp,
    sessions,
    get: async (path) => {
      const response = await fetch(`${base}${path}`, { headers: { cookie } });
      return { status: response.status, html: await response.text() };
    },
    post: (path, fields = {}) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
        redirect: "manual",
      }),
    deploysSettled: () => deploys?.settled() ?? Promise.resolve(),
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      sessions.close();
      if (h.db.open) h.db.close();
    },
  };
}

/** A task escalated to the owner, waiting for approval to merge PR 5 at SHA. */
export function escalatedTask(h: Harness): number {
  const id = h.tasks.create({ repo: "octo/app", issueNumber: 7, title: "Fix <the> parser" }).id;
  h.tasks.transition(id, "Implementing", "work started", {
    workerEnv: "w1",
    startedAt: new Date(NOW).toISOString(),
  });
  h.tasks.transition(id, "Reviewing", "PR #5 at 1111111", { prNumber: 5, headSha: SHA });
  h.tasks.transition(id, "Merging", "approved");
  h.tasks.transition(id, "Escalated", "the PR touches .github/workflows/ci.yml", {
    escalatedTo: "owner",
    reason: "The PR touches .github/workflows/ci.yml",
    ownerAction: "merge",
  });
  h.github.prs.set(5, pr(5, SHA));
  return id;
}

/** A task implementing on w1 with a running implement thread. */
export function runningTask(h: Harness): number {
  const id = h.tasks.create({ repo: "octo/app", issueNumber: 8, title: "Add a cache" }).id;
  h.tasks.transition(id, "Implementing", "work started", {
    workerEnv: "w1",
    implementer: "codex",
    implementThread: "t-impl",
    startedAt: new Date(NOW).toISOString(),
  });
  h.events.recordThread({
    environmentId: "w1",
    threadId: "t-impl",
    title: "Hephaestus: implement task",
    providerInstanceId: "hephaestus-codex",
    model: "gpt-5.5",
    configVersion: 1,
    taskId: String(id),
    kind: "implement",
  });
  h.events.setStatus("w1", "t-impl", "running");
  h.events.upsertItems("w1", "t-impl", [
    {
      itemId: "i1",
      position: 1,
      type: "user_message",
      status: "completed",
      text: "Brief: add a <cache>",
    },
    { itemId: "i2", position: 2, type: "command", status: "in_progress", text: "npm test" },
  ]);
  return id;
}

/** An issue opened outside Hephaestus, waiting for the owner. */
export async function externalIssue(h: Harness): Promise<number> {
  h.github.issues.set(42, {
    number: 42,
    title: "Crash on <empty> input",
    body: "",
    author: "stranger",
    state: "OPEN",
  });
  await h.intake.poll();
  return 42;
}
