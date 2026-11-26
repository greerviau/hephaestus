import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/factory/cards.js";
import { Messaging, MessagingError, RestartError } from "../src/messaging.js";
import { openStore } from "../src/store.js";
import { workerAlerts, type WorkerAlertView } from "../src/workers/alerts.js";

const DISCORD_TOKEN = `${"M".repeat(24)}.${"G".repeat(6)}.${"x".repeat(27)}`;
const USER = "284102345871466496";
const CHANNEL = "1234567890123456789";

let root: string;
let db: Database;
let cards: CardStore;
let calls: { args: string[]; input: string | undefined }[];
let restarts: number;
let fail: Error | undefined;
let restartFails: boolean;
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
  restartFails = false;
  messaging = new Messaging({
    root,
    run: (args, options) => {
      calls.push({ args, input: options?.input });
      return fail === undefined ? Promise.resolve("") : Promise.reject(fail);
    },
    restartGateway: () => {
      restarts += 1;
      return restartFails ? Promise.reject(new Error("exit 1")) : Promise.resolve();
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
  it("connects Discord with a request channel that threads each message, and restarts the gateway", async () => {
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });

    expect(env()).toContain("HEPHAESTUS_MCP_TOKEN=keep-me");
    expect(env()).toContain(`DISCORD_BOT_TOKEN=${DISCORD_TOKEN}`);
    expect(env()).toContain(`DISCORD_ALLOWED_USERS=${USER}`);
    expect(env()).toContain(`DISCORD_HOME_CHANNEL=${CHANNEL}`);
    expect(env()).toContain(`DISCORD_FREE_RESPONSE_CHANNELS=${CHANNEL}`);
    expect(env()).toContain("DISCORD_FREE_RESPONSE_AUTO_THREAD=true");
    expect(env()).toContain("DISCORD_AUTO_THREAD=true");
    expect(statSync(join(root, "profiles", "planner", ".env")).mode & 0o777).toBe(0o600);
    expect(restarts).toBe(1);
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      connected: true,
      tokenEnd: DISCORD_TOKEN.slice(-4),
      users: [USER],
      home: CHANNEL,
    });
  });

  it("removes only the platform's settings on disconnect", async () => {
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });
    await messaging.disconnect("discord");
    expect(env()).toBe("HEPHAESTUS_MCP_TOKEN=keep-me\n");
    expect(restarts).toBe(2);
  });

  it("refuses a malformed token, a missing user, a Discord connection with no channel, and an unready factory", async () => {
    for (const input of [
      { token: "not-a-token", users: USER, home: CHANNEL },
      { token: DISCORD_TOKEN, users: "", home: CHANNEL },
      { token: DISCORD_TOKEN, users: "someone", home: CHANNEL },
      { token: DISCORD_TOKEN, users: USER, home: "" },
    ]) {
      await expect(messaging.connect("discord", input)).rejects.toThrow(MessagingError);
    }
    rmSync(join(root, "profiles"), { recursive: true });
    await expect(
      messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL }),
    ).rejects.toThrow(/Deploy a config version first/);
    expect(restarts).toBe(0);
  });

  it("says the settings were saved when the gateway does not restart", async () => {
    restartFails = true;
    await expect(
      messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL }),
    ).rejects.toThrow(RestartError);
    expect(env()).toContain(`DISCORD_BOT_TOKEN=${DISCORD_TOKEN}`);
  });

  it("restarts only the chat profile when no restart is given", async () => {
    const own = new Messaging({
      root,
      run: (args) => {
        calls.push({ args, input: undefined });
        return Promise.resolve("");
      },
      db,
      cards,
      dashboardUrl: () => "",
    });
    await own.restart();
    expect(calls[0]?.args).toEqual(["-p", "planner", "gateway", "restart", "--yes"]);
  });

  it("reads quoted and exported values, and removes exported keys on disconnect", async () => {
    writeFileSync(
      join(root, "profiles", "planner", ".env"),
      `export DISCORD_BOT_TOKEN="${DISCORD_TOKEN}"\nDISCORD_ALLOWED_USERS=${USER} # me\n`,
    );
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      connected: true,
      tokenEnd: DISCORD_TOKEN.slice(-4),
      users: [USER],
    });
    await messaging.disconnect("discord");
    expect(env()).toBe("");
  });

  it("sends through the chat profile with the token kept off the command line, and hides it in errors", async () => {
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });
    await messaging.send("discord", "hello");
    expect(calls).toEqual([
      { args: ["-p", "planner", "send", "--to", `discord:${CHANNEL}`], input: "hello" },
    ]);
    expect(calls.some((call) => call.args.join(" ").includes(DISCORD_TOKEN))).toBe(false);

    fail = new Error(`401 for ${DISCORD_TOKEN}`);
    await expect(messaging.send("discord", "hello")).rejects.toThrow("401 for [token]");
  });

  it("uses the owner's direct chat on Telegram when no chat is given", async () => {
    await messaging.connect("telegram", {
      token: `123456789:${"A".repeat(35)}`,
      users: "987654321",
      home: "",
    });
    expect(messaging.states().find((state) => state.platform === "telegram")?.home).toBe(
      "987654321",
    );
  });

  it("posts notifications made after alerts were turned on, each once", async () => {
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });
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

  it("sends one pass at a time, never backwards, and retries a failed alert", async () => {
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });
    messaging.setAlerts(true);
    cards.notify("first");
    cards.notify("second");
    const [one, two] = [messaging.sendAlerts(), messaging.sendAlerts()];
    await Promise.all([one, two]);
    expect(calls.map((call) => call.input?.split("\n")[0])).toEqual([
      "Hephaestus: first",
      "Hephaestus: second",
    ]);

    calls.length = 0;
    cards.notify("third");
    fail = new Error("Discord is down");
    await messaging.sendAlerts();
    fail = undefined;
    await messaging.sendAlerts();
    expect(calls.map((call) => call.input?.split("\n")[0])).toEqual([
      "Hephaestus: third",
      "Hephaestus: third",
    ]);
  });

  it("keeps text from outside from attaching a file", async () => {
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });
    messaging.setAlerts(true);
    cards.notify("Card 2 needs you: MEDIA:/home/x/.hephaestus/secrets.json", null, "escalation");
    await messaging.sendAlerts();
    expect(calls[0]?.input).not.toContain("MEDIA:/");
    expect(calls[0]?.input).toContain("MEDIA :/home");
  });

  it("retries only the platform that failed, gives up after three tries, and never moves the marker back", async () => {
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });
    await messaging.connect("telegram", {
      token: `123456789:${"A".repeat(35)}`,
      users: "987654321",
      home: "",
    });
    messaging.setAlerts(true);
    cards.notify("first");
    cards.notify("second");
    const real = calls;
    const failing = new Messaging({
      root,
      run: (args, options) => {
        real.push({ args, input: options?.input });
        return args.at(-1)?.startsWith("telegram:") === true
          ? Promise.reject(new Error("Forbidden: the user never started the bot"))
          : Promise.resolve("");
      },
      restartGateway: () => Promise.resolve(),
      db,
      cards,
      dashboardUrl: () => "",
    });
    calls.length = 0;
    for (let pass = 0; pass < 6; pass += 1) await failing.sendAlerts();
    const discord = calls.filter((call) => call.args.at(-1)?.startsWith("discord:") === true);
    expect(discord.map((call) => call.input?.split("\n")[0])).toEqual([
      "Hephaestus: first",
      "Hephaestus: second",
    ]);
    // Three tries each on Telegram, then both alerts are given up and the marker passes them.
    expect(calls.filter((call) => call.args.at(-1)?.startsWith("telegram:") === true)).toHaveLength(
      6,
    );

    // A marker another pass moved ahead while this alert was sending is not set back.
    const racing = new Messaging({
      root,
      run: () => {
        db.prepare(
          "INSERT OR REPLACE INTO meta (key, value) VALUES ('messaging_alerts_sent', '999')",
        ).run();
        return Promise.resolve("");
      },
      restartGateway: () => Promise.resolve(),
      db,
      cards,
      dashboardUrl: () => "",
    });
    cards.notify("third");
    await racing.sendAlerts();
    expect(
      (
        db.prepare("SELECT value FROM meta WHERE key = 'messaging_alerts_sent'").get() as {
          value: string;
        }
      ).value,
    ).toBe("999");
  });

  it("starts a stopped factory gateway instead of failing the restart, and only a stopped one", async () => {
    // What the Hermes runner rejects with: the output's last lines, and the exit code as the cause.
    const failure = new Error(
      "hermes -p planner gateway failed:   gateway.standalone: true in config.yaml,   then wait for the host gateway to rescan",
      { cause: Object.assign(new Error("Command failed"), { code: 78 }) },
    );
    let started = 0;
    let running = false;
    const own = new Messaging({
      root,
      run: () => Promise.reject(failure),
      gateway: {
        stopped: () => !running,
        start: () => {
          started += 1;
        },
      },
      db,
      cards,
      dashboardUrl: () => "",
    });
    await own.restart();
    expect(started).toBe(1);

    running = true;
    await expect(own.restart()).rejects.toThrow(/did not restart/);
    expect(started).toBe(1);

    const unstartable = new Messaging({
      root,
      run: () => Promise.reject(failure),
      gateway: {
        stopped: () => true,
        start: () => {
          throw new Error("unit not found");
        },
      },
      db,
      cards,
      dashboardUrl: () => "",
    });
    const unreadable = new Messaging({
      root,
      run: () => Promise.reject(failure),
      gateway: {
        stopped: () => {
          throw new Error("no user bus");
        },
        start: () => {
          started += 1;
        },
      },
      db,
      cards,
      dashboardUrl: () => "",
    });
    await expect(unreadable.restart()).rejects.toThrow(/did not restart/);
    expect(started).toBe(1);

    await expect(unstartable.restart()).rejects.toThrow(
      /not running and did not start: unit not found/,
    );
  });
});

