import type { Database } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { openStore } from "../../src/store.js";
import type { LaunchOptions, T3Adapter } from "../../src/t3/adapter.js";
import { T3ToolError } from "../../src/t3/connection.js";
import { ThreadEvents } from "../../src/t3/events.js";
import { FactoryThreads } from "../../src/t3/threads.js";
import type { ConfigRepo } from "../../src/workers/config-repo.js";
import {
  FACTORY_CLAUDE,
  FACTORY_CODEX,
  WorkerManager,
  type InstanceReport,
} from "../../src/workers/manager.js";
import { sampleConfig } from "../config/fixtures.js";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

class FakeT3 {
  launches: LaunchOptions[] = [];
  refuse = false;
  hang = false;
  launchThread(
    options: LaunchOptions,
  ): Promise<{ threadId: string; runId: null; projectId: string }> {
    if (this.refuse) {
      return Promise.reject(new T3ToolError("t3_thread_launch", "invalid_request", "refused"));
    }
    if (this.hang) return Promise.reject(new Error("socket hang up"));
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
  shas = [SHA, SHA2];
  ensureRemote(): Promise<void> {
    return Promise.resolve();
  }
  tagFor(version: number): string {
    return `p-v${String(version)}`;
  }
  publish(version: number): Promise<string> {
    this.published.push(version);
    return Promise.resolve(this.shas[version - 1] ?? SHA);
  }
}

let db: Database;
let store: ConfigStore;
let events: ThreadEvents;
let t3: FakeT3;
let repo: FakeRepo;
let manager: WorkerManager;
let synced: number;
let clock: number;
let reports: InstanceReport[] | undefined;
let active: string[];

function finishThread(threadId: string, text: string, status = "completed"): void {
  const launch = t3.launches[Number(threadId.slice(1)) - 1];
  if (launch === undefined) throw new Error(`no launch for ${threadId}`);
  events.upsertItems(launch.environmentId, threadId, [
    {
      itemId: `final-${threadId}`,
      position: 99,
      type: "assistant_message",
      status: "completed",
      text,
    },
  ]);
  events.setStatus(launch.environmentId, threadId, status);
}

function deployed(version: number, sha: string): string {
  return `DEPLOYED version=${String(version)} head=${sha} home=/home/w instances=wrote`;
}

function viewOf(environmentId: string): ReturnType<WorkerManager["view"]> {
  const worker = manager.worker(environmentId);
  if (worker === undefined) throw new Error(`no worker ${environmentId}`);
  return manager.view(worker);
}

/** Deploys version 1 to env-1 and passes both test turns. */
async function makeReady(): Promise<void> {
  await manager.deployVersion(1);
  finishThread("t1", deployed(1, SHA));
  await manager.tick();
  finishThread("t2", "FACTORY-READY");
  finishThread("t3", "FACTORY-READY");
  await manager.tick();
}

beforeEach(() => {
  clock = Date.parse("2026-11-25T12:00:00Z");
  const now = (): Date => new Date(clock);
  db = openStore(":memory:");
  store = new ConfigStore(db, now);
  const first = store.createVersion({ document: sampleConfig(), author: "test", message: "first" });
  store.approve(first.id);
  events = new ThreadEvents(db, now);
  t3 = new FakeT3();
  repo = new FakeRepo();
  synced = 0;
  reports = undefined;
  active = [];
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
    instances: () => Promise.resolve(reports),
    activeThreads: () => Promise.resolve(active),
    now,
  });
  manager.setEnabled("env-1", "mark-01", true);
  manager.setEnabled("env-2", "mark-02", false);
});

