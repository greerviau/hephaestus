import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { T3Adapter } from "../../src/t3/adapter.js";
import { T3Connection } from "../../src/t3/connection.js";
import { FakeT3 } from "./fake-t3.js";

let fake: FakeT3;
let connection: T3Connection;
let t3: T3Adapter;

beforeEach(async () => {
  fake = new FakeT3();
  await fake.start();
  connection = new T3Connection(fake.url, {
    token: () => Promise.resolve("good-token"),
    renew: () => Promise.resolve(),
  });
  t3 = new T3Adapter(connection);
});

afterEach(async () => {
  await connection.close();
  await fake.stop();
});

describe("T3Adapter", () => {
  it("lists linked environments with reachability, access and link expiry", async () => {
    fake.tools.set("t3_environment_links", () => ({
      environmentId: "local",
      links: [
        {
          environmentId: "w1",
          label: "worker one",
          status: "reachable",
          access: "full-access",
          expiresAt: "2026-12-24T04:32:55.252Z",
          lastError: null,
        },
      ],
    }));

    expect(await t3.environments()).toEqual({
      localEnvironmentId: "local",
      environments: [
        {
          environmentId: "w1",
          label: "worker one",
          reachable: true,
          status: "reachable",
          access: "full-access",
          expiresAt: "2026-12-24T04:32:55.252Z",
          lastCallFailed: false,
        },
      ],
    });
  });

  it("launches a thread on an environment with a provider instance and returns its id", async () => {
    fake.tools.set("t3_thread_launch", () => ({ threadId: "t1", runId: "r1", projectId: "p1" }));

    const launched = await t3.launchThread({
      environmentId: "w1",
      projectId: "p1",
      title: "Implement #42",
      providerInstanceId: "factory-claude",
      model: "claude-sonnet-5-5",
      options: [{ id: "effort", value: "high" }],
      runtimeMode: "full-access",
      workspace: { type: "worktree", baseRef: "origin/main", branch: "factory/42" },
      message: "Brief",
      clientRequestId: "task-7-implement-1",
    });

    expect(launched).toEqual({ threadId: "t1", runId: "r1", projectId: "p1" });
    expect(fake.calls[0]).toEqual({
      name: "t3_thread_launch",
      args: {
        environmentId: "w1",
        projectId: "p1",
        title: "Implement #42",
        modelSelection: {
          instanceId: "factory-claude",
          model: "claude-sonnet-5-5",
          options: [{ id: "effort", value: "high" }],
        },
        runtimeMode: "full-access",
        workspaceStrategy: {
          type: "worktree",
          baseRef: "origin/main",
          branch: "factory/42",
          startFromOrigin: true,
        },
        message: "Brief",
        clientRequestId: "task-7-implement-1",
      },
    });
  });

  it("clones a repository and registers it as a project", async () => {
    fake.tools.set("t3_project_clone", () => ({
      cwd: "/work/app",
      remoteUrl: "https://github.com/octo/app.git",
    }));
    fake.tools.set("t3_project_create", () => ({
      id: "p9",
      title: "octo/app",
      workspaceRoot: "/work/app",
    }));

    const projectId = await t3.cloneProject("w1", "octo/app", "/work/app");

    expect(projectId).toBe("p9");
    expect(fake.calls.map((call) => [call.name, call.args])).toEqual([
      [
        "t3_project_clone",
        {
          environmentId: "w1",
          remoteUrl: "https://github.com/octo/app.git",
          destinationPath: "/work/app",
          protocol: "https",
        },
      ],
      ["t3_project_create", { environmentId: "w1", title: "octo/app", workspaceRoot: "/work/app" }],
    ]);
  });

  it("sends a message to a thread", async () => {
    fake.tools.set("t3_thread_send", () => ({ threadId: "t1", runId: "r2", status: "starting" }));

    await t3.send("w1", "t1", "Fix the review findings", "task-7-round-2");

    expect(fake.calls[0]?.args).toEqual({
      environmentId: "w1",
      threadId: "t1",
      message: "Fix the review findings",
      mode: "auto",
      clientRequestId: "task-7-round-2",
    });
  });

  it("reads a thread's status, latest run, and snooze", async () => {
    fake.tools.set("t3_thread_read", () => ({
      thread: {
        threadId: "t1",
        status: "failed",
        latestRunId: "r1",
        snoozed: true,
        snoozedUntil: "2026-11-27T16:28:00.000Z",
      },
      items: [],
      nextPosition: 0,
      hasMore: false,
    }));

    expect(await t3.threadState("w1", "t1")).toEqual({
      status: "failed",
      latestRunId: "r1",
      snoozedUntil: "2026-11-27T16:28:00.000Z",
    });
    expect(fake.calls[0]?.args).toMatchObject({ environmentId: "w1", threadId: "t1", limit: 1 });

    fake.tools.set("t3_thread_read", () => ({
      thread: { threadId: "t1", status: "running", snoozed: false, snoozedUntil: null },
      items: [],
      nextPosition: 0,
      hasMore: false,
    }));
    expect(await t3.threadState("w1", "t1")).toEqual({
      status: "running",
      latestRunId: null,
      snoozedUntil: null,
    });
  });
});

describe("T3Adapter.read", () => {
  it("fetches the rest of a truncated item before returning it", async () => {
    fake.tools.set("t3_thread_read", (args) => {
      if (args.itemId === "long") {
        return {
          thread: { status: "completed" },
          items: [
            {
              itemId: "long",
              position: 0,
              type: "assistant_message",
              status: "completed",
              text: "second half",
              textTruncated: false,
            },
          ],
          nextPosition: 0,
          hasMore: false,
        };
      }
      return {
        thread: { status: "completed" },
        items: [
          {
            itemId: "long",
            position: 0,
            type: "assistant_message",
            status: "completed",
            text: "first half, ",
            textTruncated: true,
            nextTextOffset: 12,
          },
        ],
        nextPosition: 0,
        hasMore: false,
      };
    });

    const page = await t3.read("w1", "t1", -1);

    expect(page.items[0]?.text).toBe("first half, second half");
    expect(fake.calls[1]?.args).toMatchObject({ itemId: "long", textOffset: 12 });
  });
});

describe("T3Adapter.read continuation", () => {
  it("keeps reading until T3 reports the end of the text", async () => {
    const pages = 80;
    fake.tools.set("t3_thread_read", (args) => {
      const offset = typeof args.textOffset === "number" ? args.textOffset : 0;
      const page = offset / 10;
      return {
        thread: { status: "completed" },
        items: [
          {
            itemId: "long",
            position: 0,
            type: "assistant_message",
            status: "completed",
            text: "x".repeat(10),
            textTruncated: page < pages - 1,
            nextTextOffset: page < pages - 1 ? offset + 10 : null,
          },
        ],
        nextPosition: 0,
        hasMore: false,
      };
    });

    const page = await t3.read("w1", "t1", -1);

    expect(page.items[0]?.text).toHaveLength(pages * 10);
  });
});
