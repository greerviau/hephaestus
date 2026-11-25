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
  /** Clients replaced after a failure; their calls already sent may still settle. */
  private readonly retired = new Set<Promise<Client>>();
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
      if (error instanceof T3ToolError) throw error;
      // Any other failure means the client may be dead: a T3 restart ends its
      // MCP session or moves its port. The next call opens a fresh one.
      this.retire(client);
      if (!isUnauthorized(error)) throw error;
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

  /** Closes every client and fails the calls still waiting on them. Never waits on a stalled sign-in. */
  async close(): Promise<void> {
    this.closed = true;
    const clients = [...this.retired, ...(this.client === undefined ? [] : [this.client])];
    this.client = undefined;
    this.retired.clear();
    await Promise.all(clients.map((client) => closeSoon(client)));
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
    // A connection opened during a renewal would use the token being replaced.
    if (this.renewal !== undefined) await this.renewal.catch(() => undefined);
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

  /**
   * Stops handing out `pending`, if it is still the current client, and closes
   * it a little later, so calls other callers already sent on it can settle.
   */
  private retire(pending: Promise<Client>): void {
    if (this.client === pending) this.client = undefined;
    if (this.retired.has(pending)) return;
    this.retired.add(pending);
    setTimeout(() => {
      this.retired.delete(pending);
      void closeSoon(pending);
    }, RETIRE_AFTER_MS).unref();
  }
}

const RETIRE_AFTER_MS = 30_000;

/** Closes a client once it has connected, giving up after a second if it never does. */
async function closeSoon(pending: Promise<Client>): Promise<void> {
  const giveUp = new Promise<undefined>((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, 1_000);
    timer.unref();
  });
  const client = await Promise.race([pending.catch(() => undefined), giveUp]);
  await client?.close().catch(() => undefined);
}