describe("WorkerManager", () => {
  it("publishes an approved version, marks it deployed, syncs Hermes, and deploys to enabled workers only", async () => {
    await manager.deployVersion(1);

    expect(repo.published).toEqual([1]);
    expect(store.get(1).state).toBe("deployed");
    expect(manager.desired()).toEqual({
      version: 1,
      sha: SHA,
      tag: "p-v1",
      url: "https://github.com/octo/config.git",
    });
    expect(synced).toBe(1);
    expect(t3.launches.map((launch) => launch.environmentId)).toEqual(["env-1"]);
    expect(t3.launches[0]?.providerInstanceId).toBe("claudeAgent");
    expect(t3.launches[0]?.message).toContain(
      `bash deploy.sh 1 ${SHA} https://github.com/octo/config.git p-v1`,
    );
    expect(events.thread("env-1", "t1")?.kind).toBe("setup");
  });

  it("tells a usage limit from a lost sign-in, and checks again once the limit may have reset", async () => {
    await manager.deployVersion(1);
    finishThread("t1", deployed(1, SHA));
    await manager.tick();
    finishThread("t2", "FACTORY-READY");
    // The Codex check ends on the provider's usage limit, with no reply.
    events.upsertItems("env-1", "t3", [
      {
        itemId: "limit",
        position: 5,
        type: "error",
        status: "failed",
        text: "You've hit your usage limit. Try again at 8:02 AM.",
      },
    ]);
    events.setStatus("env-1", "t3", "failed");
    await manager.tick();
    const view = viewOf("env-1");
    expect(view).toMatchObject({
      claude: "signed-in",
      codex: "limited",
      ready: false,
      ownerStep: false,
    });
    expect(view.blocker).toMatch(/Factory Codex reached its provider's usage limit/);
    expect(view.blocker).toMatch(/Try again at 8:02 AM/);

    // Before 30 minutes nothing reruns; after them the check runs again.
    const launches = t3.launches.length;
    await manager.tick();
    expect(t3.launches).toHaveLength(launches);
    clock += 31 * 60_000;
    await manager.tick();
    expect(t3.launches).toHaveLength(launches + 1);
    expect(t3.launches.at(-1)?.providerInstanceId).toBe(FACTORY_CODEX);
    finishThread(`t${String(launches + 1)}`, "FACTORY-READY");
    await manager.tick();
    expect(viewOf("env-1")).toMatchObject({ codex: "signed-in", ready: true });
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

  it("makes a worker ready once it runs the desired version and both test turns pass", async () => {
    await manager.deployVersion(1);
    expect(viewOf("env-1").blocker).toBe("A deploy is running.");
    finishThread("t1", deployed(1, SHA));
    await manager.tick();
    expect(t3.launches.slice(1).map((launch) => launch.providerInstanceId)).toEqual([
      FACTORY_CLAUDE,
      FACTORY_CODEX,
    ]);
    finishThread("t2", "FACTORY-READY");
    finishThread("t3", "Not logged in");
    await manager.tick();
    expect(viewOf("env-1")).toMatchObject({
      claude: "signed-in",
      codex: "signed-out",
      ready: false,
    });
    expect(viewOf("env-1").blocker).toBe("Sign in Factory Codex.");

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
    finishThread("t5", "FACTORY-READY");
    await manager.tick();

    expect(manager.readyWorkers().map((worker) => worker.environmentId)).toEqual(["env-1"]);
  });

  it("fails a deploy whose reported commit is not the one published", async () => {
    await manager.deployVersion(1);
    finishThread("t1", deployed(1, SHA2));
    await manager.tick();

    expect(String(manager.latestTask("env-1", "deploy")?.detail.reason)).toMatch(/not version 1/);
    expect(manager.worker("env-1")?.deployedVersion).toBeNull();
  });

  it("is not ready after a failed redeploy of the version it already runs", async () => {
    await makeReady();
    expect(viewOf("env-1").ready).toBe(true);

    await manager.deploy("env-1");
    finishThread("t4", "DEPLOY-FAILED tag p-v1 is x, expected y");
    await manager.tick();

    expect(viewOf("env-1")).toMatchObject({ ready: false });
    expect(viewOf("env-1").blocker).toMatch(/last deploy failed: tag p-v1/);
  });

  it("rolls a newer version out after the worker's running deploy ends", async () => {
    await manager.deployVersion(1);
    const second = store.createVersion({
      document: sampleConfig(),
      author: "t",
      message: "two",
      parentId: 1,
    });
    store.approve(second.id);
    await manager.deployVersion(second.id);
    expect(t3.launches).toHaveLength(1);
    expect(manager.desired()?.version).toBe(2);

    finishThread("t1", deployed(1, SHA));
    await manager.tick();

    const deploys = t3.launches.filter((launch) => launch.title === "Hephaestus: deploy config");
    expect(deploys.at(-1)?.message).toContain(`bash deploy.sh 2 ${SHA2}`);
    expect(viewOf("env-1").blocker).toBe("A deploy is running.");
  });

  it("waits for a worker's factory threads to finish before deploying to it", async () => {
    await makeReady();
    events.recordThread({
      environmentId: "env-1",
      threadId: "work",
      title: "Implement",
      providerInstanceId: FACTORY_CLAUDE,
      model: "m",
      configVersion: 1,
      cardId: "1",
      kind: "implement",
    });
    const second = store.createVersion({
      document: sampleConfig(),
      author: "t",
      message: "two",
      parentId: 1,
    });
    store.approve(second.id);
    const launches = t3.launches.length;

    await manager.deployVersion(second.id);
    expect(t3.launches).toHaveLength(launches);
    expect(viewOf("env-1").blocker).toMatch(/Waiting for running factory threads/);
    await expect(manager.deploy("env-1")).rejects.toThrow(/1 factory threads are running/);

    events.setStatus("env-1", "work", "completed");
    await manager.tick();
    expect(t3.launches.at(-1)?.message).toContain(`bash deploy.sh 2 ${SHA2}`);
  });

  it("retries a failed deploy after a pause", async () => {
    await manager.deployVersion(1);
    finishThread("t1", "DEPLOY-FAILED network");
    await manager.tick();
    expect(t3.launches).toHaveLength(1);

    clock += 31 * 60_000;
    await manager.tick();
    expect(t3.launches).toHaveLength(2);
  });

  it("replays a lost launch with the same request id, and gives up after three tries", async () => {
    await manager.deployVersion(1);
    t3.hang = true;
    const task = await manager.startClaudeSignIn("env-1");
    expect(task).toMatchObject({ status: "running", threadId: null });
    clock += 3 * 60_000;
    t3.hang = false;
    await manager.tick();
    expect(t3.launches.at(-1)?.clientRequestId).toBe(task.clientRequestId);
    expect(manager.task(task.id)?.threadId).toBe(`t${String(t3.launches.length)}`);

    t3.hang = true;
    const other = await manager.startCodexSignIn("env-1");
    for (let i = 0; i < 3; i++) {
      clock += 3 * 60_000;
      await manager.tick();
    }
    expect(manager.task(other.id)).toMatchObject({ status: "failed" });
    expect(String(manager.task(other.id)?.detail.reason)).toMatch(/did not answer/);
  });

  it("counts a factory launch T3 has not answered as a running thread", () => {
    events.recordLaunch("x", {
      environmentId: "env-1",
      title: "Implement",
      providerInstanceId: FACTORY_CLAUDE,
      model: "m",
      configVersion: 1,
      cardId: "1",
      kind: "implement",
    });
    expect(manager.runningFactoryThreads("env-1")).toBe(1);
  });

  it("does not accept a test turn that started before the latest sign-in", async () => {
    await makeReady();
    expect(viewOf("env-1").claude).toBe("signed-in");
    await manager.startClaudeSignIn("env-1");
    finishThread("t4", "TOKEN-SET length=108");
    await manager.tick();
    expect(viewOf("env-1").claude).toBe("checking");
    finishThread("t5", "FACTORY-READY");
    await manager.tick();
    expect(viewOf("env-1").claude).toBe("signed-in");
  });

  it("asks for the periodic redeploy, and blocks new threads until it ran", async () => {
    await makeReady();
    events.recordThread({
      environmentId: "env-1",
      threadId: "busy",
      title: "Implement",
      providerInstanceId: FACTORY_CLAUDE,
      model: "m",
      configVersion: 1,
      cardId: "1",
      kind: "implement",
    });
    clock += 7 * 60 * 60_000;
    expect(viewOf("env-1").blocker).toMatch(/periodic redeploy/);
  });

  it("times out a task whose thread never ends", async () => {
    const task = await manager.startCodexSignIn("env-1");
    clock += 31 * 60_000;
    await manager.tick();
    expect(manager.task(task.id)?.status).toBe("failed");
  });

  it("marks a task failed when T3 refuses the launch", async () => {
    await manager.deployVersion(1);
    t3.refuse = true;
    const task = await manager.startCodexSignIn("env-1");
    expect(task.status).toBe("failed");
    expect(String(task.detail.reason)).toMatch(/would not start/);
  });

  it("starts a Claude test turn after the token is stored, and reports a rejected token", async () => {
    await manager.deployVersion(1);
    await manager.startClaudeSignIn("env-1");
    finishThread("t2", "TOKEN-FAILED the pasted value is not a Claude setup token");
    await manager.tick();
    expect(manager.latestTask("env-1", "claude-sign-in")?.detail.reason).toBe(
      "the pasted value is not a Claude setup token",
    );

    await manager.startClaudeSignIn("env-1");
    finishThread("t3", "TOKEN-SET length=108");
    await manager.tick();
    expect(t3.launches.at(-1)?.providerInstanceId).toBe(FACTORY_CLAUDE);
  });

  it("does not start a second task of the same kind while one runs", async () => {
    await manager.deployVersion(1);
    await manager.startClaudeSignIn("env-1");
    await manager.startClaudeSignIn("env-1");
    expect(t3.launches).toHaveLength(2);
  });

  it("is not ready when T3 reports a factory instance missing, disabled, or signed out", async () => {
    await makeReady();
    reports = [
      { providerInstanceId: FACTORY_CLAUDE, constraints: [] },
      { providerInstanceId: FACTORY_CODEX, constraints: ["Provider instance is disabled."] },
    ];
    clock += 11 * 60_000;
    await manager.tick();
    expect(viewOf("env-1")).toMatchObject({ claude: "signed-in", codex: "disabled" });
    expect(viewOf("env-1").blocker).toBe("Factory Codex is disabled on this worker; deploy again.");

    reports = [];
    clock += 11 * 60_000;
    await manager.tick();
    expect(viewOf("env-1")).toMatchObject({ claude: "missing", codex: "missing" });

    // A T3 that stops offering the list keeps the last finding.
    reports = undefined;
    clock += 11 * 60_000;
    await manager.tick();
    expect(viewOf("env-1").codex).toBe("missing");

    reports = [
      { providerInstanceId: FACTORY_CLAUDE, constraints: ["Provider is not authenticated."] },
      { providerInstanceId: FACTORY_CODEX, constraints: [] },
    ];
    clock += 11 * 60_000;
    await manager.tick();
    expect(viewOf("env-1")).toMatchObject({
      claude: "signed-out",
      codex: "signed-in",
      ready: false,
    });
  });

  it("does not accept a test that started before the new token was stored", async () => {
    await makeReady();
    await manager.startClaudeSignIn("env-1");
    clock += 1000;
    // A manual check starts while the sign-in waits for the token.
    db.prepare("UPDATE worker_tasks SET status = 'succeeded' WHERE kind = 'test-claude'").run();
    await manager.startTests("env-1");
    clock += 1000;
    finishThread("t4", "TOKEN-SET length=108");
    finishThread("t5", "FACTORY-READY");
    await manager.tick();
    expect(viewOf("env-1").claude).not.toBe("signed-in");
  });

  it("orders a test against a sign-in that finished in the same millisecond", async () => {
    await makeReady();
    await manager.startClaudeSignIn("env-1");
    db.prepare("UPDATE worker_tasks SET status = 'succeeded' WHERE kind = 'test-claude'").run();
    await manager.startTests("env-1");
    // The token is stored after the manual test began, at the same clock reading.
    finishThread("t4", "TOKEN-SET length=108");
    finishThread("t5", "FACTORY-READY");
    await manager.tick();
    expect(viewOf("env-1").claude).toBe("checking");
    const fresh = t3.launches.at(-1);
    expect(fresh?.providerInstanceId).toBe(FACTORY_CLAUDE);
    finishThread(`t${String(t3.launches.length)}`, "FACTORY-READY");
    await manager.tick();
    expect(viewOf("env-1").claude).toBe("signed-in");
  });

  it("starts no deploy while T3 lists a deploy thread still running there", async () => {
    active = ["lost-reply-thread"];
    await manager.deployVersion(1);
    expect(t3.launches).toHaveLength(0);
    await expect(manager.deploy("env-1")).rejects.toThrow(/still running/);
    active = [];
    await manager.tick();
    expect(t3.launches).toHaveLength(1);
  });

  it("deploys the current version again from its saved target without publishing", async () => {
    await manager.deployVersion(1);
    finishThread("t1", "DEPLOY-FAILED network");
    await manager.tick();
    await manager.deployVersion(1);
    expect(repo.published).toEqual([1]);
    expect(t3.launches.at(-1)?.message).toContain(`bash deploy.sh 1 ${SHA}`);
  });

  it("holds new deploys while an earlier deploy thread still runs on T3", async () => {
    await manager.deployVersion(1);
    clock += 31 * 60_000;
    await manager.tick();
    expect(manager.latestTask("env-1", "deploy")?.status).toBe("failed");
    expect(viewOf("env-1").blocker).toMatch(/earlier deploy thread is still running/);
    clock += 31 * 60_000;
    await manager.tick();
    expect(t3.launches).toHaveLength(1);
    await expect(manager.deploy("env-1")).rejects.toThrow(/still running/);

    events.setStatus("env-1", "t1", "completed");
    await manager.tick();
    expect(t3.launches).toHaveLength(2);
  });

  it("accepts a cleanup only when the thread completed and reported removal", async () => {
    const task = await manager.startCleanup("env-1");
    await manager.finish(task, "failed", "CLEANED instances=none hephaestus=removed");
    expect(manager.task(task.id)?.status).toBe("failed");

    const again = await manager.startCleanup("env-1");
    await manager.finish(again, "completed", "CLEANUP-FAILED ~/.hephaestus could not be removed");
    expect(manager.task(again.id)?.detail.reason).toBe("~/.hephaestus could not be removed");

    const third = await manager.startCleanup("env-1");
    await manager.finish(
      third,
      "completed",
      "CLEANED instances=hephaestus-claude hephaestus=removed",
    );
    expect(manager.task(third.id)?.status).toBe("succeeded");
  });

  it("says whether the worker's next step is the owner's", async () => {
    expect(viewOf("env-2").ownerStep).toBe(false);
    expect(viewOf("env-1").ownerStep).toBe(true);
    await manager.deployVersion(1);
    expect(viewOf("env-1")).toMatchObject({ blocker: "A deploy is running.", ownerStep: false });
    finishThread("t1", deployed(1, SHA));
    await manager.tick();
    finishThread("t2", "Not logged in");
    finishThread("t3", "FACTORY-READY");
    await manager.tick();
    expect(viewOf("env-1")).toMatchObject({ blocker: "Sign in Factory Claude.", ownerStep: true });
  });

  it("names the next step for a worker that has not been set up", () => {
    expect(viewOf("env-2").blocker).toBe("Not marked as a worker.");
    expect(viewOf("env-1").blocker).toBe("No config version is deployed yet.");
  });
});