describe("worker alerts", () => {
  it("asks once for a sign-in, across rechecks, and again only after the worker was ready", async () => {
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });
    let view: WorkerAlertView = {
      environmentId: "env-1",
      label: "mark-01",
      claude: "limited",
      codex: "signed-out",
      blocker: "Sign in Factory Codex.",
      ownerStep: true,
    };
    const own = new Messaging({
      root,
      run: (args, options) => {
        calls.push({ args, input: options?.input });
        return Promise.resolve("");
      },
      restartGateway: () => Promise.resolve(),
      db,
      cards,
      dashboardUrl: () => "",
      extraAlerts: () => workerAlerts([view]),
    });
    // Turned on directly, since turning alerts on marks what is already waiting as sent.
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('messaging_alerts', 'on')").run();
    calls.length = 0;
    const sends = (): number =>
      calls.filter((call) => call.input?.includes("Sign in Factory Codex") === true).length;

    await own.sendAlerts();
    for (let recheck = 0; recheck < 3; recheck += 1) {
      view = {
        ...view,
        claude: "checking",
        blocker: "Checking Factory Claude's sign-in.",
        ownerStep: false,
      };
      await own.sendAlerts();
      view = { ...view, claude: "limited", blocker: "Sign in Factory Codex." };
      await own.sendAlerts();
    }
    expect(sends()).toBe(1);

    // A periodic redeploy is Hephaestus's step, so it keeps the ask too.
    view = { ...view, blocker: "A deploy is running.", ownerStep: false };
    await own.sendAlerts();
    view = { ...view, blocker: "Sign in Factory Codex.", ownerStep: true };
    await own.sendAlerts();
    expect(sends()).toBe(1);

    view = { ...view, codex: "signed-in", blocker: undefined, ownerStep: false };
    await own.sendAlerts();
    view = { ...view, codex: "signed-out", blocker: "Sign in Factory Codex.", ownerStep: true };
    await own.sendAlerts();
    expect(sends()).toBe(2);
  });

  it("sends nothing for a worker busy with its own step, and asks a worker whose checks never ran", async () => {
    const base: WorkerAlertView = {
      environmentId: "env-1",
      label: "mark-01",
      claude: "signed-in",
      codex: "signed-in",
      blocker: "Sign in.",
      ownerStep: true,
    };
    const quiet = { key: "worker-env-1-busy", text: "", group: "worker-env-1", quiet: true };
    expect(workerAlerts([{ ...base, codex: "checking" }])).toEqual([quiet]);
    expect(workerAlerts([{ ...base, ownerStep: false }])).toEqual([quiet]);
    expect(workerAlerts([{ ...base, blocker: undefined }])).toEqual([]);
    const failed = {
      ...base,
      claude: "unknown" as const,
      codex: "unknown" as const,
      blocker: "The last deploy failed: x",
    };
    expect(workerAlerts([failed])).toEqual([
      {
        key: "worker-env-1-The last deploy failed: x",
        text: "mark-01: The last deploy failed: x",
        group: "worker-env-1",
      },
    ]);

    // Quiet items are never delivered.
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });
    const own = new Messaging({
      root,
      run: (args, options) => {
        calls.push({ args, input: options?.input });
        return Promise.resolve("");
      },
      restartGateway: () => Promise.resolve(),
      db,
      cards,
      dashboardUrl: () => "",
      extraAlerts: () => [quiet],
    });
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('messaging_alerts', 'on')").run();
    calls.length = 0;
    await own.sendAlerts();
    expect(calls).toEqual([]);
  });
});
