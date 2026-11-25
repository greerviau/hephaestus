import type { Database } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { openStore } from "../../src/store.js";
import type { LaunchOptions, T3Adapter, ThreadItem } from "../../src/t3/adapter.js";
import { ThreadEvents } from "../../src/t3/events.js";
import { FactoryThreads } from "../../src/t3/threads.js";
import type { ConfigRepo } from "../../src/workers/config-repo.js";
import { FACTORY_CLAUDE, FACTORY_CODEX, WorkerManager } from "../../src/workers/manager.js";
import { sampleConfig } from "../config/fixtures.js";

const SHA = "a".repeat(40);

class FakeT3 {
  launches: LaunchOptions[] = [];
  refuse = false;
  launchThread(
    options: LaunchOptions,
  ): Promise<{ threadId: string; runId: null; projectId: string }> {
    if (this.refuse) return Promise.reject(new Error("refused"));
    this.launches.push(options);
    return Promise.resolve({
      threadId: `t${String(this.launches.length)}`,
      runId: null,
      projectId: "p",
    });
  }
}

class FakeRepo {
  published: number[] = [];
  url = "https://github.com/octo/config.git";
  ensureRemote(): Promise<void> {
    return Promise.resolve();
  }
  publish(version: number): Promise<string> {
    this.published.push(version);
    return Promise.resolve(SHA);
  }
}

let db: Database;
let store: ConfigStore;
let events: ThreadEvents;
let t3: FakeT3;
let repo: FakeRepo;
let manager: WorkerManager;
let synced: number;

function finishThread(
  threadId: string,
  text: string,
  status = "completed",
  extra: ThreadItem[] = [],
): void {
  const launch = t3.launches[Number(threadId.slice(1)) - 1];
  if (launch === undefined) throw new Error(`no launch for ${threadId}`);
  events.upsertItems(launch.environmentId, threadId, [
    ...extra,
    { itemId: "final", position: 99, type: "assistant_message", status: "completed", text },
  ]);
  events.setStatus(launch.environmentId, threadId, status);
}

function viewOf(environmentId: string): ReturnType<WorkerManager["view"]> {
  const worker = manager.worker(environmentId);
  if (worker === undefined) throw new Error(`no worker ${environmentId}`);
  return manager.view(worker);
}

beforeEach(() => {
  db = openStore(":memory:");
  store = new ConfigStore(db);
  const first = store.createVersion({ document: sampleConfig(), author: "test", message: "first" });
  store.approve(first.id);
  events = new ThreadEvents(db);
  t3 = new FakeT3();
  repo = new FakeRepo();
  synced = 0;
  manager = new WorkerManager({
    db,
    store,
    t3: t3 as unknown as T3Adapter,
    threads: new FactoryThreads(t3 as unknown as T3Adapter, events),
    events,
    configRepo: () => repo as unknown as ConfigRepo,
    syncHermes: () => {
      synced += 1;
      return Promise.resolve();
    },
  });
  manager.setEnabled("env-1", "mark-01", true);
  manager.setEnabled("env-2", "mark-02", false);
});

