import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { chatCacheDirs } from "../../src/hermes/cache.js";
import { FactoryMcp, ROLE_TOOLS } from "../../src/factory/mcp.js";
import { sampleConfig } from "../config/fixtures.js";
import { harness, type Harness } from "./harness.js";

const TOKENS = { planner: "planner-token", lead: "lead-token", improver: "improver-token" };

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
    cards: h.cards,
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
    await c.callTool({ name: "start_work", arguments: { card_id: "one" } }).catch(() => undefined);
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

  it("files an issue for the planner and records the call with the role", async () => {
    const { h, url, mcp } = await start();
    const c = await client(url, TOKENS.planner);
    const result = json(
      await c.callTool({
        name: "file_issue",
        arguments: { repo: "octo/app", title: "Add a flag", body: "B" },
      }),
    );
    expect(result).toMatchObject({
      state: "admitted",
      card_id: 1,
      tracking: `Tracking octo/app#${String(result.issue as number)}`,
    });
    expect(h.github.issues.get(result.issue as number)?.title).toBe("Add a flag");
    expect(mcp.calls()[0]).toMatchObject({ role: "planner", tool: "file_issue", ok: true });
    await c.close();
  });

  it("files an issue with an attachment, and reports a bad attachment as an error with no issue", async () => {
    const { h, url } = await start();
    const dir = await mkdtemp(join(tmpdir(), "mcp-attach-"));
    caches = dir;
    try {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
      // An install that predates the cache folder keeps its images in the legacy one.
      await mkdir(join(dir, "planner", "image_cache"), { recursive: true });
      const path = join(dir, "planner", "image_cache", "banner.png");
      await writeFile(path, bytes);
      const outside = join(dir, "secret.txt");
      await writeFile(outside, "secret");
      const c = await client(url, TOKENS.planner);
      const tool = (await c.listTools()).tools.find((candidate) => candidate.name === "file_issue");
      expect(tool?.description).toMatch(/10 files, 10 MB each/);
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain("attachments");

      const missing = await c.callTool({
        name: "file_issue",
        arguments: {
          repo: "octo/app",
          title: "x",
          body: "",
          attachments: [join(dir, "planner", "image_cache", "nope.png")],
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

  it("gives the planner each card's recorded merge time, which can differ from its last update", async () => {
    const { h, url } = await start();
    const merged = h.cards.create({ repo: "octo/app", issueNumber: 1, title: "merged" });
    h.cards.update(merged.id, { prNumber: 7 });
    h.cards.recordMerge("octo/app", 7, "abc123", merged.id, false);
    const open = h.cards.create({ repo: "octo/app", issueNumber: 2, title: "open" });
    // A later change to a card that already merged moves its updated_at, not its merge time.
    h.cards.event(merged.id, "note", "later");
    const c = await client(url, TOKENS.planner);
    const listed = JSON.parse(
      ((await c.callTool({ name: "list_cards", arguments: {} })) as { content: { text: string }[] })
        .content[0]?.text ?? "[]",
    ) as { card_id: number; merged_at: string | null }[];
    const status = json(
      await c.callTool({ name: "get_status", arguments: { card_id: merged.id } }),
    );

    const row = h.db.prepare("SELECT at FROM merges WHERE pr_number = 7").get() as { at: string };
    expect(listed.find((card) => card.card_id === merged.id)?.merged_at).toBe(row.at);
    expect(listed.find((card) => card.card_id === open.id)?.merged_at).toBeNull();
    expect(status.merged_at).toBe(row.at);
    await c.close();
  });

  it("starts work for the lead and reports a refused call as an error", async () => {
    const { h, url, mcp } = await start();
    h.github.issues.set(5, { number: 5, title: "t", body: "b", author: "o", state: "OPEN" });
    const card = h.cards.create({ repo: "octo/app", issueNumber: 5, title: "t" });
    const c = await client(url, TOKENS.lead);
    const started = json(
      await c.callTool({ name: "start_work", arguments: { card_id: card.id, brief: "Do it" } }),
    );
    expect(started).toMatchObject({ stage: "Implementing" });
    const again = await c.callTool({
      name: "start_work",
      arguments: { card_id: card.id, brief: "Again" },
    });
    expect(again.isError).toBe(true);
    expect(mcp.calls()[0]).toMatchObject({ role: "lead", tool: "start_work", ok: false });
    const escalated = json(
      await c.callTool({ name: "escalate", arguments: { card_id: card.id, reason: "owner call" } }),
    );
    expect(escalated).toMatchObject({ stage: "Escalated", escalated_to: "owner" });
    await c.close();
  });

  it("files a proposal for the improver only with factory threads as evidence", async () => {
    const { h, url, store } = await start();
    h.events.recordThread({
      environmentId: "w1",
      threadId: "impl",
      title: "Card 1",
      providerInstanceId: "hephaestus-claude",
      model: "m",
      configVersion: 1,
      cardId: "1",
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
      arguments: { message: "m", config, evidence: [{ environment_id: "w1", thread_id: "nope" }] },
    });
    expect(refused.isError).toBe(true);
    const proposed = json(
      await c.callTool({
        name: "propose_version",
        arguments: {
          message: "Say X",
          config,
          evidence: [{ environment_id: "w1", thread_id: "impl", note: "missed X" }],
        },
      }),
    );
    expect(proposed).toMatchObject({ version: 2, state: "draft", changes: 1 });
    expect(store.get(2)).toMatchObject({ author: "improver", state: "draft" });
    expect(
      h.db.prepare("SELECT thread_id, note FROM version_evidence WHERE version_id = 2").all(),
    ).toEqual([{ thread_id: "impl", note: "missed X" }]);
    await c.close();
  });

  it("lets only the chat agent change the factory's own config, through a proposal and an approval", async () => {
    const { url, store, mcp, h } = await start();
    const chat = "discord:thread-9";
    const planner = await client(url, TOKENS.planner);
    for (const role of ["lead", "improver"] as const) {
      const other = await client(url, TOKENS[role]);
      const names = (await other.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("propose_change");
      expect(names).not.toContain("apply_change");
      await other.close();
    }

    const read = json(
      await planner.callTool({
        name: "read_target",
        arguments: { target: "skill:triage/SKILL.md" },
      }),
    );
    expect(read.content).toBe("# Triage\n");

    const proposed = json(
      await planner.callTool({
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
    expect(logged).toMatchObject({ role: "planner", tool: "propose_change", ok: true });
    expect(logged?.arguments).toContain("<23 characters>");
    expect(logged?.arguments).not.toContain("Ask for logs.");

    clock.now += 60_000;
    const applied = json(
      await planner.callTool({
        name: "apply_change",
        arguments: { change_id: proposed.change_id, conversation: chat, approval: "yes, apply it" },
      }),
    );
    expect(applied).toMatchObject({ state: "applied", version: 2, conversation: chat });
    expect(store.get(2).document.skills.triage?.["SKILL.md"]).toBe("# Triage\nAsk for logs.\n");

    const listed = (await planner.callTool({ name: "list_changes", arguments: {} })) as unknown;
    expect(JSON.stringify(listed)).toContain("Ask for logs");

    clock.now += 60_000;
    const reverted = json(
      await planner.callTool({
        name: "revert_change",
        arguments: { change_id: proposed.change_id, conversation: chat, request: "undo that" },
      }),
    );
    expect(reverted).toMatchObject({ state: "reverted", revert_version: 3 });
    expect(store.get(3).document.skills.triage?.["SKILL.md"]).toBe("# Triage\n");
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM chat_changes").get()).toEqual({ n: 1 });
    await planner.close();
  });

  it("refuses a disallowed target and a secret without keeping the secret", async () => {
    const { url, store, mcp } = await start();
    const planner = await client(url, TOKENS.planner);
    const refused = await planner.callTool({
      name: "propose_change",
      arguments: { target: "projects:octo/app", content: "{}", summary: "s", conversation: "c" },
    });
    expect(refused.isError).toBe(true);
    const secret = "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const leaked = await planner.callTool({
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
    await planner.close();
  });

  it("changes nothing for a declined proposal", async () => {
    const { url, store } = await start();
    const planner = await client(url, TOKENS.planner);
    const proposed = json(
      await planner.callTool({
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
      await planner.callTool({
        name: "decline_change",
        arguments: { change_id: proposed.change_id, conversation: "c" },
      }),
    );
    expect(declined.state).toBe("declined");
    clock.now += 60_000;
    const late = await planner.callTool({
      name: "apply_change",
      arguments: { change_id: proposed.change_id, conversation: "c", approval: "yes" },
    });
    expect(late.isError).toBe(true);
    expect(store.count()).toBe(1);
    await planner.close();
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

  it("gives the planner read-only stats tools that return a report and change nothing", async () => {
    const { h, url, mcp } = await start();
    const card = h.cards.create({ repo: "octo/app", issueNumber: 5, title: "t" });
    const before = JSON.stringify([
      h.db.prepare("SELECT * FROM cards").all(),
      h.db.prepare("SELECT * FROM card_events").all(),
      h.db.prepare("SELECT * FROM factory_threads").all(),
      h.db.prepare("SELECT * FROM issues").all(),
    ]);
    const c = await client(url, TOKENS.planner);

    const factory = json(
      await c.callTool({
        name: "get_factory_stats",
        arguments: { window: "30d", repo: "octo/app" },
      }),
    );
    expect(factory.cardsByStage).toEqual({ [card.stage]: 1 });
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
      h.db.prepare("SELECT * FROM cards").all(),
      h.db.prepare("SELECT * FROM card_events").all(),
      h.db.prepare("SELECT * FROM factory_threads").all(),
      h.db.prepare("SELECT * FROM issues").all(),
    ]);
    expect(after).toBe(before);
    await c.close();
  });

  it("answers a stats question in chat from real tool output, with no tables and the gaps stated", async () => {
    const { h, url, mcp } = await start();
    const done = h.cards.create({ repo: "octo/app", issueNumber: 5, title: "Add a flag" });
    h.cards.update(done.id, {
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      rounds: 1,
    });
    h.cards.transition(done.id, "Implementing", "work started");
    h.cards.transition(done.id, "Done", "merged outside Hephaestus");
    const stuck = h.cards.create({ repo: "octo/lib", issueNumber: 6, title: "Fix a bug" });
    h.cards.transition(stuck.id, "Escalated", "to the owner: needs a decision on the API");
    h.events.recordThread({
      environmentId: "w1",
      threadId: "t1",
      title: "Implement",
      providerInstanceId: "i",
      model: "m1",
      configVersion: 1,
      cardId: String(done.id),
      kind: "implement",
    });

    // "How did the factory do this week?" The chat agent calls each stats tool and relays the report.
    const chat = await client(url, TOKENS.planner);
    const reports: string[] = [];
    for (const name of ["get_factory_stats", "get_usage_stats", "get_host_health"]) {
      const result = json(await chat.callTool({ name, arguments: { window: "7d" } }));
      reports.push(String(result.report));
    }
    const reply = reports.join("\n\n");

    // Real numbers from the card log.
    expect(reply).toContain("Cards by stage: Done 1, Escalated 1.");
    expect(reply).toContain("1 card reached Done");
    expect(reply).toContain("Card 2 (octo/lib): needs a decision on the API");
    // A thread with no recorded usage is counted, and its tokens and cost are said to be missing.
    expect(reply).toContain("Total: 1 thread, tokens not recorded, cost not recorded");
    expect(reply).not.toMatch(/\$\d/);
    expect(reply).toContain("CPU: 4 cores");
    // Chat formatting: bullets and labeled lines, no tables.
    expect(reply).not.toMatch(/\|/);
    expect(reply.split("\n").some((line) => line.startsWith("- "))).toBe(true);
    expect(mcp.calls().every((call) => call.role === "planner" && call.ok)).toBe(true);
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
