import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { FactoryConfig } from "../config/document.js";
import type { ConfigStore } from "../config/store.js";
import { getMeta, setMeta } from "../meta.js";
import type { T3Adapter } from "../t3/adapter.js";
import { utcMinute } from "../time.js";
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
  limitText,
  usageLimit,
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
  /** Positions in one sequence shared by tasks and checks, which orders events within a millisecond. */
  createdSeq: number;
  doneSeq: number | null;
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
  /** What the last check of T3's provider list found for each factory instance. */
  instances: Partial<Record<Provider, InstanceCheck>>;
}

export type Provider = "claude" | "codex";

export interface InstanceCheck {
  exists: boolean;
  enabled: boolean;
  /** False when T3 said the instance is not signed in. */
  authenticated: boolean;
  /** Anything else T3 reported that stops the instance from running. */
  problem: string | null;
  at: string;
  /** Where the check falls in the sequence tasks use. */
  seq: number;
}

export type InstanceState =
  | "signed-in"
  | "signed-out"
  | "checking"
  | "missing"
  | "disabled"
  | "unknown"
  /** The check ran into the provider's usage limit, which says nothing about the sign-in. */
  | "limited";

export interface WorkerView extends Worker {
  /** The latest task of each kind. */
  tasks: Partial<Record<TaskKind, WorkerTask>>;
  claude: InstanceState;
  codex: InstanceState;
  ready: boolean;
  /** Why the worker is not ready, as the next thing to do. */
  blocker: string | undefined;
  /** Whether that next thing is the owner's, as opposed to something Hephaestus does on its own. */
  ownerStep: boolean;
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
  created_seq: number;
  done_seq: number | null;
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
    createdSeq: row.created_seq,
    doneSeq: row.done_seq,
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
    instances:
      row.instance_problem === null
        ? {}
        : (JSON.parse(row.instance_problem) as Partial<Record<Provider, InstanceCheck>>),
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
  /** Threads T3 lists as running on a worker with a title containing `title`. */
  activeThreads?: (environmentId: string, title: string) => Promise<string[]>;
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
/** How long after a check hit a usage limit it runs again, when T3 does not say when the limit resets. */
const LIMIT_RECHECK_MS = 30 * MINUTE;
/** How long after the reset T3 reports a check runs again, for clocks a little apart. */
const LIMIT_GRACE_MS = MINUTE;
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
    // A thread waiting on a question runs nothing until someone answers it.
    const ended = [...ENDED_STATUSES, "waiting"];
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
    const deployed = this.latestTask(id, "deploy", "succeeded");
    const state = (provider: Provider): InstanceState => {
      const [signIn, test]: [TaskKind, TaskKind] =
        provider === "claude" ? ["claude-sign-in", "test-claude"] : ["codex-sign-in", "test-codex"];
      const check = worker.instances[provider];
      if (check?.exists === false) return "missing";
      if (check?.enabled === false) return "disabled";
      if (tasks[signIn]?.status === "running" || tasks[test]?.status === "running") {
        return "checking";
      }
      const signedIn = this.latestTask(id, signIn, "succeeded");
      const result = tasks[test];
      if (result === undefined) return "unknown";
      if (!certifies(result, [deployed, signedIn])) return "unknown";
      if (result.status !== "succeeded") {
        return result.detail.limited === true ? "limited" : "signed-out";
      }
      // T3 saying the instance lost its sign-in after the test outranks the test.
      if (check?.authenticated === false && check.seq > (result.doneSeq ?? 0)) return "signed-out";
      return "signed-in";
    };
    const claude = state("claude");
    const codex = state("codex");
    const problems = (["claude", "codex"] as const).flatMap((provider) => {
      const check = worker.instances[provider];
      const name = provider === "claude" ? "Factory Claude" : "Factory Codex";
      if (check === undefined) return [];
      if (!check.exists) return [`${name} is missing on this worker; deploy again.`];
      if (!check.enabled) return [`${name} is disabled on this worker; deploy again.`];
      return check.problem === null ? [] : [`${name}: ${check.problem}`];
    });
    const desired = this.desired();
    let blocker: string | undefined;
    // Steps Hephaestus takes on its own; everything else waits for the owner.
    let automatic = false;
    if (!worker.enabled) blocker = "Not marked as a worker.";
    else if (desired === undefined) blocker = "No config version is deployed yet.";
    else if (tasks.deploy?.status === "running") {
      blocker = "A deploy is running.";
      automatic = true;
    } else if (this.deployThreadRunning(id)) {
      blocker = "An earlier deploy thread is still running; waiting for it to end.";
      automatic = true;
    } else if (tasks.deploy?.status === "failed") {
      blocker = `The last deploy failed: ${taskReason(tasks.deploy)}`;
    } else if (worker.deployedVersion !== desired.version || worker.deployedSha !== desired.sha) {
      blocker =
        this.runningFactoryThreads(id) > 0
          ? `Waiting for running factory threads to finish before deploying version ${String(desired.version)}.`
          : `Deploy version ${String(desired.version)}.`;
      automatic = true;
    } else if (this.redeployDue(worker)) {
      blocker = "Due for its periodic redeploy, which refreshes the factory skill settings.";
      automatic = true;
    } else if (problems.length > 0) blocker = problems.join(" ");
    else if (
      (claude === "limited" && (codex === "signed-in" || codex === "limited")) ||
      (codex === "limited" && claude === "signed-in")
    ) {
      const name = claude === "limited" ? "Factory Claude" : "Factory Codex";
      const task = tasks[claude === "limited" ? "test-claude" : "test-codex"];
      const when = task === undefined ? "soon" : `at ${utcMinute(limitRecheckAt(task))}`;
      blocker =
        `${name} reached its provider's usage limit, so its check could not run. Hephaestus checks again ${when}. ${typeof task?.detail.reason === "string" ? task.detail.reason : ""}`.trim();
      automatic = true;
    } else if (claude !== "signed-in" && claude !== "limited") {
      automatic = claude === "checking" && tasks["claude-sign-in"]?.status !== "running";
      blocker = automatic ? "Checking Factory Claude's sign-in." : "Sign in Factory Claude.";
    } else if (codex !== "signed-in" && codex !== "limited") {
      automatic = codex === "checking" && tasks["codex-sign-in"]?.status !== "running";
      blocker = automatic ? "Checking Factory Codex's sign-in." : "Sign in Factory Codex.";
    }
    // A sign-in waiting on the owner's token or device code is theirs even while it runs.
    const signingIn =
      tasks["claude-sign-in"]?.status === "running" || tasks["codex-sign-in"]?.status === "running";
    const ownerStep = worker.enabled && (signingIn || (blocker !== undefined && !automatic));
    return { ...worker, tasks, claude, codex, ready: blocker === undefined, blocker, ownerStep };
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
      const desired = this.desired();
      if (version.state === "deployed" && desired?.version === id) {
        // Deploying the current version again sends its saved target, even if the repo setting
        // changed, and retries applying it to the factory Hermes root.
        const hermesError = await this.syncHermes();
        await this.reconcileNow(true);
        return hermesError === undefined ? { sha: desired.sha } : { sha: desired.sha, hermesError };
      }
      await repo.ensureRemote();
      const sha = await repo.publish(id, version.document);
      // The version's state and the rollout target change together, so a crash cannot split them.
      this.db.transaction(() => {
        if (this.options.store.get(id).state === "approved") this.options.store.markDeployed(id);
        const current = this.desired();
        if (current === undefined || id >= current.version) {
          const target: DesiredDeploy = { version: id, sha, tag: repo.tagFor(id), url: repo.url };
          setMeta(this.db, DESIRED_KEY, JSON.stringify(target));
        }
      })();
      const hermesError = await this.syncHermes();
      await this.reconcileNow(true);
      return hermesError === undefined ? { sha } : { sha, hermesError };
    });
  }

  /** Applies the current version to the factory Hermes root again, after any deploy under way. */
  resyncHermes(): Promise<string | undefined> {
    return this.serialized(() => this.syncHermes());
  }

  private async syncHermes(): Promise<string | undefined> {
    try {
      await this.options.syncHermes?.();
      return undefined;
    } catch (error) {
      console.error("Applying the version to the factory Hermes root failed", error);
      return errorText(error);
    }
  }

  /** Publishing, rollouts, and reconciliation run one at a time, so none acts on a stale target. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.deploying.then(work, work);
    this.deploying = next.catch(() => undefined);
    return next;
  }

  /** Whether a deploy thread T3 is still running exists on the worker, such as one that timed out here. */
  private deployThreadRunning(environmentId: string): boolean {
    const ended = [...ENDED_STATUSES];
    return (
      this.db
        .prepare(
          `SELECT 1 FROM factory_threads WHERE environment_id = ? AND kind = 'setup' AND title = ?
           AND status NOT IN (${ended.map(() => "?").join(", ")}) LIMIT 1`,
        )
        .get(environmentId, KIND_TITLES.deploy, ...ended) !== undefined
    );
  }

  private redeployDue(worker: Worker): boolean {
    const last = this.latestTask(worker.environmentId, "deploy", "succeeded");
    return last !== undefined && this.now().getTime() - Date.parse(last.updatedAt) >= REDEPLOY_MS;
  }

  /** Starts a deploy of the desired version on one worker, at the owner's request. */
  deploy(environmentId: string): Promise<WorkerTask> {
    return this.serialized(async () => {
      const desired = this.desired();
      if (desired === undefined) throw new Error("Deploy a version from Config first.");
      const running = this.latestTask(environmentId, "deploy");
      if (running?.status === "running") return running;
      if (this.deployThreadRunning(environmentId)) {
        throw new Error(
          "An earlier deploy thread is still running on this worker; wait for it to end.",
        );
      }
      const threads = this.runningFactoryThreads(environmentId);
      if (threads > 0) {
        throw new Error(
          `${String(threads)} factory threads are running on this worker. It deploys when they finish, so they keep the version they started with.`,
        );
      }
      const task = await this.startDeploy(environmentId, desired);
      if (task === undefined) {
        throw new Error(
          "T3 lists a deploy thread still running on this worker; wait for it to end.",
        );
      }
      return task;
    });
  }

  /**
   * Starts a deploy unless T3 lists a deploy thread still running on the
   * worker, such as one whose launch reply never reached Hephaestus.
   */
  private async startDeploy(
    environmentId: string,
    desired: DesiredDeploy,
  ): Promise<WorkerTask | undefined> {
    const active = await this.options.activeThreads?.(environmentId, KIND_TITLES.deploy);
    if (active !== undefined && active.length > 0) return undefined;
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
      if (last?.status === "running" || this.deployThreadRunning(environmentId)) continue;
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
             status, created_seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
        )
        .run(
          environmentId,
          kind,
          `hephaestus-${kind}-${randomUUID()}`,
          message,
          extra.version ?? null,
          extra.sha ?? null,
          this.nextSeq(),
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
    const ends =
      fields.status !== undefined && fields.status !== "running" && task.status === "running";
    this.db
      .prepare(
        "UPDATE worker_tasks SET thread_id = ?, status = ?, detail = ?, done_seq = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        fields.threadId ?? task.threadId,
        fields.status ?? task.status,
        JSON.stringify(fields.detail ?? task.detail),
        ends ? this.nextSeq() : task.doneSeq,
        this.now().toISOString(),
        id,
      );
  }

  /** The next position in the sequence that orders tasks and checks. */
  private nextSeq(): number {
    return this.db.transaction(() => {
      const next = Number(getMeta(this.db, "worker_seq") ?? "0") + 1;
      setMeta(this.db, "worker_seq", String(next));
      return next;
    })();
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
    await this.recheckLimited();
  }

  /**
   * Records a sign-in check that hit a usage limit, which says nothing about
   * the sign-in; it runs again once the limit may have reset. A check that
   * began before a deploy or sign-in finished certifies neither, so it runs
   * again now.
   */
  private async failLimited(task: WorkerTask, limit: string): Promise<void> {
    this.update(task.id, {
      status: "failed",
      detail: {
        ...task.detail,
        reason: `the provider's usage limit: ${limit}`,
        limited: true,
        recheckAt: await this.limitReset(task),
      },
    });
    const signIn = task.kind === "test-claude" ? "claude-sign-in" : "codex-sign-in";
    const after = [
      this.latestTask(task.environmentId, "deploy", "succeeded"),
      this.latestTask(task.environmentId, signIn, "succeeded"),
    ];
    if (!certifies(task, after)) {
      await this.startOnce(task.environmentId, task.kind, testTurnMessage());
    }
  }

  /**
   * When a check that hit a usage limit runs again: just after the reset, which T3 reports
   * as the time it wakes the snoozed thread, or after LIMIT_RECHECK_MS when T3 has no time.
   */
  private async limitReset(task: WorkerTask): Promise<string> {
    const now = this.now().getTime();
    let snooze = Number.NaN;
    if (task.threadId !== null) {
      try {
        const state = await this.options.t3.threadState(task.environmentId, task.threadId);
        snooze = state.snoozedUntil === null ? Number.NaN : Date.parse(state.snoozedUntil);
      } catch (error) {
        console.error(`Reading check thread ${task.threadId} after its usage limit failed`, error);
      }
    }
    return new Date(
      Number.isFinite(snooze) && snooze > now ? snooze + LIMIT_GRACE_MS : now + LIMIT_RECHECK_MS,
    ).toISOString();
  }

  /** Runs a sign-in check again once a check that hit a usage limit is due. */
  private async recheckLimited(): Promise<void> {
    const at = this.now().getTime();
    for (const view of this.views()) {
      if (!view.enabled) continue;
      // Not over a deploy or sign-in, whose own checks follow when they finish.
      const busy = (["deploy", "claude-sign-in", "codex-sign-in"] as const).some(
        (kind) => view.tasks[kind]?.status === "running",
      );
      if (busy || this.deployThreadRunning(view.environmentId)) continue;
      for (const kind of ["test-claude", "test-codex"] as const) {
        const task = view.tasks[kind];
        if (task?.status !== "failed" || task.detail.limited !== true) continue;
        if (at < limitRecheckAt(task)) continue;
        await this.startOnce(view.environmentId, kind, testTurnMessage());
      }
    }
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
    await this.finish(task, thread.status, finalMessage(items) ?? "", usageLimit(items));
  }

  /** Records a task's outcome from its thread's final status and message. */
  async finish(task: WorkerTask, status: string, text: string, limit?: string): Promise<void> {
    const current = this.task(task.id) ?? task;
    if (current.status !== "running") return;
    const succeed = (detail: Record<string, unknown> = {}): void => {
      this.update(task.id, { status: "succeeded", detail: { ...current.detail, ...detail } });
    };
    if (status !== "completed") {
      if (limit !== undefined && (task.kind === "test-claude" || task.kind === "test-codex")) {
        await this.failLimited(current, limit);
        return;
      }
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
            "UPDATE workers SET deployed_version = ?, deployed_sha = ?, home = ?, instance_problem = NULL, checked_at = NULL, updated_at = ? WHERE environment_id = ?",
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
          // A test that began before a deploy or sign-in finished certifies neither; run a fresh one.
          const signIn = task.kind === "test-claude" ? "claude-sign-in" : "codex-sign-in";
          const after = [
            this.latestTask(task.environmentId, "deploy", "succeeded"),
            this.latestTask(task.environmentId, signIn, "succeeded"),
          ];
          if (!certifies(current, after)) {
            await this.startOnce(task.environmentId, task.kind, testTurnMessage());
          }
        } else if (limitText(text) !== undefined) {
          // Some providers report their limit as a reply in a completed thread.
          await this.failLimited(current, limitText(text) ?? "");
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
      const checks: Partial<Record<Provider, InstanceCheck>> = {};
      for (const [provider, id] of [
        ["claude", FACTORY_CLAUDE],
        ["codex", FACTORY_CODEX],
      ] as const) {
        const report = reports.find((candidate) => candidate.providerInstanceId === id);
        const constraints = report?.constraints ?? [];
        const auth = constraints.filter((text) => /authenticat|log ?in/i.test(text));
        const disabled = constraints.filter((text) => /disabled/i.test(text));
        const other = constraints.filter(
          (text) => !auth.includes(text) && !disabled.includes(text),
        );
        checks[provider] = {
          exists: report !== undefined,
          enabled: disabled.length === 0,
          authenticated: auth.length === 0,
          problem: other.length === 0 ? null : other.join(" "),
          at: at.toISOString(),
          seq: this.nextSeq(),
        };
      }
      const problem = JSON.stringify(checks);
      this.db
        .prepare("UPDATE workers SET instance_problem = ?, checked_at = ? WHERE environment_id = ?")
        .run(problem, at.toISOString(), row.environment_id);
    }
  }
}

/** Whether a test started after every task it must follow had finished. */
function certifies(test: WorkerTask, after: (WorkerTask | undefined)[]): boolean {
  return after.every((task) => task === undefined || test.createdSeq > (task.doneSeq ?? 0));
}

/** The reason a task gave for failing, or `fallback`. */
export function taskReason(task: WorkerTask | undefined, fallback = "unknown"): string {
  const reason = task?.detail.reason;
  return typeof reason === "string" ? reason : fallback;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** When a check that hit a usage limit runs again; a check recorded without a time waits LIMIT_RECHECK_MS. */
function limitRecheckAt(task: WorkerTask): number {
  const at = typeof task.detail.recheckAt === "string" ? Date.parse(task.detail.recheckAt) : NaN;
  return Number.isFinite(at) ? at : Date.parse(task.updatedAt) + LIMIT_RECHECK_MS;
}
