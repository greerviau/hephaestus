import { trackingLine } from "../request-threads.js";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Database } from "better-sqlite3";
import { z } from "zod";
import { ROLE_NAMES, type RoleName } from "../config/document.js";
import { shippedInstructions } from "../config/shipped.js";
import type { ConfigStore } from "../config/store.js";
import { ENDED_STATUSES, type ThreadEvents } from "../t3/events.js";
import { finalMessage } from "../workers/scripts.js";
import type { Card, CardStore } from "./cards.js";
import { ChatChanges, type Deploy } from "./chat-changes.js";
import type { Intake } from "./intake.js";
import type { Pipeline } from "./pipeline.js";

export interface FactoryMcpOptions {
  db: Database;
  cards: CardStore;
  intake: Intake;
  pipeline: Pipeline;
  store: ConfigStore;
  events: ThreadEvents;
  /** Publishes and deploys a config version, for changes agreed in chat. */
  deploy?: Deploy;
  /** The bearer token of each factory profile. */
  tokens: () => Partial<Record<RoleName, string>>;
  now?: () => Date;
}

type Tool =
  | "file_issue"
  | "start_work"
  | "get_status"
  | "escalate"
  | "propose_version"
  | "list_cards"
  | "list_threads"
  | "read_thread"
  | "get_config"
  | "list_targets"
  | "read_target"
  | "propose_change"
  | "apply_change"
  | "decline_change"
  | "list_changes"
  | "revert_change";

/** Each tool's argument schema, shared by its handler and the check at the request boundary. */
const TOOL_SHAPES = {
  file_issue: {
    repo: z.string().describe("owner/repo of a factory project"),
    title: z.string().min(1),
    body: z.string(),
  },
  start_work: { card_id: z.number().int(), brief: z.string().min(1) },
  escalate: { card_id: z.number().int(), reason: z.string().min(1) },
  get_status: { card_id: z.number().int().optional() },
  list_cards: { stage: z.string().optional() },
  list_threads: { since: z.string().describe("ISO 8601 time") },
  read_thread: { environment_id: z.string(), thread_id: z.string() },
  get_config: {},
  list_targets: {},
  read_target: { target: z.string().describe("for example skill:triage/SKILL.md") },
  propose_change: {
    target: z.string().describe("what to change, as list_targets shows"),
    content: z.string().describe("the whole new text; for a setting, its new JSON value"),
    summary: z.string().min(1).describe("one line: what changes and why"),
    conversation: z.string().min(1).describe("an id or link for this chat conversation"),
  },
  apply_change: {
    change_id: z.number().int(),
    conversation: z.string().min(1).describe("the conversation the diff was shown in"),
    approval: z.string().min(1).describe("the person's message approving the change, quoted"),
  },
  decline_change: { change_id: z.number().int(), conversation: z.string().min(1) },
  list_changes: {},
  revert_change: {
    change_id: z.number().int(),
    conversation: z.string().min(1),
    request: z.string().min(1).describe("the person's message asking for the revert, quoted"),
  },
  propose_version: {
    message: z.string().min(1).describe("the problem and the change"),
    config: z
      .record(z.string(), z.unknown())
      .describe("the whole config, as get_config returns it, edited"),
    evidence: z
      .array(
        z.object({
          environment_id: z.string(),
          thread_id: z.string(),
          note: z.string().optional(),
        }),
      )
      .min(1),
  },
} satisfies Record<Tool, z.ZodRawShape>;

/** The tools each role may call. Factory threads never call this server. */
export const ROLE_TOOLS: Record<RoleName, readonly Tool[]> = {
  planner: [
    "file_issue",
    "get_status",
    "list_cards",
    "read_thread",
    "list_targets",
    "read_target",
    "propose_change",
    "apply_change",
    "decline_change",
    "list_changes",
    "revert_change",
  ],
  lead: ["start_work", "escalate", "file_issue", "get_status", "list_cards", "read_thread"],
  improver: [
    "propose_version",
    "get_config",
    "get_status",
    "list_cards",
    "list_threads",
    "read_thread",
  ],
};

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_TEXT = 60_000;

function cardSummary(card: Card): Record<string, unknown> {
  return {
    card_id: card.id,
    repo: card.repo,
    issue: card.issueNumber,
    title: card.title,
    stage: card.stage,
    escalated_to: card.escalatedTo,
    reason: card.reason,
    waiting: card.waiting,
    pr: card.prNumber,
    head_sha: card.headSha,
    review_rounds: card.rounds,
    worker: card.workerEnv,
    implement_thread: card.implementThread,
    review_thread: card.reviewThread,
    updated_at: card.updatedAt,
  };
}

/**
 * What the record keeps of a call's arguments. A proposed change's text is kept
 * with its change record only when it passed the secret check, so the call log
 * keeps just its size.
 */
