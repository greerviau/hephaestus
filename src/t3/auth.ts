import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { SecretsFile } from "../config/secrets.js";
import type { Credential } from "./connection.js";

export interface T3Token {
  accessToken: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

/** Sign-in needs nothing to listen here: T3 returns the redirect, and the code is read from it. */
const REDIRECT_URI = "http://127.0.0.1:1/callback";
/** Sign in again this long before the token expires. */
const RENEW_BEFORE_MS = 3 * 24 * 60 * 60 * 1000;
const TOKEN_SECRET = "t3-mcp-token";
const EXPIRY_SECRET = "t3-mcp-token-expires-at";
/** Scopes a pairing code needs to approve a `full-access` MCP client. */
const FULL_ACCESS_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "settings:write",
  "source-control:write",
];

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const reason = result.message ?? result.error_description ?? result.error ?? response.status;
    const text = typeof reason === "string" ? reason : JSON.stringify(reason);
    throw new Error(`T3 sign-in failed at ${new URL(url).pathname}: ${text}`);
  }
  return result;
}

/**
 * Signs in to T3's outside MCP server with OAuth (PKCE, dynamic client
 * registration) and approves the sign-in with a pairing code instead of a
 * browser.
 */
export async function signIn(
  origin: string,
  clientName: string,
  pairingCode: string,
  now: () => number = Date.now,
): Promise<T3Token> {
  const registered = await postJson(`${origin}/oauth/mcp/register`, {
    client_name: clientName,
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: "none",
  });
  const verifier = randomBytes(32).toString("base64url");
  const authorization = {
    response_type: "code",
    client_id: String(registered.client_id),
    redirect_uri: REDIRECT_URI,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: randomBytes(16).toString("base64url"),
    resource: `${origin}/mcp`,
  };
  await postJson(`${origin}/oauth/mcp/approval`, authorization);
  const decision = await postJson(`${origin}/oauth/mcp/decision`, {
    authorization,
    decision: { _tag: "pairing-code", access: "full-access", code: pairingCode },
  });
  const code = new URL(String(decision.redirectTo)).searchParams.get("code");
  if (code === null) throw new Error("T3 sign-in returned no authorization code.");
  const response = await fetch(`${origin}/oauth/mcp/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: authorization.client_id,
      code_verifier: verifier,
      resource: authorization.resource,
    }),
  });
  const token = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!response.ok || token.access_token === undefined || token.expires_in === undefined) {
    throw new Error(`T3 sign-in failed at /oauth/mcp/token: ${String(response.status)}`);
  }
  return { accessToken: token.access_token, expiresAt: now() + token.expires_in * 1000 };
}

/** The T3 MCP token, kept in the secrets file and renewed before it expires. */
export class T3Credentials implements Credential {
  constructor(
    private readonly secrets: SecretsFile,
    private readonly signInAgain: () => Promise<T3Token>,
    private readonly now: () => number = Date.now,
  ) {}

  async token(): Promise<string> {
    const token = this.secrets.get(TOKEN_SECRET);
    const expiresAt = Number(this.secrets.get(EXPIRY_SECRET) ?? 0);
    if (token !== undefined && expiresAt - this.now() > RENEW_BEFORE_MS) return token;
    await this.renew();
    return this.secrets.get(TOKEN_SECRET) ?? "";
  }

  async renew(): Promise<void> {
    const token = await this.signInAgain();
    this.secrets.set(TOKEN_SECRET, token.accessToken);
    this.secrets.set(EXPIRY_SECRET, String(token.expiresAt));
  }

  forget(): void {
    this.secrets.delete(TOKEN_SECRET);
    this.secrets.delete(EXPIRY_SECRET);
  }
}

/** Runs the `t3` CLI with arguments and resolves with its stdout. */
export type CliRun = (args: string[]) => Promise<string>;

export const runT3: CliRun = (args) =>
  new Promise((resolve, reject) => {
    execFile("t3", args, { timeout: 30_000 }, (error, stdout) => {
      if (error)
        reject(
          new Error(`t3 ${args.slice(0, 3).join(" ")} failed: ${error.message}`, { cause: error }),
        );
      else resolve(stdout);
    });
  });

/** Mints a 5-minute pairing code on the local T3 server for one sign-in. */
export async function mintPairingCode(run: CliRun, label: string): Promise<string> {
  const output = await run([
    "auth",
    "pairing",
    "create",
    ...FULL_ACCESS_SCOPES.flatMap((scope) => ["--scope", scope]),
    "--ttl",
    "5m",
    "--label",
    label,
    "--json",
  ]);
  const credential = (JSON.parse(output) as { credential?: string }).credential;
  if (credential === undefined) throw new Error("`t3 auth pairing create` returned no code.");
  return credential;
}

/** Revokes every T3 MCP session signed in under `clientName`, and returns their ids. */
export async function revokeSessions(run: CliRun, clientName: string): Promise<string[]> {
  const sessions = JSON.parse(await run(["auth", "session", "list", "--json"])) as {
    sessionId: string;
    subject: string;
    client?: { label?: string };
  }[];
  const ours = sessions.filter(
    (session) => session.subject === "mcp-client" && session.client?.label === clientName,
  );
  for (const session of ours) await run(["auth", "session", "revoke", session.sessionId]);
  return ours.map((session) => session.sessionId);
}

/** The client name Hephaestus signs in under, unique to one install. */
export function t3ClientName(instanceId: string): string {
  return `Hephaestus (${instanceId.slice(0, 8)})`;
}
