import type { Database } from "better-sqlite3";
import type { FactoryConfig } from "../config/document.js";
import type { ConfigStore } from "../config/store.js";
import type { T3Adapter } from "../t3/adapter.js";
import { ENDED_STATUSES, type ThreadEvents } from "../t3/events.js";
import type { FactoryThreads } from "../t3/threads.js";
import type { ConfigRepo } from "./config-repo.js";
import {
  TEST_REPLY,
  claudeSignInMessage,
  cleanupMessage,
  codexSignInMessage,
  deployMessage,
  finalMessage,
  parseDeploy,
  parseDeviceCode,
  testTurnMessage,
} from "./scripts.js";

export const FACTORY_CLAUDE = "hephaestus-claude";
export const FACTORY_CODEX = "hephaestus-codex";

export type TaskKind =
  "deploy" | "claude-sign-in" | "codex-sign-in" | "test-claude" | "test-codex" | "cleanup";
export type TaskStatus = "running" | "succeeded" | "failed";

export interface WorkerTask {
  id: number;
  environmentId: string;
  kind: TaskKind;
  threadId: string | null;
  version: number | null;
  sha: string | null;
  status: TaskStatus;
  /** Free-form facts about the task: a failure reason, a device code, a deploy result. */
  detail: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Worker {
  environmentId: string;
  label: string;
  enabled: boolean;
  home: string | null;
  deployedVersion: number | null;
  deployedSha: string | null;
}

export type InstanceState = "signed-in" | "signed-out" | "checking" | "unknown";

export interface WorkerView extends Worker {
  /** The latest task of each kind. */
  tasks: Partial<Record<TaskKind, WorkerTask>>;
  claude: InstanceState;
  codex: InstanceState;
  ready: boolean;
  /** Why the worker is not ready, as the next thing to do. */
  blocker: string | undefined;
}

interface TaskRow {
  id: number;
  environment_id: string;
  kind: TaskKind;
  thread_id: string | null;
  version: number | null;
  sha: string | null;
  status: TaskStatus;
  detail: string;
  created_at: string;
  updated_at: string;
}

interface WorkerRow {
  environment_id: string;
  label: string;
  enabled: number;
  home: string | null;
  deployed_version: number | null;
  deployed_sha: string | null;
}

function toTask(row: TaskRow): WorkerTask {
  return {
    id: row.id,
    environmentId: row.environment_id,
    kind: row.kind,
    threadId: row.thread_id,
    version: row.version,
    sha: row.sha,
    status: row.status,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWorker(row: WorkerRow): Worker {
  return {
    environmentId: row.environment_id,
    label: row.label,
    enabled: row.enabled === 1,
    home: row.home,
    deployedVersion: row.deployed_version,
    deployedSha: row.deployed_sha,
  };
}

export interface WorkerManagerOptions {
  db: Database;
  store: ConfigStore;
  t3: T3Adapter;
  threads: FactoryThreads;
  events: ThreadEvents;
  /** The config repo, or undefined until the owner names one. */
  configRepo: () => ConfigRepo | undefined;
  /** Applies the deployed version to the factory Hermes root. */
  syncHermes?: () => Promise<void>;
  now?: () => Date;
}

const KIND_TITLES: Record<TaskKind, string> = {
  deploy: "Hephaestus: deploy config",
  "claude-sign-in": "Hephaestus: sign in Factory Claude",
  "codex-sign-in": "Hephaestus: sign in Factory Codex",
  "test-claude": "Hephaestus: check Factory Claude",
  "test-codex": "Hephaestus: check Factory Codex",
  cleanup: "Hephaestus: remove factory setup",
};

/**
 * Sets up workers and keeps them on the deployed config version. Every step
 * on a worker is a short T3 thread: a deploy thread runs a fixed script that
 * installs the version and the two factory provider instances, sign-in
 * threads take the owner's credentials, and a test turn on each instance
 * proves it is signed in.
 */
export class WorkerManager {
  private readonly now: () => Date;

  constructor(private readonly options: WorkerManagerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private get db(): Database {
    return this.options.db;
  }

  worker(environmentId: string): Worker | undefined {
    const row = this.db
      .prepare("SELECT * FROM workers WHERE environment_id = ?")
      .get(environmentId) as WorkerRow | undefined;
    return row === undefined ? undefined : toWorker(row);
  }

  workers(): Worker[] {
    return (this.db.prepare("SELECT * FROM workers ORDER BY label").all() as WorkerRow[]).map(
      toWorker,
    );
  }

  /** Marks an environment as a worker, or stops using it for new factory threads. */
  setEnabled(environmentId: string, label: string, enabled: boolean): void {
    const at = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO workers (environment_id, label, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (environment_id) DO UPDATE SET label = excluded.label,
           enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(environmentId, label, enabled ? 1 : 0, at, at);
  }

  task(id: number): WorkerTask | undefined {
    const row = this.db.prepare("SELECT * FROM worker_tasks WHERE id = ?").get(id) as
      TaskRow | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  latestTask(environmentId: string, kind: TaskKind): WorkerTask | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM worker_tasks WHERE environment_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
      )
      .get(environmentId, kind) as TaskRow | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  runningTasks(): WorkerTask[] {
    return (
      this.db
        .prepare("SELECT * FROM worker_tasks WHERE status = 'running' ORDER BY id")
        .all() as TaskRow[]
    ).map(toTask);
  }

  /** Each worker with its latest tasks and whether it can take factory threads. */
  views(): WorkerView[] {
    return this.workers().map((worker) => this.view(worker));
  }

  view(worker: Worker): WorkerView {
    const tasks: Partial<Record<TaskKind, WorkerTask>> = {};
    for (const kind of Object.keys(KIND_TITLES) as TaskKind[]) {
      const task = this.latestTask(worker.environmentId, kind);
      if (task !== undefined) tasks[kind] = task;
    }
    const state = (signIn: TaskKind, test: TaskKind): InstanceState => {
      if (tasks[signIn]?.status === "running" || tasks[test]?.status === "running") {
        return "checking";
      }
      const result = tasks[test];
      if (result === undefined) return "unknown";
      return result.status === "succeeded" ? "signed-in" : "signed-out";
    };
    const claude = state("claude-sign-in", "test-claude");
    const codex = state("codex-sign-in", "test-codex");
    const deployed = this.options.store.list().find((version) => version.state === "deployed");
    let blocker: string | undefined;
    if (!worker.enabled) blocker = "Not marked as a worker.";
    else if (deployed === undefined) blocker = "No config version is deployed yet.";
    else if (tasks.deploy?.status === "running") blocker = "A deploy is running.";
    else if (worker.deployedVersion !== deployed.id) {
      blocker =
        tasks.deploy?.status === "failed"
          ? `The last deploy failed: ${taskReason(tasks.deploy)}`
          : `Deploy version ${String(deployed.id)}.`;
    } else if (claude !== "signed-in") blocker = "Sign in Factory Claude.";
    else if (codex !== "signed-in") blocker = "Sign in Factory Codex.";
    return { ...worker, tasks, claude, codex, ready: blocker === undefined, blocker };
  }

  /** Workers that may take a new factory thread. */
  readyWorkers(): WorkerView[] {
    return this.views().filter((view) => view.ready);
  }

  /**
   * Publishes a version to the config repo, marks it deployed, applies it to
   * the factory Hermes root, and starts a deploy thread on every worker.
   */
  async deployVersion(id: number): Promise<{ sha: string; hermesError?: string }> {
    const repo = this.options.configRepo();
    if (repo === undefined) throw new Error("Name the private config repo first.");
    const version = this.options.store.get(id);
    if (version.state === "approved") {
      // Check this before pushing anything, so a stale version publishes nothing.
      this.options.store.assertDeployable(id);
    } else if (version.state !== "deployed") {
      throw new Error(`Version ${String(id)} is ${version.state}; approve it first.`);
    }
    await repo.ensureRemote();
    const sha = await repo.publish(id, version.document);
    if (version.state === "approved") this.options.store.markDeployed(id);
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('deployed_sha', ?)").run(sha);
    let hermesError: string | undefined;
    try {
      await this.options.syncHermes?.();
    } catch (error) {
      hermesError = error instanceof Error ? error.message : String(error);
      console.error("Applying the version to the factory Hermes root failed", error);
    }
    for (const worker of this.workers()) {
      if (worker.enabled) await this.deploy(worker.environmentId);
    }
    return hermesError === undefined ? { sha } : { sha, hermesError };
  }

  /** Starts a deploy thread for the deployed version on one worker. */
  async deploy(environmentId: string): Promise<WorkerTask> {
    const repo = this.options.configRepo();
    if (repo === undefined) throw new Error("Name the private config repo first.");
    const deployed = this.options.store.list().find((version) => version.state === "deployed");
    const sha = (
      this.db.prepare("SELECT value FROM meta WHERE key = 'deployed_sha'").get() as
        { value: string } | undefined
    )?.value;
    if (deployed === undefined || sha === undefined) throw new Error("Deploy a version first.");
    const running = this.latestTask(environmentId, "deploy");
    if (running?.status === "running") return running;
    return this.start(environmentId, "deploy", deployMessage(deployed.id, sha, repo.url), {
      version: deployed.id,
      sha,
    });
  }

  startClaudeSignIn(environmentId: string): Promise<WorkerTask> {
    return this.startOnce(environmentId, "claude-sign-in", claudeSignInMessage());
  }

  startCodexSignIn(environmentId: string): Promise<WorkerTask> {
    return this.startOnce(environmentId, "codex-sign-in", codexSignInMessage());
  }

  /** Starts a test turn on both factory instances. */
  async startTests(environmentId: string): Promise<void> {
    await this.startOnce(environmentId, "test-claude", testTurnMessage());
    await this.startOnce(environmentId, "test-codex", testTurnMessage());
  }

  /** Starts a cleanup thread on a worker; uninstall waits for it with {@link waitForTask}. */
  startCleanup(environmentId: string): Promise<WorkerTask> {
    return this.start(environmentId, "cleanup", cleanupMessage(), {});
  }

  private async startOnce(
    environmentId: string,
    kind: TaskKind,
    message: string,
  ): Promise<WorkerTask> {
    const running = this.latestTask(environmentId, kind);
    if (running?.status === "running") return running;
    return this.start(environmentId, kind, message, {});
  }

  private async start(
    environmentId: string,
    kind: TaskKind,
    message: string,
    extra: { version?: number; sha?: string },
  ): Promise<WorkerTask> {
    const config = this.config();
    const at = this.now().toISOString();
    const insert = this.db
      .prepare(
        `INSERT INTO worker_tasks (environment_id, kind, client_request_id, version, sha, status,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        environmentId,
        kind,
        `pending-${environmentId}-${kind}-${at}-${String(Math.random())}`,
        extra.version ?? null,
        extra.sha ?? null,
        at,
        at,
      );
    const id = Number(insert.lastInsertRowid);
    const clientRequestId = `hephaestus-${kind}-${String(id)}-${environmentId}`;
    this.db
      .prepare("UPDATE worker_tasks SET client_request_id = ? WHERE id = ?")
      .run(clientRequestId, id);
    const instance =
      kind === "test-claude"
        ? { providerInstanceId: FACTORY_CLAUDE, ...config.factory.models.claude }
        : kind === "test-codex"
          ? { providerInstanceId: FACTORY_CODEX, ...config.factory.models.codex }
          : {
              providerInstanceId: config.factory.setup.instanceId,
              model: config.factory.setup.model,
              ...(config.factory.setup.options === undefined
                ? {}
                : { options: config.factory.setup.options }),
            };
    try {
      const threadId = await this.options.threads.launch(
        {
          environmentId,
          title: KIND_TITLES[kind],
          providerInstanceId: instance.providerInstanceId,
          model: instance.model,
          ...(instance.options === undefined
            ? {}
            : {
                options: Object.entries(instance.options).map(([optionId, value]) => ({
                  id: optionId,
                  value,
                })),
              }),
          runtimeMode: "full-access",
          message,
          clientRequestId,
        },
        { configVersion: extra.version ?? this.deployedId() ?? 0, cardId: null, kind: "setup" },
      );
      this.update(id, { threadId });
    } catch (error) {
      this.update(id, {
        status: "failed",
        detail: { reason: `T3 would not start the thread: ${errorText(error)}` },
      });
    }
    const task = this.task(id);
    if (task === undefined) throw new Error(`Worker task ${String(id)} vanished.`);
    return task;
  }

  private config(): FactoryConfig {
    const version =
      this.options.store.list().find((candidate) => candidate.state === "deployed") ??
      this.options.store.current();
    if (version === undefined) throw new Error("There is no config version.");
    return version.document;
  }

  private deployedId(): number | undefined {
    return this.options.store.list().find((version) => version.state === "deployed")?.id;
  }

  private update(
    id: number,
    fields: { threadId?: string; status?: TaskStatus; detail?: Record<string, unknown> },
  ): void {
    const task = this.task(id);
    if (task === undefined) return;
    this.db
      .prepare(
        "UPDATE worker_tasks SET thread_id = ?, status = ?, detail = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        fields.threadId ?? task.threadId,
        fields.status ?? task.status,
        JSON.stringify(fields.detail ?? task.detail),
        this.now().toISOString(),
        id,
      );
  }

  /** Moves every running task forward from what the follower stored of its thread. */
  async tick(): Promise<void> {
    for (const task of this.runningTasks()) {
      await this.advance(task);
    }
  }

  private async advance(task: WorkerTask): Promise<void> {
    if (task.threadId === null) return;
    const thread = this.options.events.thread(task.environmentId, task.threadId);
    if (thread === undefined) return;
    const items = this.options.events.items(task.environmentId, task.threadId);
    if (task.kind === "codex-sign-in" && task.detail.code === undefined) {
      const device = parseDeviceCode(items);
      if (device !== undefined) this.update(task.id, { detail: { ...task.detail, ...device } });
    }
    if (!ENDED_STATUSES.has(thread.status)) return;
    await this.finish(task, thread.status, finalMessage(items) ?? "");
  }

  /** Records a task's outcome from its thread's final status and message. */
  async finish(task: WorkerTask, status: string, text: string): Promise<void> {
    const current = this.task(task.id) ?? task;
    const fail = (reason: string): void => {
      this.update(task.id, { status: "failed", detail: { ...current.detail, reason } });
    };
    const succeed = (detail: Record<string, unknown> = {}): void => {
      this.update(task.id, { status: "succeeded", detail: { ...current.detail, ...detail } });
    };
    if (status !== "completed" && task.kind !== "cleanup") {
      fail(`the thread ended ${status}`);
      return;
    }
    switch (task.kind) {
      case "deploy": {
        const result = parseDeploy(text);
        if ("failure" in result) {
          fail(result.failure);
          return;
        }
        const sha = task.sha;
        if (result.version !== task.version || result.head !== sha) {
          fail(
            `the worker reported version ${String(result.version)} at ${result.head}, not version ${String(task.version)} at ${String(sha)}`,
          );
          return;
        }
        this.db
          .prepare(
            "UPDATE workers SET deployed_version = ?, deployed_sha = ?, home = ?, updated_at = ? WHERE environment_id = ?",
          )
          .run(
            result.version,
            result.head,
            result.home,
            this.now().toISOString(),
            task.environmentId,
          );
        succeed({ instances: result.instances });
        // A deploy can add or repair the instances, so their sign-in is checked again.
        await this.startTests(task.environmentId);
        return;
      }
      case "claude-sign-in":
        if (!text.includes("TOKEN-SET")) {
          fail(/TOKEN-FAILED (.+)/.exec(text)?.[1] ?? "the token was not stored");
          return;
        }
        succeed();
        await this.startOnce(task.environmentId, "test-claude", testTurnMessage());
        return;
      case "codex-sign-in":
        if (!text.includes("CODEX-SIGNED-IN")) {
          fail("the device login was not approved in time");
          return;
        }
        succeed();
        await this.startOnce(task.environmentId, "test-codex", testTurnMessage());
        return;
      case "test-claude":
      case "test-codex":
        if (text.includes(TEST_REPLY)) succeed();
        else fail(text.trim() === "" ? "no reply" : `replied: ${text.trim().slice(0, 200)}`);
        return;
      case "cleanup":
        if (/CLEANED/.test(text)) succeed({ result: /CLEANED (.+)/.exec(text)?.[1] ?? "" });
        else fail(`the thread ended ${status} without cleaning up`);
        return;
    }
  }
}

/** The reason a task gave for failing, or `fallback`. */
export function taskReason(task: WorkerTask | undefined, fallback = "unknown"): string {
  const reason = task?.detail.reason;
  return typeof reason === "string" ? reason : fallback;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