function redacted(tool: Tool, args: unknown): unknown {
  if (tool !== "propose_change" || typeof args !== "object" || args === null) return args;
  const { content, ...rest } = args as Record<string, unknown>;
  return typeof content === "string"
    ? { ...rest, content: `<${String(content.length)} characters>` }
    : args;
}

function text(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The MCP server the factory profiles use to act through Hephaestus, so the
 * caps, the record, and the gates apply to everything they do. Each profile
 * has its own bearer token, which names the caller, and every call is
 * recorded with that role.
 */
export class FactoryMcp {
  private readonly now: () => Date;
  private readonly changes: ChatChanges;

  constructor(private readonly options: FactoryMcpOptions) {
    this.now = options.now ?? (() => new Date());
    this.changes = new ChatChanges({
      db: options.db,
      store: options.store,
      deploy: options.deploy,
      now: this.now,
    });
  }

  /** The role a request's bearer token belongs to, or undefined. */
  roleFor(request: IncomingMessage): RoleName | undefined {
    const header = request.headers.authorization ?? "";
    const token = /^Bearer (.+)$/.exec(header)?.[1];
    if (token === undefined) return undefined;
    const tokens: Partial<Record<string, string>> = this.options.tokens();
    for (const [role, expected] of Object.entries(tokens)) {
      if (typeof expected === "string" && sameToken(token, expected)) return role as RoleName;
    }
    return undefined;
  }

  listen(port: number, host = "127.0.0.1"): Server {
    const server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        console.error("The factory MCP server failed a request", error);
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "internal error" }));
        }
      });
    });
    server.listen(port, host);
    return server;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    const role = this.roleFor(request);
    if (role === undefined) {
      response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      response.end(JSON.stringify({ error: "a factory profile token is required" }));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "the body is not JSON" }));
      return;
    }
    // A call the SDK refuses before any handler runs, such as a tool this role lacks, is recorded here.
    for (const message of Array.isArray(body) ? (body as unknown[]) : [body]) {
      const call = message as {
        method?: unknown;
        params?: { name?: unknown; arguments?: unknown };
      };
      if (call.method !== "tools/call") continue;
      const name = typeof call.params?.name === "string" ? call.params.name : "";
      if (!(ROLE_TOOLS[role] as readonly string[]).includes(name)) {
        this.record(role, name as Tool, call.params?.arguments ?? {}, false, {
          error: `${role} may not call ${name}`,
        });
        continue;
      }
      // The SDK refuses arguments that do not fit the tool's schema before the handler runs.
      const shape = TOOL_SHAPES[name as Tool];
      // Omitted arguments mean none; an explicit null is refused by the SDK and recorded here.
      const given =
        call.params === undefined || !("arguments" in call.params) ? {} : call.params.arguments;
      const parsed = z.object(shape).safeParse(given);
      if (!parsed.success) {
        this.record(role, name as Tool, call.params?.arguments ?? {}, false, {
          error: `invalid arguments: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        });
      }
    }
    // Stateless: a server and transport per request, so no session state outlives a call.
    const server = this.server(role);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  }

  private record(role: RoleName, tool: Tool, args: unknown, ok: boolean, result: unknown): void {
    this.options.db
      .prepare(
        "INSERT INTO mcp_calls (role, tool, arguments, ok, result, at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        role,
        tool,
        JSON.stringify(redacted(tool, args)).slice(0, MAX_TEXT),
        ok ? 1 : 0,
        JSON.stringify(result).slice(0, MAX_TEXT),
        this.now().toISOString(),
      );
  }

  /** The threads an improver proposal cites as its reason, for the proposal page. */
  evidence(versionId: number): { environmentId: string; threadId: string; note: string }[] {
    return this.options.db
      .prepare(
        "SELECT environment_id AS environmentId, thread_id AS threadId, note FROM version_evidence WHERE version_id = ? ORDER BY rowid",
      )
      .all(versionId) as { environmentId: string; threadId: string; note: string }[];
  }

  /** Recent calls, newest first, for the Activity page. */
  /**
   * The newest tool calls. `role` keeps one role's calls. `repo` keeps the
   * calls about one project: those whose arguments name it as `repo`, or name
   * one of its cards as `card_id`.
   */
  calls(
    limit = 200,
    only: { role?: string; repo?: string } = {},
  ): {
    id: number;
    role: string;
    tool: string;
    arguments: string;
    ok: boolean;
    result: string;
    at: string;
  }[] {
    return (
      this.options.db
        .prepare(
          `SELECT * FROM mcp_calls
           WHERE (@role IS NULL OR role = @role)
             AND (@repo IS NULL OR CASE
               WHEN NOT json_valid(arguments) THEN 0
               WHEN json_type(arguments, '$.repo') = 'text'
                 THEN json_extract(arguments, '$.repo') = @repo
               WHEN json_type(arguments, '$.card_id') IN ('integer', 'real')
                 THEN json_extract(arguments, '$.card_id') IN (SELECT id FROM cards WHERE repo = @repo)
               ELSE 0 END)
           ORDER BY id DESC LIMIT @limit`,
        )
        .all({ limit, role: only.role ?? null, repo: only.repo ?? null }) as {
        id: number;
        role: string;
        tool: string;
        arguments: string;
        ok: number;
        result: string;
        at: string;
      }[]
    ).map((row) => ({ ...row, ok: row.ok === 1 }));
  }

  private server(role: RoleName): McpServer {
    const server = new McpServer({ name: "hephaestus", version: "1.0.0" });
    const allowed = new Set(ROLE_TOOLS[role]);
    const { cards, intake, pipeline, store, events } = this.options;
    const register = <T extends Tool>(
      tool: T,
      description: string,
      run: (args: z.infer<z.ZodObject<(typeof TOOL_SHAPES)[T]>>) => unknown,
    ): void => {
      const shape = TOOL_SHAPES[tool];
      if (!allowed.has(tool)) return;
      const handler = async (
        args: unknown,
      ): Promise<ReturnType<typeof text> & { isError?: boolean }> => {
        try {
          const result = await run(args as z.infer<z.ZodObject<(typeof TOOL_SHAPES)[T]>>);
          this.record(role, tool, args, true, result);
          return text(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.record(role, tool, args, false, { error: message });
          return { ...text({ error: message }), isError: true };
        }
      };
      server.registerTool(tool, { description, inputSchema: shape }, handler as never);
    };

    register(
      "file_issue",
      "File a GitHub issue on a factory project. Hephaestus admits it and creates a card unless the project's cap on open factory issues is reached; then it waits for the owner.",
      async ({ repo, title, body }) => {
        const issue = await intake.fileIssue(role, repo, title, body);
        return {
          issue: issue.number,
          url: `https://github.com/${issue.repo}/issues/${String(issue.number)}`,
          state: issue.state,
          card_id: issue.cardId,
          // Hephaestus finds the request's thread by this line and posts the work's progress there.
          tracking: trackingLine(issue.repo, issue.number),
          reply:
            "If the request came in a chat, reply in its thread with the issue's link and the tracking line exactly as given.",
        };
      },
    );
    register(
      "start_work",
      "Start work on an admitted card, or restart a card escalated to you, with a brief for the engineer.",
      async ({ card_id, brief }) => cardSummary(await pipeline.startWork(card_id, brief)),
    );
    register(
      "escalate",
      "Hand a card to the owner with the reason. Use it when the decision belongs to the owner.",
      async ({ card_id, reason }) => cardSummary(await pipeline.escalateToOwner(card_id, reason)),
    );
    register(
      "get_status",
      "One card's stage, PR, and threads, or with no card_id a summary of every factory project.",
      ({ card_id }) => {
        if (card_id !== undefined) {
          return { ...cardSummary(cards.get(card_id)), events: cards.events(card_id).slice(-20) };
        }
        const config = store.list().find((version) => version.state === "deployed")?.document;
        const projects = Object.keys(config?.projects ?? {}).map((repo) => ({
          repo,
          open_factory_issues_awaiting_work: intake.awaitingWork(repo),
          held_issues: intake
            .issues(["held-cap", "awaiting-owner"])
            .filter((issue) => issue.repo === repo).length,
          cards_by_stage: Object.fromEntries(
            [
              ...new Set(
                cards
                  .list()
                  .filter((card) => card.repo === repo)
                  .map((card) => card.stage),
              ),
            ].map((stage) => [
              stage,
              cards.list([stage]).filter((card) => card.repo === repo).length,
            ]),
          ),
        }));
        return { paused: pipeline.paused(), projects };
      },
    );
    register("list_cards", "Cards, newest first, optionally in one stage.", ({ stage }) =>
      cards
        .list(stage === undefined ? undefined : [stage as Card["stage"]])
        .slice(0, 100)
        .map(cardSummary),
    );
    register(
      "list_threads",
      "Factory threads (implement and review) started since a time, with their card and status.",
      ({ since }) =>
        this.options.db
          .prepare(
            `SELECT environment_id, thread_id, title, kind, card_id, status, config_version, created_at
             FROM factory_threads WHERE kind IN ('implement', 'review') AND created_at >= ? ORDER BY created_at`,
          )
          .all(since),
    );
    register(
      "read_thread",
      "A factory thread's final message and its activity, as Hephaestus recorded it.",
      ({ environment_id, thread_id }) => {
        const thread = events.thread(environment_id, thread_id);
        if (thread === undefined || thread.kind === "setup")
          throw new Error("There is no such factory thread.");
        const items = events.items(environment_id, thread_id);
        let budget = MAX_TEXT;
        const activity = items.map((item) => {
          const part = item.text.slice(0, Math.max(0, Math.min(4000, budget)));
          budget -= part.length;
          return { type: item.type, status: item.status, text: part };
        });
        return {
          title: thread.title,
          kind: thread.kind,
          card_id: thread.cardId,
          status: thread.status,
          ended: ENDED_STATUSES.has(thread.status),
          final_message: finalMessage(items) ?? null,
          activity,
        };
      },
    );
    register(
      "get_config",
      "The deployed config version, which a proposal edits, and each role's shipped instructions, which no proposal can change. A role's persona adds to its shipped instructions.",
      () => {
        const deployed = store.list().find((version) => version.state === "deployed");
        if (deployed === undefined) throw new Error("No config version is deployed.");
        return {
          version: deployed.id,
          config: deployed.document,
          shipped_instructions: Object.fromEntries(
            ROLE_NAMES.map((role) => [role, shippedInstructions(role)]),
          ),
        };
      },
    );
    register(
      "propose_version",
      "Propose a new config version: the whole config, edited, with the factory threads that motivated the change. Nothing changes until the owner approves it.",
      ({ message, config, evidence }) => {
        for (const item of evidence) {
          const thread = events.thread(item.environment_id, item.thread_id);
          if (thread === undefined || thread.kind === "setup") {
            throw new Error(`Evidence ${item.thread_id} is not a factory thread.`);
          }
        }
        const deployed = store.list().find((version) => version.state === "deployed");
        if (deployed === undefined) throw new Error("No config version is deployed.");
        const version = store.createVersion({
          document: config as never,
          author: "improver",
          message,
          parentId: deployed.id,
        });
        const insert = this.options.db.prepare(
          "INSERT INTO version_evidence (version_id, environment_id, thread_id, note) VALUES (?, ?, ?, ?)",
        );
        for (const item of evidence)
          insert.run(version.id, item.environment_id, item.thread_id, item.note ?? "");
        return {
          version: version.id,
          state: version.state,
          changes: store.diff(version.id).length,
        };
      },
    );
    this.registerChangeTools(register);
    return server;
  }

  private registerChangeTools(
    register: <T extends Tool>(
      tool: T,
      description: string,
      run: (args: z.infer<z.ZodObject<(typeof TOOL_SHAPES)[T]>>) => unknown,
    ) => void,
  ): void {
    const { changes } = this;
    const present = (change: ReturnType<ChatChanges["get"]>): Record<string, unknown> => ({
      change_id: change.id,
      target: change.target,
      summary: change.summary,
      state: change.state,
      conversation: change.conversation,
      proposed_at: change.proposedAt,
      approval: change.approval,
      applied_at: change.appliedAt,
      version: change.version,
      error: change.error,
      reverted_at: change.revertedAt,
      revert_version: change.revertVersion,
    });
    register(
      "list_targets",
      "The skills, instructions, personas, and settings of the factory that can be changed from chat. Nothing else can, and never a secret.",
      () => changes.targets(),
    );
    register(
      "read_target",
      "The current text of one editable target: a skill file, an instruction, a persona, or a setting.",
      ({ target }) => changes.read(target),
    );
    register(
      "propose_change",
      "Propose a new text for one editable target. Nothing is written. Returns the exact diff, which you must post in the chat, and then ask the person to approve it.",
      ({ target, content, summary, conversation }) => {
        const { change, diff } = changes.propose({ target, content, summary, conversation });
        return {
          change_id: change.id,
          target: change.target,
          diff,
          next: "Post this diff exactly as given, in a code block, and ask the person whether to apply it. Call apply_change only after they approve in this conversation, and decline_change if they decline. If they say nothing, do nothing.",
        };
      },
    );
    register(
      "apply_change",
      "Apply a proposed change after the person approved it in the same conversation. It is checked, saved as a config version, and deployed. Report the result to the person, including any error.",
      async ({ change_id, conversation, approval }) => {
        const { change, warning } = await changes.apply({
          id: change_id,
          conversation,
          approval,
        });
        return { ...present(change), ...(warning === undefined ? {} : { warning }) };
      },
    );
    register(
      "decline_change",
      "Record that the person declined a proposed change. Nothing is written.",
      ({ change_id, conversation }) => present(changes.decline({ id: change_id, conversation })),
    );
    register(
      "list_changes",
      "The changes proposed and applied from chat, newest first, with their state, conversation, and config version.",
      () => changes.list().map(present),
    );
    register(
      "revert_change",
      "Put an applied change back as it was, when the person asks for that. Saved and deployed as a new config version; refused when the target has changed since.",
      async ({ change_id, conversation, request }) => {
        const { change, diff, warning } = await changes.revert({
          id: change_id,
          conversation,
          request,
        });
        return { ...present(change), diff, ...(warning === undefined ? {} : { warning }) };
      },
    );
  }
}
