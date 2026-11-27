import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, MAX_TITLE_LENGTH } from "../../src/config/store.js";
import { chatCacheDirs } from "../../src/hermes/cache.js";
import { FactoryMcp, ROLE_TOOLS, TOOL_NAMES, roleToolsDigest } from "../../src/factory/mcp.js";
import { shippedInstructions } from "../../src/config/shipped.js";
import { sampleConfig } from "../config/fixtures.js";
import { harness, type Harness } from "./harness.js";

const TOKENS = {
  communicator: "communicator-token",
  lead: "lead-token",
  improver: "improver-token",
};

let server: Server | undefined;
/** The folder holding each role's chat cache, set by a test that attaches files. */
let caches: string | undefined;
/** The MCP server's clock, so a test can let time pass between a proposal and its approval. */
const clock = { now: Date.parse("2026-11-27T10:00:00Z") };

afterEach(async () => {
  const running = server;
  if (running) await new Promise((resolve) => running.close(resolve));
  server = undefined;
});

async function start(): Promise<{ h: Harness; url: string; store: ConfigStore; mcp: FactoryMcp }> {
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
    deploy: (id) => {
      store.markDeployed(id);
      return Promise.resolve({});
    },
    now: () => new Date(clock.now),
    tokens: () => TOKENS,
    attachmentRoots: (role) => chatCacheDirs(join(caches ?? tmpdir(), role)),
    ...(caches === undefined ? {} : { chartDir: join(caches, "charts") }),
    health: () => FAKE_HEALTH,
  });
  server = mcp.listen(0);
  await new Promise<void>((resolve) => server?.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return { h, url: `http://127.0.0.1:${String(port)}/mcp`, store, mcp };
}

const FAKE_HEALTH = {
  cpu: { cores: 4, load: { oneMinute: 0.1, fiveMinutes: 0.2, fifteenMinutes: 0.3 } },
  memory: { totalBytes: 8 * 1024 ** 3, freeBytes: 4 * 1024 ** 3, usedPercent: 50 },
  disk: null,
  uptimeSeconds: 120,
  hephaestus: { processUptimeSeconds: 60, service: "active", hermesGateway: "active" },
  workers: [],
  recentErrors: [],
  errorWindow: "24h",
};

async function client(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const result = new Client({ name: "test", version: "1" });
  await result.connect(transport);
  return result;
}

