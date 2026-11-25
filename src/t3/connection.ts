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
 * first use; concurrent calls share one connection attempt and one renewal.
 * After T3 rejects the token it renews the credential and retries once.
 */
export class T3Connection {
  private client: Promise<Client> | undefined;
  private renewal: Promise<void> | undefined;
  private closed = false;

  /** `url` may be a function, so a changed T3 port is picked up on the next connect. */
  constructor(
    private readonly url: string | (() => string),
    private readonly credential: Credential,
  ) {}

  async call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const client = this.connect();
    try {
      return await this.callWith(client, tool, args);
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      await this.invalidate(client);
      await this.renew();
      try {
        return await this.callWith(this.connect(), tool, args);
      } catch (retryError) {
        if (isUnauthorized(retryError)) {
          throw new Error("T3 rejected the renewed MCP credential (401).", { cause: retryError });
        }
        throw retryError;
      }
    }
  }

  /** Closes the connection and fails every call still waiting on it. */
  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    if (client !== undefined)
      await (await client.catch(() => undefined))?.close().catch(() => undefined);
  }

  private async callWith(
    pending: Promise<Client>,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const client = await pending;
    const result = await client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    });
    const failure = failureOf(result.content);
    if (failure !== undefined) throw new T3ToolError(tool, failure.code, failure.message);
    if (result.isError === true) throw new T3ToolError(tool, "error", "T3 reported a tool error.");
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  }

  private connect(): Promise<Client> {
    if (this.closed) return Promise.reject(new Error("The T3 connection is closed."));
    this.client ??= this.open().catch((error: unknown) => {
      this.client = undefined;
      throw error;
    });
    return this.client;
  }

  private async open(): Promise<Client> {
    const token = await this.credential.token();
    const url = typeof this.url === "string" ? this.url : this.url();
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "hephaestus", version: "0.0.0" });
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    return client;
  }

  private renew(): Promise<void> {
    this.renewal ??= this.credential.renew().finally(() => {
      this.renewal = undefined;
    });
    return this.renewal;
  }

  /** Drops `pending` if it is still the current client, so a newer client another call made survives. */
  private async invalidate(pending: Promise<Client>): Promise<void> {
    if (this.client === pending) this.client = undefined;
    const client = await pending.catch(() => undefined);
    await client?.close().catch(() => undefined);
  }
}
