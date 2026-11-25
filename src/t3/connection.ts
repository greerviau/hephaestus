import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Supplies and renews the bearer token for T3's outside MCP server. */
export interface Credential {
  token(): Promise<string>;
  /** Gets a new token after T3 rejected the current one. */
  renew(): Promise<void>;
}

/** A tool call that T3 answered with an `OrchestratorMcpFailure`. */
export class T3ToolError extends Error {
  constructor(
    readonly tool: string,
    readonly code: string,
    message: string,
  ) {
    super(`${tool}: ${code}: ${message}`);
  }
}

const CALL_TIMEOUT_MS = 10 * 60 * 1000;

function isUnauthorized(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) return error.code === 401;
  return error instanceof Error && error.name === "UnauthorizedError";
}

function failureOf(content: unknown): { code: string; message: string } | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const part of content as { type?: string; text?: string }[]) {
    if (part.type !== "text" || part.text === undefined) continue;
    try {
      const parsed = JSON.parse(part.text) as { _tag?: string; code?: string; message?: string };
      if (parsed._tag === "OrchestratorMcpFailure") {
        return { code: parsed.code ?? "unknown", message: parsed.message ?? "" };
      }
    } catch {
      // Plain text content.
    }
  }
  return undefined;
}

/**
 * A connection to T3's outside MCP server on the Hermes host. It connects on
 * first use, and after T3 rejects the token it renews the credential and
 * retries once.
 */
export class T3Connection {
  private client: Client | undefined;

  constructor(
    private readonly url: string,
    private readonly credential: Credential,
  ) {}

  async call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return await this.callOnce(tool, args);
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      await this.reset();
      await this.credential.renew();
      try {
        return await this.callOnce(tool, args);
      } catch (retryError) {
        if (isUnauthorized(retryError)) {
          throw new Error("T3 rejected the renewed MCP credential (401).", { cause: retryError });
        }
        throw retryError;
      }
    }
  }

  async close(): Promise<void> {
    await this.reset();
  }

  private async callOnce(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const client = await this.connect();
    const result = await client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    });
    const failure = failureOf(result.content);
    if (failure !== undefined) throw new T3ToolError(tool, failure.code, failure.message);
    if (result.isError === true)
      throw new T3ToolError(tool, "error", JSON.stringify(result.content));
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  }

  private async connect(): Promise<Client> {
    if (this.client !== undefined) return this.client;
    const token = await this.credential.token();
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "hephaestus", version: "0.0.0" });
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    this.client = client;
    return client;
  }

  private async reset(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => undefined);
  }
}