function json(result: unknown): Record<string, unknown> {
  const content = (result as { content: { text: string }[] }).content;
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("FactoryMcp", () => {
  it("rejects a call without a factory profile token", async () => {
    const { url } = await start();
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
    const wrong = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: "{}",
    });
    expect(wrong.status).toBe(401);
  });

  it("offers each role only its tools", async () => {
    const { url } = await start();
    for (const [role, token] of Object.entries(TOKENS)) {
      const c = await client(url, token);
      const names = (await c.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual([...ROLE_TOOLS[role as keyof typeof TOKENS]].sort());
      await c.close();
    }
  });

  it("names no tool, description, or parameter after a card", async () => {
    const { url } = await start();
    for (const token of Object.values(TOKENS)) {
      const c = await client(url, token);
      const { tools } = await c.listTools();
      expect(JSON.stringify(tools)).not.toMatch(/\bcards?\b|card_id|_cards\b/i);
      await c.close();
    }
    const lead = await client(url, TOKENS.lead);
    const names = (await lead.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("list_tasks");
    const status = (await lead.listTools()).tools.find((tool) => tool.name === "get_status");
    expect(Object.keys((status?.inputSchema.properties ?? {}) as object)).toEqual(["task_id"]);
    await lead.close();
  });

  it("records a call to a tool the role does not have", async () => {
    const { url, mcp } = await start();
    const c = await client(url, TOKENS.improver);
    await c
      .callTool({ name: "file_issue", arguments: { repo: "octo/app", title: "x", body: "" } })
      .catch(() => undefined);
    expect(mcp.calls()[0]).toMatchObject({ role: "improver", tool: "file_issue", ok: false });
    await c.close();
  });

  it("records a call whose arguments do not fit the tool", async () => {
    const { url, mcp } = await start();
    const c = await client(url, TOKENS.lead);
    await c.callTool({ name: "start_work", arguments: { task_id: "one" } }).catch(() => undefined);
    expect(mcp.calls()[0]).toMatchObject({ role: "lead", tool: "start_work", ok: false });
    await c.close();
  });

  it("records a call with null arguments", async () => {
    const { url, mcp } = await start();
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKENS.lead}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_status", arguments: null },
      }),
    });
    expect(mcp.calls()[0]).toMatchObject({ role: "lead", tool: "get_status", ok: false });
  });

  it("files an issue for the communicator and records the call with the role", async () => {
    const { h, url, mcp } = await start();
    const c = await client(url, TOKENS.communicator);
    const result = json(
      await c.callTool({
        name: "file_issue",
        arguments: { repo: "octo/app", title: "Add a flag", body: "B" },
      }),
    );
    expect(result).toMatchObject({
      state: "admitted",
      task_id: 1,
      tracking: `Tracking octo/app#${String(result.issue as number)}`,
    });
    expect(h.github.issues.get(result.issue as number)?.title).toBe("Add a flag");
    expect(mcp.calls()[0]).toMatchObject({ role: "communicator", tool: "file_issue", ok: true });
    await c.close();
  });

  describe("comment_issue", () => {
    it("posts a comment on an existing issue, returns its URL, and creates no task", async () => {
      const { h, url, mcp } = await start();
      const c = await client(url, TOKENS.communicator);
      const filed = json(
        await c.callTool({
          name: "file_issue",
          arguments: { repo: "octo/app", title: "Add a flag", body: "B" },
        }),
      );
      const number = filed.issue as number;
      const before = {
        tasks: h.tasks.list().length,
        awaiting: h.intake.awaitingWork("octo/app"),
        issue: { ...h.github.issues.get(number) },
        tracked: h.intake.issues(),
      };
      const result = json(
        await c.callTool({
          name: "comment_issue",
          arguments: { repo: "octo/app", issue_number: number, body: "More context." },
        }),
      );
      expect(result.url).toBe(
        `https://github.com/octo/app/issues/${String(number)}#issuecomment-1`,
      );
      expect(h.github.comments).toEqual([{ repo: "octo/app", number, body: "More context." }]);
      // Nothing else changes: no task, no cap use, no label or state change, no new record.
      expect(h.tasks.list().length).toBe(before.tasks);
      expect(h.intake.awaitingWork("octo/app")).toBe(before.awaiting);
      expect(h.github.issues.get(number)).toEqual(before.issue);
      expect(h.intake.issues()).toEqual(before.tracked);
      expect(mcp.calls()[0]).toMatchObject({
        role: "communicator",
        tool: "comment_issue",
        ok: true,
      });
      await c.close();
    });

    it("refuses a repo that is not a factory project, naming it, and posts nothing", async () => {
      const { h, url } = await start();
      h.github.issues.set(7, { number: 7, title: "t", body: "", author: "o", state: "OPEN" });
      const c = await client(url, TOKENS.communicator);
      const result = await c.callTool({
        name: "comment_issue",
        arguments: { repo: "other/thing", issue_number: 7, body: "Hi" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("other/thing is not a factory project");
      expect(h.github.comments).toEqual([]);
      await c.close();
    });

    it("refuses an issue that does not exist and posts nothing", async () => {
      const { h, url } = await start();
      const c = await client(url, TOKENS.communicator);
      const result = await c.callTool({
        name: "comment_issue",
        arguments: { repo: "octo/app", issue_number: 404, body: "Hi" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("octo/app#404 does not exist");
      expect(h.github.comments).toEqual([]);
      await c.close();
    });

    it("refuses an empty or whitespace-only body before any call to GitHub", async () => {
      const { h, url } = await start();
      h.github.issues.set(7, { number: 7, title: "t", body: "", author: "o", state: "OPEN" });
      const calls: string[] = [];
      const post = h.github.commentOnIssue.bind(h.github);
      h.github.commentOnIssue = (...args) => {
        calls.push("github");
        return post(...args);
      };
      const c = await client(url, TOKENS.communicator);
      for (const body of ["", "  \n\t "]) {
        const result = await c.callTool({
          name: "comment_issue",
          arguments: { repo: "octo/app", issue_number: 7, body },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toMatch(/body is empty/);
      }
      expect(calls).toEqual([]);
      expect(h.github.comments).toEqual([]);
      await c.close();
    });

    it("refuses a pull request's number and posts nothing", async () => {
      const { h, url } = await start();
      h.github.issues.set(8, { number: 8, title: "t", body: "", author: "o", state: "OPEN" });
      h.github.pullNumbers.add(8);
      const c = await client(url, TOKENS.communicator);
      const result = await c.callTool({
        name: "comment_issue",
        arguments: { repo: "octo/app", issue_number: 8, body: "Hi" },
      });
      expect(result.isError).toBe(true);
      expect(h.github.comments).toEqual([]);
      await c.close();
    });

    it("is offered to the communicator only", async () => {
      const { url } = await start();
      for (const [role, token] of Object.entries(TOKENS)) {
        const c = await client(url, token);
        const names = (await c.listTools()).tools.map((tool) => tool.name);
        expect(names.includes("comment_issue")).toBe(role === "communicator");
        await c.close();
      }
    });
  });

  it("files an issue with an attachment, and reports a bad attachment as an error with no issue", async () => {
    const { h, url } = await start();
    const dir = await mkdtemp(join(tmpdir(), "mcp-attach-"));
    caches = dir;
    try {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
      // An install that predates the cache folder keeps its images in the legacy one.
      await mkdir(join(dir, "communicator", "image_cache"), { recursive: true });
      const path = join(dir, "communicator", "image_cache", "banner.png");
      await writeFile(path, bytes);
      const outside = join(dir, "secret.txt");
      await writeFile(outside, "secret");
      const c = await client(url, TOKENS.communicator);
      const tool = (await c.listTools()).tools.find((candidate) => candidate.name === "file_issue");
      expect(tool?.description).toMatch(/10 files, 10 MB each/);
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain("attachments");

      const missing = await c.callTool({
        name: "file_issue",
        arguments: {
          repo: "octo/app",
          title: "x",
          body: "",
          attachments: [join(dir, "communicator", "image_cache", "nope.png")],
        },
      });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing)).toContain("nope.png");
      expect(h.github.issues.size).toBe(0);

      const refused = await c.callTool({
        name: "file_issue",
        arguments: { repo: "octo/app", title: "x", body: "", attachments: [outside] },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).toContain("not in the chat attachment cache");
      expect(h.github.issues.size).toBe(0);
      expect(h.github.stored.size).toBe(0);

      const filed = json(
        await c.callTool({
          name: "file_issue",
          arguments: { repo: "octo/app", title: "Banner", body: "B", attachments: [path] },
        }),
      );
      await rm(path);
      const body = h.github.issues.get(filed.issue as number)?.body ?? "";
      expect(body).toContain("![banner.png](https://github.com/octo/app/blob/");
      expect([...h.github.stored.values()][0]?.data.equals(bytes)).toBe(true);
      await c.close();
    } finally {
      caches = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives the communicator each task's recorded merge time, which can differ from its last update", async () => {
    const { h, url } = await start();
    const merged = h.tasks.create({ repo: "octo/app", issueNumber: 1, title: "merged" });
    h.tasks.update(merged.id, { prNumber: 7 });
    h.tasks.recordMerge("octo/app", 7, "abc123", merged.id, false);
    const open = h.tasks.create({ repo: "octo/app", issueNumber: 2, title: "open" });
    // A later change to a task that already merged moves its updated_at, not its merge time.
    h.tasks.event(merged.id, "note", "later");
    const c = await client(url, TOKENS.communicator);
    const listed = JSON.parse(
      ((await c.callTool({ name: "list_tasks", arguments: {} })) as { content: { text: string }[] })
        .content[0]?.text ?? "[]",
    ) as { task_id: number; merged_at: string | null }[];
    const status = json(
      await c.callTool({ name: "get_status", arguments: { task_id: merged.id } }),
    );

    const row = h.db.prepare("SELECT at FROM merges WHERE pr_number = 7").get() as { at: string };
    expect(listed.find((task) => task.task_id === merged.id)?.merged_at).toBe(row.at);
    expect(listed.find((task) => task.task_id === open.id)?.merged_at).toBeNull();
    expect(status.merged_at).toBe(row.at);
    await c.close();
  });

  it("queues and defers work for the lead and reports a refused call as an error", async () => {
    const { h, url, mcp } = await start();
    h.github.issues.set(5, { number: 5, title: "t", body: "b", author: "o", state: "OPEN" });
    const task = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "t" });
    const later = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "later" });
    h.pipeline.setPaused(true);
    const c = await client(url, TOKENS.lead);
    const queued = json(
      await c.callTool({ name: "queue_work", arguments: { task_id: task.id, brief: "Do it" } }),
    );
    expect(queued).toMatchObject({ stage: "Queued", queue_position: 1 });
    const before = json(
      await c.callTool({
        name: "queue_work",
        arguments: { task_id: later.id, brief: "First", before_task_id: task.id },
      }),
    );
    expect(before).toMatchObject({ stage: "Queued", queue_position: 1 });
    const deferred = json(
      await c.callTool({
        name: "defer_work",
        arguments: { task_id: later.id, reason: "after the first", after_task_id: task.id },
      }),
    );
    expect(deferred).toMatchObject({
      stage: "Admitted",
      deferred: { reason: "after the first", until_task_id: task.id },
    });
    const restart = await c.callTool({
      name: "start_work",
      arguments: { task_id: task.id, brief: "Again" },
    });
    expect(restart.isError).toBe(true);
    expect(mcp.calls()[0]).toMatchObject({ role: "lead", tool: "start_work", ok: false });
    const escalated = json(
      await c.callTool({ name: "escalate", arguments: { task_id: task.id, reason: "owner call" } }),
    );
    expect(escalated).toMatchObject({ stage: "Escalated", escalated_to: "owner" });
    await c.close();
  });

  describe("parking from chat", () => {
    /** A task the engineer had a question on, handed to the owner, as the lead's escalate leaves it. */
    async function askedOwner(h: Harness): Promise<number> {
      h.github.issues.set(5, { number: 5, title: "t", body: "b", author: "o", state: "OPEN" });
      const id = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "t" }).id;
      await h.pipeline.queue(id, "Do it");
      h.finish("t1", "", "waiting");
      await h.pipeline.tick();
      await h.pipeline.escalateToOwner(id, "Which format?");
      return id;
    }

    it("parks a task for the owner with a re-alert time, and counts it apart from escalations", async () => {
      const { h, url } = await start();
      const id = await askedOwner(h);
      const c = await client(url, TOKENS.communicator);

      const parked = json(
        await c.callTool({ name: "park_task", arguments: { task_id: id, hours: 6 } }),
      );
      expect(parked).toMatchObject({
        stage: "Parked",
        reason: "Which format?",
        deferred: { until: "2026-11-25T18:00:00.000Z" },
      });

      const status = json(await c.callTool({ name: "get_status", arguments: {} }));
      expect(status.projects).toEqual([
        expect.objectContaining({ repo: "octo/app", tasks_by_stage: { Parked: 1 } }),
      ]);
      const listed = JSON.parse(
        (
          (await c.callTool({ name: "list_tasks", arguments: { stage: "Parked" } })) as {
            content: { text: string }[];
          }
        ).content[0]?.text ?? "[]",
      ) as { task_id: number }[];
      expect(listed.map((task) => task.task_id)).toEqual([id]);
      const escalated = JSON.parse(
        (
          (await c.callTool({ name: "list_tasks", arguments: { stage: "Escalated" } })) as {
            content: { text: string }[];
          }
        ).content[0]?.text ?? "[]",
      ) as unknown[];
      expect(escalated).toEqual([]);
      const stats = json(await c.callTool({ name: "get_factory_stats", arguments: {} }));
      expect(stats.tasksByStage).toEqual({ Parked: 1 });
      await c.close();
    });

    it("unparks a task with the owner's answer, which goes on to the engineer", async () => {
      const { h, url } = await start();
      const id = await askedOwner(h);
      const c = await client(url, TOKENS.communicator);
      await c.callTool({ name: "park_task", arguments: { task_id: id } });

      const resumed = json(
        await c.callTool({ name: "unpark_task", arguments: { task_id: id, answer: "Use JSON." } }),
      );

      expect(resumed).toMatchObject({ stage: "Implementing", pr: null });
      expect(h.t3.sends.at(-1)?.message).toContain("Use JSON.");
      await c.close();
    });

    it("refuses to park a task that waits for a merge approval, with the reason", async () => {
      const { h, url, mcp } = await start();
      const id = await askedOwner(h);
      h.tasks.update(id, { ownerAction: "merge", ownerQuestion: false });
      const c = await client(url, TOKENS.communicator);

      const refused = await c.callTool({ name: "park_task", arguments: { task_id: id } });

      expect(refused.isError).toBe(true);
      expect(json(refused).error).toMatch(/cannot be parked: it waits for you to approve a merge/);
      expect(JSON.stringify(json(refused))).not.toMatch(/\b(lead|communicator|improver)\b/i);
      expect(mcp.calls()[0]).toMatchObject({ tool: "park_task", ok: false });
      expect(h.tasks.get(id).stage).toBe("Escalated");
      await c.close();
    });

    it("is offered to the communicator only", async () => {
      const { url } = await start();
      for (const [role, token] of Object.entries(TOKENS)) {
        const c = await client(url, token);
        const names = (await c.listTools()).tools.map((tool) => tool.name);
        expect(names.includes("park_task")).toBe(role === "communicator");
        expect(names.includes("unpark_task")).toBe(role === "communicator");
        await c.close();
      }
    });
  });

  it("files a proposal for the improver only with factory threads as evidence", async () => {
    const { h, url, store } = await start();
    h.events.recordThread({
      environmentId: "w1",
      threadId: "impl",
      title: "Task 1",
      providerInstanceId: "hephaestus-claude",
      model: "m",
      configVersion: 1,
      taskId: "1",
      kind: "implement",
    });
    const c = await client(url, TOKENS.improver);
    const got = json(await c.callTool({ name: "get_config", arguments: {} }));
    // The shipped role instructions come beside the config, read-only, so a proposal cannot copy them in.
    expect((got.shipped_instructions as Record<string, string>).lead).toContain("start_work");
    const config = got.config as Record<string, unknown>;
    (config.instructions as Record<string, string>).factory = "# Better\n";
    const refused = await c.callTool({
      name: "propose_version",
      arguments: {
        title: "t",
        message: "m",
        config,
        evidence: [{ environment_id: "w1", thread_id: "nope" }],
      },
    });
    expect(refused.isError).toBe(true);
    const evidence = [{ environment_id: "w1", thread_id: "impl", note: "missed X" }];
    // A proposal needs a short title beside the message that describes it.
    for (const title of [undefined, "x".repeat(MAX_TITLE_LENGTH + 1)]) {
      const untitled = await c.callTool({
        name: "propose_version",
        arguments: { ...(title === undefined ? {} : { title }), message: "m", config, evidence },
      });
      expect(untitled.isError).toBe(true);
      expect(JSON.stringify(untitled.content)).toContain("title");
    }
    expect(store.count()).toBe(1);
    const proposed = json(
      await c.callTool({
        name: "propose_version",
        arguments: {
          title: "Say X in the factory instructions",
          message: "Threads kept missing X, so the factory instructions now say it.",
          config,
          evidence: [{ environment_id: "w1", thread_id: "impl", note: "missed X" }],
        },
      }),
    );
    expect(proposed).toMatchObject({ version: 2, state: "draft", changes: 1 });
    expect(store.get(2)).toMatchObject({
      author: "improver",
      state: "draft",
      title: "Say X in the factory instructions",
      message: "Threads kept missing X, so the factory instructions now say it.",
    });
    expect(
      h.db.prepare("SELECT thread_id, note FROM version_evidence WHERE version_id = 2").all(),
    ).toEqual([{ thread_id: "impl", note: "missed X" }]);
    await c.close();
  });

  it("refuses a proposal that adds a skill nothing loads, and accepts unloaded skills it already had", async () => {
    const { h, url, store } = await start();
    h.events.recordThread({
      environmentId: "w1",
      threadId: "impl",
      title: "Task 1",
      providerInstanceId: "hephaestus-claude",
      model: "m",
      configVersion: 1,
      taskId: "1",
      kind: "implement",
    });
    const evidence = [{ environment_id: "w1", thread_id: "impl" }];
    const deployed = sampleConfig();
    // The deployed version holds a skill that nothing loads, as an owner may leave one on purpose.
    deployed.skills.idle = { "SKILL.md": "# Idle\n" };
    const base = store.createVersion({
      document: deployed,
      author: "t",
      message: "idle",
      parentId: 1,
    });
    store.approve(base.id);
    store.markDeployed(base.id);
    const c = await client(url, TOKENS.improver);
    const propose = (config: ReturnType<typeof sampleConfig>) =>
      c.callTool({
        name: "propose_version",
        arguments: { title: "t", message: "m", config, evidence },
      });

    const unloaded = structuredClone(deployed);
    unloaded.skills.debugging = { "SKILL.md": "# Debugging\n" };
    const refused = await propose(unloaded);
    expect(refused.isError).toBe(true);
    const text = JSON.stringify(refused.content);
    expect(text).toContain("debugging");
    expect(text).toContain("factory.threadSkills");
    expect(text).toContain("projects.<repo>.skills");
    expect(store.count()).toBe(2);

    const viaThreads = structuredClone(unloaded);
    viaThreads.factory.threadSkills = [...viaThreads.factory.threadSkills, "debugging"];
    expect((await propose(viaThreads)).isError).toBeFalsy();

    const viaRole = structuredClone(unloaded);
    viaRole.roles.lead.skills = ["debugging"];
    expect((await propose(viaRole)).isError).toBeFalsy();

    const viaProject = structuredClone(unloaded);
    viaProject.projects["octo/app"] = {
      policy: { preset: "standard", overrides: {} },
      skills: ["debugging"],
    };
    const loaded = await propose(viaProject);
    expect(loaded.isError).toBeFalsy();
    expect(store.list()[0]?.document.projects["octo/app"]?.skills).toEqual(["debugging"]);

    // Unloading a skill the deployed version has, or editing one already unloaded, is the owner's call.
    const unloadExisting = structuredClone(deployed);
    unloadExisting.roles.communicator.skills = [];
    expect((await propose(unloadExisting)).isError).toBeFalsy();

    const editIdle = structuredClone(deployed);
    editIdle.skills.idle = { "SKILL.md": "# Idle\nMore.\n" };
    expect((await propose(editIdle)).isError).toBeFalsy();
    expect(store.count()).toBe(7);
    await c.close();
  });

  it("lets only the chat agent change the factory's own config, through a proposal and an approval", async () => {
    const { url, store, mcp, h } = await start();
    const chat = "discord:thread-9";
    const communicator = await client(url, TOKENS.communicator);
    for (const role of ["lead", "improver"] as const) {
      const other = await client(url, TOKENS[role]);
      const names = (await other.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("propose_change");
      expect(names).not.toContain("apply_change");
      await other.close();
    }

    const read = json(
      await communicator.callTool({
        name: "read_target",
        arguments: { target: "skill:triage/SKILL.md" },
      }),
    );
    expect(read.content).toBe("# Triage\n");

    const proposed = json(
      await communicator.callTool({
        name: "propose_change",
        arguments: {
          target: "skill:triage/SKILL.md",
          content: "# Triage\nAsk for logs.\n",
          summary: "Ask for logs",
          conversation: chat,
        },
      }),
    );
    expect(proposed.diff).toContain("+Ask for logs.");
    expect(store.count()).toBe(1);

    // The call log keeps the size of the proposed text, not the text.
    const logged = mcp.calls()[0];
    expect(logged).toMatchObject({ role: "communicator", tool: "propose_change", ok: true });
    expect(logged?.arguments).toContain("<23 characters>");
    expect(logged?.arguments).not.toContain("Ask for logs.");

    clock.now += 60_000;
    const applied = json(
      await communicator.callTool({
        name: "apply_change",
        arguments: { change_id: proposed.change_id, conversation: chat, approval: "yes, apply it" },
      }),
    );
    expect(applied).toMatchObject({ state: "applied", version: 2, conversation: chat });
    expect(store.get(2).document.skills.triage?.["SKILL.md"]).toBe("# Triage\nAsk for logs.\n");

    const listed = (await communicator.callTool({
      name: "list_changes",
      arguments: {},
    })) as unknown;
    expect(JSON.stringify(listed)).toContain("Ask for logs");

    clock.now += 60_000;
    const reverted = json(
      await communicator.callTool({
        name: "revert_change",
        arguments: { change_id: proposed.change_id, conversation: chat, request: "undo that" },
      }),
    );
    expect(reverted).toMatchObject({ state: "reverted", revert_version: 3 });
    expect(store.get(3).document.skills.triage?.["SKILL.md"]).toBe("# Triage\n");
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM chat_changes").get()).toEqual({ n: 1 });
    await communicator.close();
  });

  it("refuses a disallowed target and a secret without keeping the secret", async () => {
    const { url, store, mcp } = await start();
    const communicator = await client(url, TOKENS.communicator);
    const refused = await communicator.callTool({
      name: "propose_change",
      arguments: { target: "projects:octo/app", content: "{}", summary: "s", conversation: "c" },
    });
    expect(refused.isError).toBe(true);
    const secret = "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const leaked = await communicator.callTool({
      name: "propose_change",
      arguments: {
        target: "instruction:factory",
        content: secret,
        summary: "s",
        conversation: "c",
      },
    });
    expect(leaked.isError).toBe(true);
    expect(JSON.stringify(leaked)).not.toContain("ghp_");
    expect(mcp.calls().map((call) => call.ok)).toEqual([false, false]);
    expect(JSON.stringify(mcp.calls())).not.toContain("ghp_");
    expect(store.count()).toBe(1);
    await communicator.close();
  });

  it("changes nothing for a declined proposal", async () => {
    const { url, store } = await start();
    const communicator = await client(url, TOKENS.communicator);
    const proposed = json(
      await communicator.callTool({
        name: "propose_change",
        arguments: {
          target: "persona:lead",
          content: "Be brief.",
          summary: "s",
          conversation: "c",
        },
      }),
    );
    const declined = json(
      await communicator.callTool({
        name: "decline_change",
        arguments: { change_id: proposed.change_id, conversation: "c" },
      }),
    );
    expect(declined.state).toBe("declined");
    clock.now += 60_000;
    const late = await communicator.callTool({
      name: "apply_change",
      arguments: { change_id: proposed.change_id, conversation: "c", approval: "yes" },
    });
    expect(late.isError).toBe(true);
    expect(store.count()).toBe(1);
    await communicator.close();
  });

  it("refuses a change tool to the lead and the improver, records the call, and writes nothing", async () => {
    const { url, store, mcp } = await start();
    for (const role of ["lead", "improver"] as const) {
      const c = await client(url, TOKENS[role]);
      const result = await c
        .callTool({
          name: "propose_change",
          arguments: { target: "persona:lead", content: "x", summary: "s", conversation: "c" },
        })
        .catch(() => ({ isError: true }));
      expect(result.isError).toBe(true);
      expect(mcp.calls()[0]).toMatchObject({ role, tool: "propose_change", ok: false });
      await c.close();
    }
    expect(store.count()).toBe(1);
  });

  it("gives the communicator read-only stats tools that return a report and change nothing", async () => {
    const { h, url, mcp } = await start();
    const task = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "t" });
    const before = JSON.stringify([
      h.db.prepare("SELECT * FROM tasks").all(),
      h.db.prepare("SELECT * FROM task_events").all(),
      h.db.prepare("SELECT * FROM factory_threads").all(),
      h.db.prepare("SELECT * FROM issues").all(),
    ]);
    const c = await client(url, TOKENS.communicator);

    const factory = json(
      await c.callTool({
        name: "get_factory_stats",
        arguments: { window: "30d", repo: "octo/app" },
      }),
    );
    expect(factory.tasksByStage).toEqual({ [task.stage]: 1 });
    expect(factory.report).toContain("Factory stats for octo/app, last 30d");
    expect(factory.report).toContain("Cycle time: not available");

    const usage = json(await c.callTool({ name: "get_usage_stats", arguments: {} }));
    expect(usage.report).toContain("No engineer or reviewer threads");

    const host = json(await c.callTool({ name: "get_host_health", arguments: {} }));
    expect(host.report).toContain("CPU: 4 cores");
    expect(host.report).toContain("Disk: could not be read.");

    const bad = await c.callTool({ name: "get_factory_stats", arguments: { window: "soon" } });
    expect(bad.isError).toBe(true);

    expect(mcp.calls().map((call) => [call.tool, call.ok])).toEqual([
      ["get_factory_stats", false],
      ["get_host_health", true],
      ["get_usage_stats", true],
      ["get_factory_stats", true],
    ]);
    const after = JSON.stringify([
      h.db.prepare("SELECT * FROM tasks").all(),
      h.db.prepare("SELECT * FROM task_events").all(),
      h.db.prepare("SELECT * FROM factory_threads").all(),
      h.db.prepare("SELECT * FROM issues").all(),
    ]);
    expect(after).toBe(before);
    await c.close();
  });

  it("answers a stats question in chat from real tool output, with no tables and the gaps stated", async () => {
    const { h, url, mcp } = await start();
    const done = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "Add a flag" });
    h.tasks.update(done.id, {
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      rounds: 1,
    });
    h.tasks.transition(done.id, "Queued", "the lead queued the work");
    h.tasks.transition(done.id, "Implementing", "work started");
    h.tasks.transition(done.id, "Done", "merged outside Hephaestus");
    const stuck = h.tasks.create({ repo: "octo/lib", issueNumber: 6, title: "Fix a bug" });
    h.tasks.transition(stuck.id, "Escalated", "to the owner: needs a decision on the API");
    h.events.recordThread({
      environmentId: "w1",
      threadId: "t1",
      title: "Implement",
      providerInstanceId: "i",
      model: "m1",
      configVersion: 1,
      taskId: String(done.id),
      kind: "implement",
    });

    // "How did the factory do this week?" The chat agent calls each stats tool and relays the report.
    const chat = await client(url, TOKENS.communicator);
    const reports: string[] = [];
    for (const name of ["get_factory_stats", "get_usage_stats", "get_host_health"]) {
      const result = json(await chat.callTool({ name, arguments: { window: "7d" } }));
      reports.push(String(result.report));
    }
    const reply = reports.join("\n\n");

    // Real numbers from the task log.
    expect(reply).toContain("Tasks by stage: Done 1, Escalated 1.");
    expect(reply).toContain("1 task reached Done");
    expect(reply).toContain("Task 2 (octo/lib): needs a decision on the API");
    // A thread with no recorded usage is counted, and its tokens and cost are said to be missing.
    expect(reply).toContain("Total: 1 thread, tokens not recorded, cost not recorded");
    expect(reply).not.toMatch(/\$\d/);
    expect(reply).toContain("CPU: 4 cores");
    // Chat formatting: bullets and labeled lines, no tables.
    expect(reply).not.toMatch(/\|/);
    expect(reply.split("\n").some((line) => line.startsWith("- "))).toBe(true);
    expect(mcp.calls().every((call) => call.role === "communicator" && call.ok)).toBe(true);
    await chat.close();
  });

  it("does not offer the stats tools to the lead or the improver", async () => {
    const { url } = await start();
    for (const token of [TOKENS.lead, TOKENS.improver]) {
      const c = await client(url, token);
      const names = (await c.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("get_factory_stats");
      expect(names).not.toContain("get_usage_stats");
      expect(names).not.toContain("get_host_health");
      await c.close();
    }
  });
});

