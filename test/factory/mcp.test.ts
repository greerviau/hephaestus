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
    tokens: () => TOKENS,
    attachmentRoots: (role) => chatCacheDirs(join(caches ?? tmpdir(), role)),
  });
  server = mcp.listen(0);
  await new Promise<void>((resolve) => server?.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return { h, url: `http://127.0.0.1:${String(port)}/mcp`, store, mcp };
}

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
});
