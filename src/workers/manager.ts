import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { FactoryConfig } from "../config/document.js";
import type { ConfigStore } from "../config/store.js";
import { getMeta, setMeta } from "../meta.js";
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
  clientRequestId: string;
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
  /** What the last check of T3's provider list found wrong with a factory instance. */
  instanceProblem: string | null;
}

export type InstanceState = "signed-in" | "signed-out" | "checking" | "missing" | "unknown";

export interface WorkerView extends Worker {
  /** The latest task of each kind. */
  tasks: Partial<Record<TaskKind, WorkerTask>>;
  claude: InstanceState;
  codex: InstanceState;
  ready: boolean;
  /** Why the worker is not ready, as the next thing to do. */
  blocker: string | undefined;
}

/** The version every worker should run, and the commit its tag points at. */
export interface DesiredDeploy {
  version: number;
  sha: string;
  tag: string;
  /** The repo the tag was published to; a change of repo applies from the next publish. */
  url: string;
}

interface TaskRow {
  id: number;
  environment_id: string;
  kind: TaskKind;
  client_request_id: string;
  message: string;
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
  instance_problem: string | null;
  checked_at: string | null;
}

function toTask(row: TaskRow): WorkerTask {
  return {
    id: row.id,
    environmentId: row.environment_id,
    kind: row.kind,
    clientRequestId: row.client_request_id,
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
    instanceProblem: row.instance_problem,
  };
}

/** The factory instances as T3's provider list on a worker reports them. */
export interface InstanceReport {
  providerInstanceId: string;
  constraints: string[];
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
  /** T3's provider list on a worker, when T3 offers it to Hephaestus; undefined when it does not. */
  instances?: (environmentId: string) => Promise<InstanceReport[] | undefined>;
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

const MINUTE = 60_000;
/** How long a task may run before Hephaestus gives up on it. */
const TIMEOUTS: Record<TaskKind, number> = {
  deploy: 30 * MINUTE,
  "claude-sign-in": 60 * MINUTE,
  "codex-sign-in": 30 * MINUTE,
  "test-claude": 15 * MINUTE,
  "test-codex": 15 * MINUTE,
  cleanup: 15 * MINUTE,
};
/** A launch whose reply never came is replayed, with the same request id, after this. */
const LAUNCH_GRACE_MS = 2 * MINUTE;
const LAUNCH_ATTEMPTS = 3;
/** A failed deploy is retried automatically after this. */
const DEPLOY_RETRY_MS = 30 * MINUTE;
/** Each worker is deployed again this often, so owner skills added since are disabled for Factory Codex. */
const REDEPLOY_MS = 6 * 60 * MINUTE;
/** T3's provider list on each worker is checked this often. */
const INSTANCE_CHECK_MS = 10 * MINUTE;
const DESIRED_KEY = "desired_deploy";

/**
 * Sets up workers and keeps them on the deployed config version. Every step
 * on a worker is a short T3 thread: a deploy thread runs a fixed script that
 * installs the version and the two factory provider instances, sign-in
 * threads take the owner's credentials, and a test turn on each instance
 * proves it is signed in.
 */
export class WorkerManager {
  private readonly now: () => Date;
  private deploying: Promise<unknown> = Promise.resolve();

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

  desired(): DesiredDeploy | undefined {
    const value = getMeta(this.db, DESIRED_KEY);
    return value === undefined ? undefined : (JSON.parse(value) as DesiredDeploy);
  }

