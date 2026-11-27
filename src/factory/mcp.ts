import { trackingLine } from "../request-threads.js";
import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Database } from "better-sqlite3";
import { z } from "zod";
import { ROLE_NAMES, type RoleName } from "../config/document.js";
import { shippedInstructions } from "../config/shipped.js";
import type { ConfigStore } from "../config/store.js";
import { formatHostHealth, hostHealth, type HostHealth } from "../host-health.js";
import { ENDED_STATUSES, type ThreadEvents } from "../t3/events.js";
import { finalMessage } from "../workers/scripts.js";
import type { Task, TaskStore } from "./tasks.js";
import {
  CHANGE_SHAPES,
  CHANGE_TOOLS,
  redactChangeArgs,
  registerChangeTools,
  type ChangeRegister,
  type ChangeTool,
} from "./chat-change-tools.js";
import { ChatChanges, type Deploy } from "./chat-changes.js";
import type { Intake } from "./intake.js";
import type { Pipeline } from "./pipeline.js";
import { factoryStats, formatFactoryStats, formatUsageStats, usageStats } from "./stats.js";

export interface FactoryMcpOptions {
  db: Database;
  tasks: TaskStore;
  intake: Intake;
  pipeline: Pipeline;
  store: ConfigStore;
  events: ThreadEvents;
  /** Publishes and deploys a config version, for changes agreed in chat. */
  deploy?: Deploy;
  /** The bearer token of each factory profile. */
  tokens: () => Partial<Record<RoleName, string>>;
  /** Where a role's chat gateway caches the files a requester sends; the only places attachments may come from. */
  attachmentRoots?: (role: RoleName) => readonly string[];
  now?: () => Date;
  /** Reads the host's health; defaults to the system's. Tests supply their own. */
  health?: (window: string | undefined) => HostHealth;
}

type Tool =
  | "file_issue"
  | "start_work"
  | "get_status"
  | "escalate"
  | "propose_version"
  | "list_tasks"
  | "list_threads"
  | "read_thread"
  | "get_config"
  | ChangeTool
  | "get_factory_stats"
  | "get_usage_stats"
  | "get_host_health";

/** Each tool's argument schema, shared by its handler and the check at the request boundary. */
const TOOL_SHAPES = {
  ...CHANGE_SHAPES,
  file_issue: {
    repo: z.string().describe("owner/repo of a factory project"),
    title: z.string().min(1),
    body: z.string(),
    attachments: z
      .array(z.string())
      .optional()
      .describe(
        "absolute paths of files the requester sent in the chat, as the chat gave them to you; at most 10 files of 10 MB each",
      ),
  },
  start_work: { task_id: z.number().int(), brief: z.string().min(1) },
  escalate: { task_id: z.number().int(), reason: z.string().min(1) },
  get_status: { task_id: z.number().int().optional() },
  list_tasks: { stage: z.string().optional() },
  list_threads: { since: z.string().describe("ISO 8601 time") },
  read_thread: { environment_id: z.string(), thread_id: z.string() },
  get_config: {},
  get_factory_stats: {
    window: z.string().optional().describe("a time window such as 24h, 7d, or 30d; default 7d"),
    repo: z.string().optional().describe("owner/repo to limit the stats to one project"),
  },
  get_usage_stats: {
    window: z.string().optional().describe("a time window such as 24h, 7d, or 30d; default 7d"),
    repo: z.string().optional().describe("owner/repo to limit the stats to one project"),
  },
  get_host_health: {
    window: z
      .string()
      .optional()
      .describe("how far back to look for recent errors, such as 24h or 7d; default 24h"),
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
    "list_tasks",
    "read_thread",
    "get_factory_stats",
    "get_usage_stats",
    "get_host_health",
    ...CHANGE_TOOLS,
  ],
  lead: ["start_work", "escalate", "file_issue", "get_status", "list_tasks", "read_thread"],
  improver: [
    "propose_version",
    "get_config",
    "get_status",
    "list_tasks",
    "list_threads",
    "read_thread",
  ],
};

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_TEXT = 60_000;

