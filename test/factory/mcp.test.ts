import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { FactoryMcp, ROLE_TOOLS } from "../../src/factory/mcp.js";
import { sampleConfig } from "../config/fixtures.js";
import { harness, type Harness } from "./harness.js";

const TOKENS = { planner: "planner-token", lead: "lead-token", improver: "improver-token" };

let server: Server | undefined;

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

  it("files an issue for the planner and records the call with the role", async () => {
    const { h, url, mcp } = await start();
    const c = await client(url, TOKENS.planner);
    const result = json(
      await c.callTool({
        name: "file_issue",
        arguments: { repo: "octo/app", title: "Add a flag", body: "B" },
      }),
    );
    expect(result).toMatchObject({ state: "admitted", card_id: 1 });
    expect(h.github.issues.get(result.issue as number)?.title).toBe("Add a flag");
    expect(mcp.calls()[0]).toMatchObject({ role: "planner", tool: "file_issue", ok: true });
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
    const config = json(await c.callTool({ name: "get_config", arguments: {} })).config as Record<
      string,
      unknown
    >;
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
