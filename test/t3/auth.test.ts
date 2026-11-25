import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretsFile } from "../../src/config/secrets.js";
import {
  T3Credentials,
  mintPairingCode,
  revokeSessions,
  signIn,
  type CliRun,
} from "../../src/t3/auth.js";

let server: Server;
let origin: string;
let dir: string;
const seen: { path: string; body: string }[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hephaestus-t3auth-"));
  seen.length = 0;
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const path = request.url ?? "";
      seen.push({ path, body });
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (path === "/oauth/mcp/register") json(201, { client_id: "client-1" });
      else if (path === "/oauth/mcp/approval") json(200, { clientName: "Hephaestus" });
      else if (path === "/oauth/mcp/decision") {
        const decision = (JSON.parse(body) as { decision: { code: string } }).decision;
        if (decision.code !== "PAIR-CODE") json(400, { message: "bad code" });
        else json(200, { redirectTo: "http://127.0.0.1:1/callback?code=auth-code&state=s" });
      } else if (path === "/oauth/mcp/token") {
        json(200, {
          access_token: "token-1",
          token_type: "Bearer",
          expires_in: 2592000,
          scope: "x",
        });
      } else json(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe("signIn", () => {
  it("registers, approves with a pairing code, and exchanges the code with PKCE", async () => {
    const token = await signIn(origin, "Hephaestus (abc)", "PAIR-CODE", () => 1_000_000);

    expect(token).toEqual({ accessToken: "token-1", expiresAt: 1_000_000 + 2592000 * 1000 });
    expect(seen.map((request) => request.path)).toEqual([
      "/oauth/mcp/register",
      "/oauth/mcp/approval",
      "/oauth/mcp/decision",
      "/oauth/mcp/token",
    ]);
    const decision = JSON.parse(seen[2]?.body ?? "{}") as { decision: unknown };
    expect(decision.decision).toEqual({
      _tag: "pairing-code",
      access: "full-access",
      code: "PAIR-CODE",
    });
    const exchange = new URLSearchParams(seen[3]?.body);
    expect(exchange.get("code")).toBe("auth-code");
    expect(exchange.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("fails with T3's message when the pairing code is refused", async () => {
    await expect(signIn(origin, "Hephaestus (abc)", "WRONG", () => 0)).rejects.toThrow(/bad code/);
  });
});

describe("T3Credentials", () => {
  it("signs in once, keeps the token in the secrets file, and reuses it", async () => {
    let signIns = 0;
    const credentials = new T3Credentials(
      new SecretsFile(join(dir, "secrets.json")),
      () => {
        signIns += 1;
        return Promise.resolve({
          accessToken: `token-${String(signIns)}`,
          expiresAt: 10 * 86_400_000,
        });
      },
      () => 0,
    );

    expect(await credentials.token()).toBe("token-1");
    expect(await credentials.token()).toBe("token-1");
    expect(new SecretsFile(join(dir, "secrets.json")).get("t3-mcp-token")).toBe("token-1");
    expect(signIns).toBe(1);
  });

  it("signs in again when the token is within 3 days of expiry, or after renew", async () => {
    let now = 0;
    let signIns = 0;
    const credentials = new T3Credentials(
      new SecretsFile(join(dir, "secrets.json")),
      () => {
        signIns += 1;
        return Promise.resolve({
          accessToken: `token-${String(signIns)}`,
          expiresAt: now + 10 * 86_400_000,
        });
      },
      () => now,
    );

    await credentials.token();
    now = 8 * 86_400_000;
    expect(await credentials.token()).toBe("token-2");
    await credentials.renew();
    expect(await credentials.token()).toBe("token-3");
  });
});

describe("T3 CLI helpers", () => {
  it("mints a short-lived pairing code with the scopes full access needs", async () => {
    const calls: string[][] = [];
    const run: CliRun = (args) => {
      calls.push(args);
      return Promise.resolve(JSON.stringify({ id: "p1", credential: "PAIR-CODE" }));
    };

    expect(await mintPairingCode(run, "Hephaestus (abc)")).toBe("PAIR-CODE");
    expect(calls[0]).toEqual([
      "auth",
      "pairing",
      "create",
      "--scope",
      "orchestration:read",
      "--scope",
      "orchestration:operate",
      "--scope",
      "settings:write",
      "--scope",
      "source-control:write",
      "--ttl",
      "5m",
      "--label",
      "Hephaestus (abc)",
      "--json",
    ]);
  });

  it("revokes only the sessions signed in under Hephaestus's client name", async () => {
    const calls: string[][] = [];
    const run: CliRun = (args) => {
      calls.push(args);
      if (args[2] === "list") {
        return Promise.resolve(
          JSON.stringify([
            { sessionId: "s1", subject: "mcp-client", client: { label: "Hephaestus (abc)" } },
            { sessionId: "s2", subject: "mcp-client", client: { label: "Owner laptop" } },
            { sessionId: "s3", subject: "browser", client: { label: "Hephaestus (abc)" } },
          ]),
        );
      }
      return Promise.resolve("");
    };

    expect(await revokeSessions(run, "Hephaestus (abc)")).toEqual(["s1"]);
    expect(calls).toEqual([
      ["auth", "session", "list", "--json"],
      ["auth", "session", "revoke", "s1"],
    ]);
  });
});