describe("WorkerManager", () => {
  it("publishes an approved version, marks it deployed, syncs Hermes, and deploys to enabled workers only", async () => {
    await manager.deployVersion(1);

    expect(repo.published).toEqual([1]);
    expect(store.get(1).state).toBe("deployed");
    expect(synced).toBe(1);
    expect(t3.launches.map((launch) => launch.environmentId)).toEqual(["env-1"]);
    const launch = t3.launches[0];
    expect(launch?.providerInstanceId).toBe("claudeAgent");
    expect(launch?.message).toContain(`bash deploy.sh 1 ${SHA} https://github.com/octo/config.git`);
    expect(events.thread("env-1", "t1")?.kind).toBe("setup");
  });

  it("refuses a draft version and pushes nothing", async () => {
    const draft = store.createVersion({
      document: sampleConfig(),
      author: "t",
      message: "d",
      parentId: 1,
    });
    await expect(manager.deployVersion(draft.id)).rejects.toThrow(/draft/);
    expect(repo.published).toEqual([]);
  });

  it("records a successful deploy and starts a test turn on each factory instance", async () => {
    await manager.deployVersion(1);
    finishThread(
      "t1",
      `\`\`\`\nDEPLOYED version=1 head=${SHA} home=/home/w instances=wrote\n\`\`\``,
    );

    await manager.tick();

    expect(manager.worker("env-1")).toMatchObject({
      deployedVersion: 1,
      deployedSha: SHA,
      home: "/home/w",
    });
    expect(manager.latestTask("env-1", "deploy")?.status).toBe("succeeded");
    expect(t3.launches.slice(1).map((launch) => launch.providerInstanceId)).toEqual([
      FACTORY_CLAUDE,
      FACTORY_CODEX,
    ]);
  });

  it("fails a deploy whose reported commit is not the one published", async () => {
    await manager.deployVersion(1);
    finishThread(
      "t1",
      `DEPLOYED version=1 head=${"b".repeat(40)} home=/home/w instances=unchanged`,
    );

    await manager.tick();

    const task = manager.latestTask("env-1", "deploy");
    expect(task?.status).toBe("failed");
    expect(String(task?.detail.reason)).toMatch(/not version 1/);
    expect(manager.worker("env-1")?.deployedVersion).toBeNull();
  });

  it("fails a deploy whose thread ended without completing", async () => {
    await manager.deployVersion(1);
    finishThread("t1", "", "failed");

    await manager.tick();

    expect(manager.latestTask("env-1", "deploy")?.detail.reason).toBe("the thread ended failed");
  });

  it("makes a worker ready once it runs the deployed version and both test turns pass", async () => {
    await manager.deployVersion(1);
    expect(viewOf("env-1").blocker).toBe("A deploy is running.");
    finishThread("t1", `DEPLOYED version=1 head=${SHA} home=/home/w instances=wrote`);
    await manager.tick();
    finishThread("t2", "FACTORY-READY");
    finishThread("t3", "Not logged in");
    await manager.tick();

    const view = viewOf("env-1");
    expect(view).toMatchObject({ claude: "signed-in", codex: "signed-out", ready: false });
    expect(view.blocker).toBe("Sign in Factory Codex.");

    await manager.startCodexSignIn("env-1");
    events.upsertItems("env-1", "t4", [
      {
        itemId: "cmd",
        position: 3,
        type: "command_execution",
        status: "completed",
        text: "$ sed ...\n   https://auth.openai.com/codex/device\n   2UY4-4HUKL",
      },
    ]);
    await manager.tick();
    expect(manager.latestTask("env-1", "codex-sign-in")?.detail).toMatchObject({
      url: "https://auth.openai.com/codex/device",
      code: "2UY4-4HUKL",
    });

    finishThread("t4", "```\nCODEX-SIGNED-IN\n```");
    await manager.tick();
    expect(t3.launches.at(-1)?.providerInstanceId).toBe(FACTORY_CODEX);
    finishThread("t5", "FACTORY-READY");
    await manager.tick();

    expect(manager.readyWorkers().map((worker) => worker.environmentId)).toEqual(["env-1"]);
  });

  it("starts a Claude test turn after the token is stored, and reports a rejected token", async () => {
    await manager.startClaudeSignIn("env-1");
    finishThread("t1", "TOKEN-FAILED the pasted value is not a Claude setup token");
    await manager.tick();
    expect(manager.latestTask("env-1", "claude-sign-in")?.detail.reason).toBe(
      "the pasted value is not a Claude setup token",
    );

    await manager.startClaudeSignIn("env-1");
    finishThread("t2", "TOKEN-SET length=108");
    await manager.tick();
    expect(t3.launches.at(-1)?.providerInstanceId).toBe(FACTORY_CLAUDE);
  });

  it("does not start a second task of the same kind while one runs", async () => {
    await manager.startClaudeSignIn("env-1");
    await manager.startClaudeSignIn("env-1");
    expect(t3.launches).toHaveLength(1);
  });

  it("marks a task failed when T3 refuses the launch", async () => {
    t3.refuse = true;
    const task = await manager.startCodexSignIn("env-1");
    expect(task.status).toBe("failed");
    expect(String(task.detail.reason)).toMatch(/would not start/);
  });

  it("names the next step for a worker that has not been set up", () => {
    expect(viewOf("env-2").blocker).toBe("Not marked as a worker.");
    expect(viewOf("env-1").blocker).toBe("No config version is deployed yet.");
  });
});
