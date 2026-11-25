import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export type ToolHandler = (args: Record<string, unknown>) => unknown;

/** Resolves after `ms`, for handlers that simulate a slow worker. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A stand-in for T3's outside MCP server. It answers the tools a test
 * registers, returns results as `structuredContent` the way T3 does, and
 * returns `{ _tag: "OrchestratorMcpFailure" }` text for thrown errors.
 */
export class FakeT3 {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  readonly tools = new Map<string, ToolHandler>();
  /** Bearer tokens the server accepts; requests with any other token get 401. */
  readonly tokens = new Set<string>(["good-token"]);
  private http: HttpServer | undefined;
  url = "";

  async start(): Promise<void> {
    this.http = createServer((request, response) => {
      if (
        request.headers.authorization === undefined ||
        !this.tokens.has(request.headers.authorization.replace(/^Bearer /, ""))
      ) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_mcp_credential" }));
        return;
      }
      // The low-level Server answers any tool name without a zod schema per tool.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const server = new Server(
        { name: "fake-t3", version: "0.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: [...this.tools.keys()].map((name) => ({
          name,
          inputSchema: { type: "object" as const },
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = request.params.arguments ?? {};
        this.calls.push({ name: request.params.name, args });
        const handler = this.tools.get(request.params.name);
        try {
          if (handler === undefined)
            throw new FakeFailure("unknown_tool", `No tool ${request.params.name}`);
          const result = (await handler(args)) as Record<string, unknown>;
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          const failure =
            error instanceof FakeFailure ? error : new FakeFailure("internal", String(error));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  _tag: "OrchestratorMcpFailure",
                  code: failure.code,
                  message: failure.message,
                }),
              },
            ],
          };
        }
      });
      // No session id generator: a stateless server, one request per transport.
      const transport = new StreamableHTTPServerTransport({});
      void server.connect(transport).then(() => transport.handleRequest(request, response));
    });
    const http = this.http;
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${String((http.address() as AddressInfo).port)}/mcp`;
  }

  async stop(): Promise<void> {
    const http = this.http;
    if (http === undefined) return;
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
}

export class FakeFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
