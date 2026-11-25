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
          lastError: null,
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
      clientRequestId: "card-7-implement-1",
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
        clientRequestId: "card-7-implement-1",
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

    await t3.send("w1", "t1", "Fix the review findings", "card-7-round-2");

    expect(fake.calls[0]?.args).toEqual({
      environmentId: "w1",
      threadId: "t1",
      message: "Fix the review findings",
      mode: "auto",
      clientRequestId: "card-7-round-2",
    });
  });
});