function taskSummary(task: Task, mergedAt: string | null): Record<string, unknown> {
  return {
    task_id: task.id,
    repo: task.repo,
    issue: task.issueNumber,
    title: task.title,
    stage: task.stage,
    escalated_to: task.escalatedTo,
    reason: task.reason,
    waiting: task.waiting,
    pr: task.prNumber,
    // The recorded merge time; null when no merge is recorded, for example before merge times were kept.
    merged_at: mergedAt,
    head_sha: task.headSha,
    review_rounds: task.rounds,
    worker: task.workerEnv,
    implement_thread: task.implementThread,
    review_thread: task.reviewThread,
    updated_at: task.updatedAt,
  };
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
    this.changes = new ChatChanges({ ...options, now: this.now });
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
        JSON.stringify(redactChangeArgs(tool, args)).slice(0, MAX_TEXT),
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
   * one of its tasks as `task_id`.
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
               WHEN json_type(arguments, '$.task_id') IN ('integer', 'real')
                 THEN json_extract(arguments, '$.task_id') IN (SELECT id FROM tasks WHERE repo = @repo)
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
    const { tasks, intake, pipeline, store, events } = this.options;
    const summary = (task: Task): Record<string, unknown> =>
      taskSummary(task, tasks.mergedAt(task.repo, task.prNumber));
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
      "File a GitHub issue on a factory project. Hephaestus admits it and creates a task unless the project's cap on open factory issues is reached; then it waits for the owner. To hand files from the request to the engineer, such as an attached image, pass their absolute paths, as the chat gave them to you, in attachments: at most 10 files, 10 MB each, any type. Only files the requester sent in the chat can be attached, not other files on the host or URLs. Hephaestus stores each file in the project's repo and links it in the issue, and the engineer can commit it. If any file is missing, unreadable, or too large, no issue is filed and the error names the file.",
      async ({ repo, title, body, attachments }) => {
        const issue = await intake.fileIssue(
          role,
          repo,
          title,
          body,
          attachments,
          this.options.attachmentRoots?.(role),
        );
        return {
          issue: issue.number,
          url: `https://github.com/${issue.repo}/issues/${String(issue.number)}`,
          state: issue.state,
          task_id: issue.taskId,
          // Hephaestus finds the request's thread by this line and posts the work's progress there.
          tracking: trackingLine(issue.repo, issue.number),
          reply:
            "If the request came in a chat, reply in its thread with the issue's link and the tracking line exactly as given.",
        };
      },
    );
    register(
      "start_work",
      "Start work on an admitted task, or restart a task escalated to you, with a brief for the engineer.",
      async ({ task_id, brief }) => summary(await pipeline.startWork(task_id, brief)),
    );
    register(
      "escalate",
      "Hand a task to the owner with the reason. Use it when the decision belongs to the owner.",
      async ({ task_id, reason }) => summary(await pipeline.escalateToOwner(task_id, reason)),
    );
    register(
      "get_status",
      "One task's stage, PR, and threads, or with no task_id a summary of every factory project.",
      ({ task_id }) => {
        if (task_id !== undefined) {
          return { ...summary(tasks.get(task_id)), events: tasks.events(task_id).slice(-20) };
        }
        const config = store.list().find((version) => version.state === "deployed")?.document;
        const projects = Object.keys(config?.projects ?? {}).map((repo) => ({
          repo,
          open_factory_issues_awaiting_work: intake.awaitingWork(repo),
          held_issues: intake
            .issues(["held-cap", "awaiting-owner"])
            .filter((issue) => issue.repo === repo).length,
          tasks_by_stage: Object.fromEntries(
            [
              ...new Set(
                tasks
                  .list()
                  .filter((task) => task.repo === repo)
                  .map((task) => task.stage),
              ),
            ].map((stage) => [
              stage,
              tasks.list([stage]).filter((task) => task.repo === repo).length,
            ]),
          ),
        }));
        return { paused: pipeline.paused(), projects };
      },
    );
    register("list_tasks", "Tasks, newest first, optionally in one stage.", ({ stage }) =>
      tasks
        .list(stage === undefined ? undefined : [stage as Task["stage"]])
        .slice(0, 100)
        .map(summary),
    );
    register(
      "list_threads",
      "Factory threads (implement and review) started since a time, with their task and status.",
      ({ since }) =>
        this.options.db
          .prepare(
            `SELECT environment_id, thread_id, title, kind, task_id, status, config_version, created_at
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
          task_id: thread.taskId,
          status: thread.status,
          ended: ENDED_STATUSES.has(thread.status),
          final_message: finalMessage(items) ?? null,
          activity,
        };
      },
    );
    // The stats tools only read. Each returns the numbers and a `report` of bullet lines to relay.
    register(
      "get_factory_stats",
      "Read-only factory stats: tasks by stage, throughput, cycle time, review rounds, escalations with their reasons, and held issues, for a time window and optionally one project. The report field is ready to relay in a chat.",
      ({ window, repo }) => {
        const stats = factoryStats(this.options.db, { window, repo, now: this.now() });
        return { ...stats, report: formatFactoryStats(stats) };
      },
    );
    register(
      "get_usage_stats",
      "Read-only token usage and cost of the engineer and reviewer threads, by role, model, and task, for a time window and optionally one project. Only recorded usage is counted; the report says when nothing was recorded.",
      ({ window, repo }) => {
        const stats = usageStats(this.options.db, { window, repo, now: this.now() });
        return { ...stats, report: formatUsageStats(stats) };
      },
    );
    register(
      "get_host_health",
      "Read-only host health: CPU, memory, disk, uptime, the state of Hephaestus's services and workers, and recent errors.",
      ({ window }) => {
        const health =
          this.options.health?.(window) ??
          hostHealth(this.options.db, { path: homedir(), window, now: this.now() });
        return { ...health, report: formatHostHealth(health) };
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
    registerChangeTools(register as ChangeRegister, this.changes);
    return server;
  }
}