describe("get_factory_chart", () => {
  const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

  afterEach(async () => {
    const dir = caches;
    caches = undefined;
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  async function startWithCharts(): Promise<{
    h: Harness;
    url: string;
    dir: string;
    mcp: FactoryMcp;
  }> {
    const dir = await mkdtemp(join(tmpdir(), "hephaestus-chart-test-"));
    caches = dir;
    const started = await start();
    return { ...started, dir: join(dir, "charts") };
  }

  it("gives the communicator a PNG of recorded merges, with the left-out tasks in the caption", async () => {
    const { h, url, dir, mcp } = await startWithCharts();
    const merged = h.tasks.create({ repo: "octo/app", issueNumber: 1, title: "a" });
    h.tasks.update(merged.id, { prNumber: 11 });
    h.tasks.recordMerge("octo/app", 11, "sha", merged.id, false);
    h.tasks.transition(merged.id, "Queued", "the lead queued the work");
    h.tasks.transition(merged.id, "Implementing", "work started");
    h.tasks.transition(merged.id, "Done", "merged");
    const bare = h.tasks.create({ repo: "octo/app", issueNumber: 2, title: "b" });
    h.tasks.transition(bare.id, "Queued", "the lead queued the work");
    h.tasks.transition(bare.id, "Implementing", "work started");
    h.tasks.transition(bare.id, "Done", "merged outside Hephaestus");

    const c = await client(url, TOKENS.communicator);
    const result = json(
      await c.callTool({
        name: "get_factory_chart",
        arguments: { metric: "merges_per_day", window: "7d", repo: "octo/app" },
      }),
    );
    expect(String(result.path).startsWith(dir)).toBe(true);
    expect(String(result.path)).toMatch(/\.png$/);
    expect(result.caption).toContain("1 merge");
    expect(result.caption).toContain("1 Done task left out because it has no recorded merge time");
    expect(result.report).toContain(`MEDIA:${String(result.path)}`);
    const file = await readFile(String(result.path));
    expect([...file.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(mcp.calls()[0]).toMatchObject({
      role: "communicator",
      tool: "get_factory_chart",
      ok: true,
    });
    await c.close();
  });

  it("returns a no-data result and writes no file when the window is empty", async () => {
    const { url, dir } = await startWithCharts();
    const c = await client(url, TOKENS.communicator);
    for (const metric of ["merges_per_day", "tasks_by_stage", "review_rounds"]) {
      const result = json(
        await c.callTool({ name: "get_factory_chart", arguments: { metric, window: "24h" } }),
      );
      expect(result.no_data).toBe(true);
      expect(result.path).toBeUndefined();
      expect(String(result.report)).toContain("No ");
      expect(String(result.report)).toContain("do not attach");
    }
    expect(await readdir(dir).catch(() => [])).toEqual([]);
    await c.close();
  });

  it("refuses a bad window or metric", async () => {
    const { url } = await startWithCharts();
    const c = await client(url, TOKENS.communicator);
    const bad = await c.callTool({
      name: "get_factory_chart",
      arguments: { metric: "merges_per_day", window: "soon" },
    });
    expect(bad.isError).toBe(true);
    const unknown = await c
      .callTool({ name: "get_factory_chart", arguments: { metric: "vibes" } })
      .catch(() => ({ isError: true }));
    expect(unknown.isError).toBe(true);
    await c.close();
  });

  it("keeps the chart folder bounded by removing the oldest charts", async () => {
    const { h, url, dir } = await startWithCharts();
    const task = h.tasks.create({ repo: "octo/app", issueNumber: 1, title: "a" });
    h.tasks.transition(task.id, "Escalated", "to the owner: x");
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 30; i++) {
      const name = join(dir, `old-${String(i).padStart(2, "0")}.png`);
      await writeFile(name, "x");
      const when = new Date(Date.now() - (60 - i) * 60_000);
      await utimes(name, when, when);
    }
    const c = await client(url, TOKENS.communicator);
    json(await c.callTool({ name: "get_factory_chart", arguments: { metric: "tasks_by_stage" } }));
    const left = await readdir(dir);
    expect(left.length).toBeLessThanOrEqual(20);
    expect(left).toContain("old-29.png");
    expect(left).not.toContain("old-00.png");
    await c.close();
  });

  it("is offered to the communicator only", async () => {
    const { url } = await startWithCharts();
    for (const token of [TOKENS.lead, TOKENS.improver]) {
      const c = await client(url, token);
      expect((await c.listTools()).tools.map((tool) => tool.name)).not.toContain(
        "get_factory_chart",
      );
      await c.close();
    }
    expect(ROLE_TOOLS.communicator).toContain("get_factory_chart");
  });
});

describe("the tools each role's instructions name", () => {
  it("are tools the server offers that role, by the name it registers", async () => {
    const { url } = await start();
    for (const [role, token] of Object.entries(TOKENS)) {
      const c = await client(url, token);
      const offered = new Set((await c.listTools()).tools.map((tool) => tool.name));
      await c.close();
      const named = [...shippedInstructions(role as keyof typeof TOKENS).matchAll(/`(\w+)`/g)]
        .map((match) => match[1] ?? "")
        .filter((name) => (TOOL_NAMES as readonly string[]).includes(name));
      expect(named.length).toBeGreaterThan(0);
      expect(named.filter((name) => !offered.has(name))).toEqual([]);
    }
  });

  it("include comment_issue for the communicator", () => {
    expect(shippedInstructions("communicator")).toContain("`comment_issue`");
  });
});

describe("roleToolsDigest", () => {
  it("changes when a role gains or loses a tool, so a running gateway is restarted", () => {
    const without = {
      ...ROLE_TOOLS,
      communicator: ROLE_TOOLS.communicator.filter((tool) => tool !== "comment_issue"),
    };
    expect(roleToolsDigest(without)).not.toBe(roleToolsDigest());
    expect(roleToolsDigest({ ...ROLE_TOOLS })).toBe(roleToolsDigest());
  });
});