  task(id: number): WorkerTask | undefined {
    const row = this.db.prepare("SELECT * FROM worker_tasks WHERE id = ?").get(id) as
      TaskRow | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  latestTask(environmentId: string, kind: TaskKind, status?: TaskStatus): WorkerTask | undefined {
    const row = (
      status === undefined
        ? this.db
            .prepare(
              "SELECT * FROM worker_tasks WHERE environment_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
            )
            .get(environmentId, kind)
        : this.db
            .prepare(
              "SELECT * FROM worker_tasks WHERE environment_id = ? AND kind = ? AND status = ? ORDER BY id DESC LIMIT 1",
            )
            .get(environmentId, kind, status)
    ) as TaskRow | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  runningTasks(): WorkerTask[] {
    return (
      this.db
        .prepare("SELECT * FROM worker_tasks WHERE status = 'running' ORDER BY id")
        .all() as TaskRow[]
    ).map(toTask);
  }

  /** Factory threads, not setup threads, running on a worker or with a launch T3 has not answered. */
  runningFactoryThreads(environmentId: string): number {
    const ended = [...ENDED_STATUSES];
    const running = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM factory_threads WHERE environment_id = ? AND kind != 'setup'
           AND status NOT IN (${ended.map(() => "?").join(", ")})`,
        )
        .get(environmentId, ...ended) as { n: number }
    ).n;
    const pending = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM factory_launches WHERE environment_id = ? AND kind != 'setup' AND status = 'pending'",
        )
        .get(environmentId) as { n: number }
    ).n;
    return running + pending;
  }

  /** Each worker with its latest tasks and whether it can take factory threads. */
  views(): WorkerView[] {
    return this.workers().map((worker) => this.view(worker));
  }

  view(worker: Worker): WorkerView {
    const id = worker.environmentId;
    const tasks: Partial<Record<TaskKind, WorkerTask>> = {};
    for (const kind of Object.keys(KIND_TITLES) as TaskKind[]) {
      const task = this.latestTask(id, kind);
      if (task !== undefined) tasks[kind] = task;
    }
    // A test proves a sign-in only if it started after the deploy and the sign-in now in place.
    const deployedAt = this.latestTask(id, "deploy", "succeeded")?.id ?? 0;
    const state = (signIn: TaskKind, test: TaskKind, name: string): InstanceState => {
      if (worker.instanceProblem?.startsWith(name) === true) return "missing";
      if (tasks[signIn]?.status === "running" || tasks[test]?.status === "running") {
        return "checking";
      }
      const signedInAt = this.latestTask(id, signIn, "succeeded")?.id ?? 0;
      const result = tasks[test];
      if (result === undefined || result.id < Math.max(deployedAt, signedInAt)) return "unknown";
      return result.status === "succeeded" ? "signed-in" : "signed-out";
    };
    const claude = state("claude-sign-in", "test-claude", "Factory Claude");
    const codex = state("codex-sign-in", "test-codex", "Factory Codex");
    const desired = this.desired();
    let blocker: string | undefined;
    if (!worker.enabled) blocker = "Not marked as a worker.";
    else if (desired === undefined) blocker = "No config version is deployed yet.";
    else if (tasks.deploy?.status === "running") blocker = "A deploy is running.";
    else if (tasks.deploy?.status === "failed") {
      blocker = `The last deploy failed: ${taskReason(tasks.deploy)}`;
    } else if (worker.deployedVersion !== desired.version || worker.deployedSha !== desired.sha) {
      blocker =
        this.runningFactoryThreads(id) > 0
          ? `Waiting for running factory threads to finish before deploying version ${String(desired.version)}.`
          : `Deploy version ${String(desired.version)}.`;
    } else if (this.redeployDue(worker)) {
      blocker = "Due for its periodic redeploy, which refreshes the factory skill settings.";
    } else if (worker.instanceProblem !== null) blocker = worker.instanceProblem;
    else if (claude !== "signed-in") blocker = "Sign in Factory Claude.";
    else if (codex !== "signed-in") blocker = "Sign in Factory Codex.";
    return { ...worker, tasks, claude, codex, ready: blocker === undefined, blocker };
  }

  /** Workers that may take a new factory thread. */
  readyWorkers(): WorkerView[] {
    return this.views().filter((view) => view.ready);
  }

  /**
   * Publishes a version to the config repo, marks it deployed, applies it to
   * the factory Hermes root, and deploys it to every worker that is not
   * running factory threads; the others follow when their threads finish.
   */
  deployVersion(id: number): Promise<{ sha: string; hermesError?: string }> {
    return this.serialized(async () => {
      const repo = this.options.configRepo();
      if (repo === undefined) throw new Error("Name the private config repo first.");
      const version = this.options.store.get(id);
      if (version.state === "approved") {
        // Checked before pushing anything, so a stale version publishes nothing.
        this.options.store.assertDeployable(id);
      } else if (version.state !== "deployed") {
        throw new Error(`Version ${String(id)} is ${version.state}; approve it first.`);
      }
      await repo.ensureRemote();
      const sha = await repo.publish(id, version.document);
      // The version's state and the rollout target change together, so a crash cannot split them.
      this.db.transaction(() => {
        if (this.options.store.get(id).state === "approved") this.options.store.markDeployed(id);
        const desired = this.desired();
        if (desired === undefined || id >= desired.version) {
          const target: DesiredDeploy = { version: id, sha, tag: repo.tagFor(id), url: repo.url };
          setMeta(this.db, DESIRED_KEY, JSON.stringify(target));
        }
      })();
      let hermesError: string | undefined;
      try {
        await this.options.syncHermes?.();
      } catch (error) {
        hermesError = errorText(error);
        console.error("Applying the version to the factory Hermes root failed", error);
      }
      await this.reconcileNow(true);
      return hermesError === undefined ? { sha } : { sha, hermesError };
    });
  }

  /** Publishing, rollouts, and reconciliation run one at a time, so none acts on a stale target. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.deploying.then(work, work);
    this.deploying = next.catch(() => undefined);
    return next;
  }

  private redeployDue(worker: Worker): boolean {
    const last = this.latestTask(worker.environmentId, "deploy", "succeeded");
    return last !== undefined && this.now().getTime() - Date.parse(last.updatedAt) >= REDEPLOY_MS;
  }

  /** Starts a deploy of the desired version on one worker, at the owner's request. */
  deploy(environmentId: string): Promise<WorkerTask> {
    return this.serialized(async () => {
      const desired = this.desired();
      if (desired === undefined) throw new Error("Deploy a version from Settings first.");
      const running = this.latestTask(environmentId, "deploy");
      if (running?.status === "running") return running;
      const threads = this.runningFactoryThreads(environmentId);
      if (threads > 0) {
        throw new Error(
          `${String(threads)} factory threads are running on this worker. It deploys when they finish, so they keep the version they started with.`,
        );
      }
      return this.startDeploy(environmentId, desired);
    });
  }

  private startDeploy(environmentId: string, desired: DesiredDeploy): Promise<WorkerTask> {
    return this.start(
      environmentId,
      "deploy",
      deployMessage(desired.version, desired.sha, desired.url, desired.tag),
      { version: desired.version, sha: desired.sha },
    );
  }

  /**
   * Deploys the desired version to each enabled worker that does not run it,
   * once its factory threads have finished. A failed deploy is retried after
   * a pause, and a worker is deployed again every few hours.
   */
  private reconcile(): Promise<void> {
    return this.serialized(() => this.reconcileNow(false));
  }

  private async reconcileNow(now: boolean): Promise<void> {
    for (const { environmentId } of this.workers()) {
      // The target and the worker are read again for each launch.
      const desired = this.desired();
      const worker = this.worker(environmentId);
      if (desired === undefined || worker === undefined || !worker.enabled) continue;
      const last = this.latestTask(environmentId, "deploy");
      if (last?.status === "running") continue;
      if (this.runningFactoryThreads(environmentId) > 0) continue;
      const current =
        worker.deployedVersion === desired.version && worker.deployedSha === desired.sha;
      const age = last === undefined ? Infinity : this.now().getTime() - Date.parse(last.updatedAt);
      if (current && last?.status === "succeeded" && age < REDEPLOY_MS) continue;
      if (!now && last?.status === "failed" && age < DEPLOY_RETRY_MS) continue;
      await this.startDeploy(environmentId, desired);
    }
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

  /** Starts a cleanup thread on a worker; uninstall waits for it and calls {@link finish}. */
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
    const at = this.now().toISOString();
    // The task and its request id go in before T3 is called, so a lost reply can be replayed.
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO worker_tasks (environment_id, kind, client_request_id, message, version, sha,
             status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(
          environmentId,
          kind,
          `hephaestus-${kind}-${randomUUID()}`,
          message,
          extra.version ?? null,
          extra.sha ?? null,
          at,
          at,
        ).lastInsertRowid,
    );
    await this.launch(id);
    const task = this.task(id);
    if (task === undefined) throw new Error(`Worker task ${String(id)} vanished.`);
    return task;
  }

  /**
   * Launches the task's thread. A replay uses the same request id, which T3
   * answers with the thread it already started, if any.
   */
  private async launch(id: number): Promise<void> {
    const row = this.db.prepare("SELECT * FROM worker_tasks WHERE id = ?").get(id) as
      TaskRow | undefined;
    if (row === undefined) return;
    const { environment_id: environmentId, kind, client_request_id: clientRequestId } = row;
    const config = this.config();
    const choice =
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
          providerInstanceId: choice.providerInstanceId,
          model: choice.model,
          ...(choice.options === undefined
            ? {}
            : {
                options: Object.entries(choice.options).map(([optionId, value]) => ({
                  id: optionId,
                  value,
                })),
              }),
          runtimeMode: "full-access",
          message: row.message,
          clientRequestId,
        },
        {
          configVersion: row.version ?? this.desired()?.version ?? 0,
          cardId: null,
          kind: "setup",
        },
      );
      this.update(id, { threadId });
    } catch (error) {
      // A refused launch is final; a lost reply is replayed on a later tick.
      if (this.options.events.launch(clientRequestId)?.status === "failed") {
        this.update(id, {
          status: "failed",
          detail: { reason: `T3 would not start the thread: ${errorText(error)}` },
        });
      } else {
        console.error(`Starting ${kind} on ${environmentId} got no reply from T3`, error);
      }
    }
  }

  private config(): FactoryConfig {
    const version =
      this.options.store.list().find((candidate) => candidate.state === "deployed") ??
      this.options.store.current();
    if (version === undefined) throw new Error("There is no config version.");
    return version.document;
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

  private fail(task: WorkerTask, reason: string): void {
    const current = this.task(task.id) ?? task;
    this.update(task.id, { status: "failed", detail: { ...current.detail, reason } });
  }

  /** Moves running tasks forward, deploys where needed, and checks the factory instances. */
  async tick(): Promise<void> {
    for (const task of this.runningTasks()) {
      await this.advance(task);
    }
    await this.reconcile();
    await this.checkInstances();
  }

  private async advance(task: WorkerTask): Promise<void> {
    const age = this.now().getTime() - Date.parse(task.createdAt);
    if (task.threadId === null) {
      const launch = this.options.events.launch(task.clientRequestId);
      if (launch?.status === "launched" && launch.threadId !== null) {
        this.update(task.id, { threadId: launch.threadId });
      } else if (launch?.status === "failed") {
        this.fail(task, "T3 would not start the thread");
      } else if (this.now().getTime() - Date.parse(task.updatedAt) > LAUNCH_GRACE_MS) {
        const attempts = typeof task.detail.attempts === "number" ? task.detail.attempts : 1;
        if (attempts >= LAUNCH_ATTEMPTS) {
          this.fail(task, "T3 did not answer the launch; check the worker's link");
        } else {
          this.update(task.id, { detail: { ...task.detail, attempts: attempts + 1 } });
          await this.launch(task.id);
        }
      }
      return;
    }
    const thread = this.options.events.thread(task.environmentId, task.threadId);
    if (thread === undefined) {
      if (age > TIMEOUTS[task.kind]) this.fail(task, "it took too long; try again");
      return;
    }
    const items = this.options.events.items(task.environmentId, task.threadId);
    if (task.kind === "codex-sign-in" && task.detail.code === undefined) {
      const device = parseDeviceCode(items);
      if (device !== undefined) this.update(task.id, { detail: { ...task.detail, ...device } });
    }
    if (!ENDED_STATUSES.has(thread.status)) {
      if (age > TIMEOUTS[task.kind]) this.fail(task, "it took too long; try again");
      return;
    }
    await this.finish(task, thread.status, finalMessage(items) ?? "");
  }

  /** Records a task's outcome from its thread's final status and message. */
  async finish(task: WorkerTask, status: string, text: string): Promise<void> {
    const current = this.task(task.id) ?? task;
    if (current.status !== "running") return;
    const succeed = (detail: Record<string, unknown> = {}): void => {
      this.update(task.id, { status: "succeeded", detail: { ...current.detail, ...detail } });
    };
    if (status !== "completed") {
      this.fail(task, `the thread ended ${status}`);
      return;
    }
    switch (task.kind) {
      case "deploy": {
        const result = parseDeploy(text);
        if ("failure" in result) {
          this.fail(task, result.failure);
          return;
        }
        if (result.version !== task.version || result.head !== task.sha) {
          this.fail(
            task,
            `the worker reported version ${String(result.version)} at ${result.head}, not version ${String(task.version)} at ${String(task.sha)}`,
          );
          return;
        }
        this.db
          .prepare(
            "UPDATE workers SET deployed_version = ?, deployed_sha = ?, home = ?, instance_problem = NULL, updated_at = ? WHERE environment_id = ?",
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
          this.fail(task, /TOKEN-FAILED (.+)/.exec(text)?.[1] ?? "the token was not stored");
          return;
        }
        succeed();
        await this.startOnce(task.environmentId, "test-claude", testTurnMessage());
        return;
      case "codex-sign-in":
        if (!text.includes("CODEX-SIGNED-IN")) {
          this.fail(task, "the device login was not approved in time");
          return;
        }
        succeed();
        await this.startOnce(task.environmentId, "test-codex", testTurnMessage());
        return;
      case "test-claude":
      case "test-codex":
        if (text.includes(TEST_REPLY)) {
          succeed();
          this.db
            .prepare("UPDATE workers SET checked_at = NULL WHERE environment_id = ?")
            .run(task.environmentId);
        } else
          this.fail(
            task,
            text.trim() === "" ? "no reply" : `replied: ${text.trim().slice(0, 200)}`,
          );
        return;
      case "cleanup": {
        const result = /CLEANED (instances=\S+ hephaestus=removed)/.exec(text)?.[1];
        if (result !== undefined) succeed({ result });
        else
          this.fail(
            task,
            /CLEANUP-FAILED (.+)/.exec(text)?.[1] ?? "the cleanup did not report success",
          );
        return;
      }
    }
  }

  /**
   * Asks T3 which provider instances each set-up worker has. A missing or
   * broken factory instance makes the worker not ready until a deploy or a
   * sign-in fixes it.
   */
  private async checkInstances(): Promise<void> {
    const probe = this.options.instances;
    if (probe === undefined) return;
    const at = this.now();
    for (const row of this.db
      .prepare("SELECT * FROM workers WHERE enabled = 1 AND deployed_version IS NOT NULL")
      .all() as WorkerRow[]) {
      if (row.checked_at !== null && at.getTime() - Date.parse(row.checked_at) < INSTANCE_CHECK_MS)
        continue;
      if (this.latestTask(row.environment_id, "deploy")?.status === "running") continue;
      let reports: InstanceReport[] | undefined;
      try {
        reports = await probe(row.environment_id);
      } catch (error) {
        console.error(`Checking the provider instances on ${row.label} failed`, error);
        continue;
      }
      // A worker whose T3 does not offer the provider list keeps what the last check found.
      if (reports === undefined) continue;
      let problem: string | null = null;
      {
        for (const [id, name] of [
          [FACTORY_CLAUDE, "Factory Claude"],
          [FACTORY_CODEX, "Factory Codex"],
        ] as const) {
          const report = reports.find((candidate) => candidate.providerInstanceId === id);
          if (report === undefined) problem ??= `${name} is missing on this worker; deploy again.`;
          else {
            // Sign-in is judged by the test turns; anything else T3 reports is a problem.
            const other = report.constraints.filter((text) => !/authenticat|log ?in/i.test(text));
            if (other.length > 0) problem ??= `${name}: ${other.join(" ")}`;
          }
        }
      }
      this.db
        .prepare("UPDATE workers SET instance_problem = ?, checked_at = ? WHERE environment_id = ?")
        .run(problem, at.toISOString(), row.environment_id);
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
