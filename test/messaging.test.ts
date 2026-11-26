import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/factory/cards.js";
import { Messaging, MessagingError } from "../src/messaging.js";
import { openStore } from "../src/store.js";

const DISCORD_TOKEN = `${"M".repeat(24)}.${"G".repeat(6)}.${"x".repeat(27)}`;
const USER = "284102345871466496";
const CHANNEL = "1234567890123456789";

let root: string;
let db: Database;
let cards: CardStore;
let calls: { args: string[]; input: string | undefined }[];
let restarts: number;
let fail: Error | undefined;
let messaging: Messaging;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hephaestus-messaging-"));
  mkdirSync(join(root, "profiles", "planner"), { recursive: true });
  writeFileSync(join(root, "profiles", "planner", ".env"), "HEPHAESTUS_MCP_TOKEN=keep-me\n");
  db = openStore(":memory:");
  cards = new CardStore(db);
  calls = [];
  restarts = 0;
  fail = undefined;
  messaging = new Messaging({
    root,
    run: (args, options) => {
      calls.push({ args, input: options?.input });
      return fail === undefined ? Promise.resolve("") : Promise.reject(fail);
    },
    restartGateway: () => {
      restarts += 1;
    },
    db,
    cards,
    dashboardUrl: () => "http://192.168.1.5:7700/",
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  db.close();
});

function env(): string {
  return readFileSync(join(root, "profiles", "planner", ".env"), "utf8");
}

describe("Messaging", () => {
  it("connects Discord with a request channel that threads each message, and restarts the gateway", () => {
    messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });

    expect(env()).toContain("HEPHAESTUS_MCP_TOKEN=keep-me");
    expect(env()).toContain(`DISCORD_BOT_TOKEN=${DISCORD_TOKEN}`);
    expect(env()).toContain(`DISCORD_ALLOWED_USERS=${USER}`);
    expect(env()).toContain(`DISCORD_HOME_CHANNEL=${CHANNEL}`);
    expect(env()).toContain(`DISCORD_FREE_RESPONSE_CHANNELS=${CHANNEL}`);
    expect(env()).toContain("DISCORD_FREE_RESPONSE_AUTO_THREAD=true");
    expect(statSync(join(root, "profiles", "planner", ".env")).mode & 0o777).toBe(0o600);
    expect(restarts).toBe(1);
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      connected: true,
      tokenEnd: DISCORD_TOKEN.slice(-4),
      users: [USER],
      home: CHANNEL,
    });
  });

  it("removes only the platform's settings on disconnect", () => {
    messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });
    messaging.disconnect("discord");
    expect(env()).toBe("HEPHAESTUS_MCP_TOKEN=keep-me\n");
    expect(restarts).toBe(2);
  });

  it("refuses a malformed token, a missing user, a Discord connection with no channel, and an unready factory", () => {
    for (const input of [
      { token: "not-a-token", users: USER, home: CHANNEL },
      { token: DISCORD_TOKEN, users: "", home: CHANNEL },
      { token: DISCORD_TOKEN, users: "someone", home: CHANNEL },
      { token: DISCORD_TOKEN, users: USER, home: "" },
    ]) {
      expect(() => {
        messaging.connect("discord", input);
      }).toThrow(MessagingError);
    }
    rmSync(join(root, "profiles"), { recursive: true });
    expect(() => {
      messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });
    }).toThrow(/Deploy a config version first/);
    expect(restarts).toBe(0);
  });

  it("sends through the chat profile with the token kept off the command line, and hides it in errors", async () => {
    messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });
    await messaging.send("discord", "hello");
    expect(calls).toEqual([
      { args: ["-p", "planner", "send", "--quiet", "--to", `discord:${CHANNEL}`], input: "hello" },
    ]);
    expect(calls.some((call) => call.args.join(" ").includes(DISCORD_TOKEN))).toBe(false);

    fail = new Error(`401 for ${DISCORD_TOKEN}`);
    await expect(messaging.send("discord", "hello")).rejects.toThrow("401 for [token]");
  });

  it("uses the owner's direct chat on Telegram when no chat is given", () => {
    messaging.connect("telegram", {
      token: `123456789:${"A".repeat(35)}`,
      users: "987654321",
      home: "",
    });
    expect(messaging.states().find((state) => state.platform === "telegram")?.home).toBe(
      "987654321",
    );
  });

  it("posts notifications made after alerts were turned on, each once", async () => {
    messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });
    cards.notify("An old notice");
    messaging.setAlerts(true);
    cards.notify("Card 3 needs you: approve the merge", null, "escalation");

    await messaging.sendAlerts();
    await messaging.sendAlerts();

    expect(calls.map((call) => call.input)).toEqual([
      "Hephaestus: Card 3 needs you: approve the merge\nhttp://192.168.1.5:7700/",
    ]);

    messaging.setAlerts(false);
    cards.notify("Another");
    await messaging.sendAlerts();
    expect(calls).toHaveLength(1);
  });
});
