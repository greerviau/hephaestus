import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "../src/factory/tasks.js";
import { Messaging, MessagingError, RestartError, proposalAlerts } from "../src/messaging.js";
import { openStore } from "../src/store.js";
import { workerAlerts, type WorkerAlertView } from "../src/workers/alerts.js";

const DISCORD_TOKEN = `${"M".repeat(24)}.${"G".repeat(6)}.${"x".repeat(27)}`;
const USER = "284102345871466496";
const CHANNEL = "1234567890123456789";
const OTHER = "2234567890123456789";
const THIRD = "3234567890123456789";

let root: string;
let db: Database;
let tasks: TaskStore;
let calls: { args: string[]; input: string | undefined }[];
let restarts: number;
let fail: Error | undefined;
let restartFails: boolean;
let messaging: Messaging;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hephaestus-messaging-"));
  mkdirSync(join(root, "profiles", "communicator"), { recursive: true });
  writeFileSync(join(root, "profiles", "communicator", ".env"), "HEPHAESTUS_MCP_TOKEN=keep-me\n");
  db = openStore(":memory:");
  tasks = new TaskStore(db);
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
    tasks,
    dashboardUrl: () => "http://192.168.1.5:7700/",
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  db.close();
});

function env(): string {
  return readFileSync(join(root, "profiles", "communicator", ".env"), "utf8");
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
    expect(statSync(join(root, "profiles", "communicator", ".env")).mode & 0o777).toBe(0o600);
    expect(restarts).toBe(1);
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      connected: true,
      tokenEnd: DISCORD_TOKEN.slice(-4),
      users: [USER],
      home: CHANNEL,
    });
  });

  it("lets the bot read only the request channel by default, and posts everything there", async () => {
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });
    expect(env()).toContain(`DISCORD_ALLOWED_CHANNELS=${CHANNEL}\n`);
    expect(env()).toContain(`DISCORD_HOME_CHANNEL=${CHANNEL}\n`);
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      request: CHANNEL,
      readAll: false,
      reads: [],
      status: undefined,
      alerts: undefined,
      home: CHANNEL,
    });
    await messaging.send("discord", "status line");
    await messaging.send("discord", "alert line", "alerts");
    expect(calls.map((call) => call.args.at(-1))).toEqual([
      `discord:${CHANNEL}`,
      `discord:${CHANNEL}`,
    ]);
  });

  it("lets the bot read the channels it is given besides the request channel", async () => {
    await messaging.connect("discord", {
      token: DISCORD_TOKEN,
      users: USER,
      home: CHANNEL,
      reads: `${OTHER}, ${THIRD}\n${OTHER} ${CHANNEL}`,
    });
    expect(env()).toContain(`DISCORD_ALLOWED_CHANNELS=${CHANNEL},${OTHER},${THIRD}\n`);
    // Only the request channel answers without an @mention.
    expect(env()).toContain(`DISCORD_FREE_RESPONSE_CHANNELS=${CHANNEL}\n`);
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      readAll: false,
      reads: [OTHER, THIRD],
    });
  });

  it("lets the bot read every channel only when that is turned on", async () => {
    await messaging.connect("discord", {
      token: DISCORD_TOKEN,
      users: USER,
      home: CHANNEL,
      reads: OTHER,
      readAll: true,
    });
    expect(env()).not.toContain("DISCORD_ALLOWED_CHANNELS");
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      readAll: true,
      reads: [],
    });
  });

  it("posts status to the status channel and alerts to the alerts channel, and gives Hermes the status channel", async () => {
    await messaging.connect("discord", {
      token: DISCORD_TOKEN,
      users: USER,
      home: CHANNEL,
      status: OTHER,
      alerts: THIRD,
    });
    // Hermes posts its own notices, such as cron results and restarts, to its home channel.
    expect(env()).toContain(`DISCORD_HOME_CHANNEL=${OTHER}\n`);
    expect(env()).toContain(`DISCORD_FREE_RESPONSE_CHANNELS=${CHANNEL}\n`);
    // Posting somewhere does not let the bot read there.
    expect(env()).toContain(`DISCORD_ALLOWED_CHANNELS=${CHANNEL}\n`);
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      request: CHANNEL,
      status: OTHER,
      alerts: THIRD,
      home: THIRD,
    });
    expect(messaging.credentials("discord")?.request).toBe(CHANNEL);

    messaging.setAlerts(true);
    tasks.notify("Task 3 needs you", null, "escalation");
    await messaging.sendAlerts();
    await messaging.send("discord", "Hephaestus is connected.");
    expect(calls.map((call) => call.args.at(-1))).toEqual([`discord:${THIRD}`, `discord:${OTHER}`]);
  });

  it("sends alerts to the status channel when no alerts channel is set", async () => {
    await messaging.connect("discord", {
      token: DISCORD_TOKEN,
      users: USER,
      home: CHANNEL,
      status: OTHER,
    });
    expect(messaging.states().find((state) => state.platform === "discord")?.home).toBe(OTHER);
    await messaging.send("discord", "alert", "alerts");
    expect(calls.at(-1)?.args.at(-1)).toBe(`discord:${OTHER}`);
  });

  it("refuses channel IDs that are not IDs, and changes nothing", async () => {
    for (const input of [
      { reads: "general" },
      { reads: `${OTHER},#random` },
      {
        reads: Array.from({ length: 51 }, (_, i) => `1234567890123456${String(100 + i)}`).join(","),
      },
      { status: "status-room" },
      { alerts: "12" },
    ]) {
      await expect(
        messaging.connect("discord", {
          token: DISCORD_TOKEN,
          users: USER,
          home: CHANNEL,
          ...input,
        }),
      ).rejects.toThrow(MessagingError);
    }
    expect(env()).toBe("HEPHAESTUS_MCP_TOKEN=keep-me\n");
    expect(restarts).toBe(0);
  });

  it("changes a connected bot's channels without its token, and refuses an unconnected one", async () => {
    await expect(messaging.setChannels("discord", { home: CHANNEL })).rejects.toThrow(
      /not connected/,
    );
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });
    await messaging.setChannels("discord", { home: OTHER, reads: THIRD, alerts: CHANNEL });
    expect(env()).toContain(`DISCORD_BOT_TOKEN=${DISCORD_TOKEN}`);
    expect(env()).toContain(`DISCORD_ALLOWED_USERS=${USER}`);
    expect(env()).toContain(`DISCORD_FREE_RESPONSE_CHANNELS=${OTHER}\n`);
    expect(env()).toContain(`DISCORD_ALLOWED_CHANNELS=${OTHER},${THIRD}\n`);
    expect(env()).toContain(`DISCORD_HOME_CHANNEL=${OTHER}\n`);
    expect(restarts).toBe(2);
    await expect(messaging.setChannels("discord", { home: "" })).rejects.toThrow(MessagingError);
    await expect(messaging.setChannels("discord", { home: OTHER, reads: "x" })).rejects.toThrow(
      MessagingError,
    );
    expect(restarts).toBe(2);
  });

  it("reads a bot connected before channel settings existed as it was saved", () => {
    writeFileSync(
      join(root, "profiles", "communicator", ".env"),
      `DISCORD_BOT_TOKEN=${DISCORD_TOKEN}\nDISCORD_ALLOWED_USERS=${USER}\nDISCORD_HOME_CHANNEL=${CHANNEL}\nDISCORD_FREE_RESPONSE_CHANNELS=${CHANNEL}\n`,
    );
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      connected: true,
      request: CHANNEL,
      // Hermes reads every channel when it has no list.
      readAll: true,
      status: undefined,
      alerts: undefined,
      home: CHANNEL,
    });
    expect(messaging.credentials("discord")?.request).toBe(CHANNEL);
  });

  it("keeps Telegram groups to the chats it is given, and leaves the direct chat open", async () => {
    await messaging.connect("telegram", {
      token: `123456789:${"A".repeat(35)}`,
      users: "987654321",
      home: "",
    });
    // Hermes never filters direct chats; a list of only the owner's chat keeps every group out.
    expect(env()).toContain("TELEGRAM_ALLOWED_CHATS=987654321\n");
    expect(messaging.states().find((state) => state.platform === "telegram")).toMatchObject({
      readAll: false,
      reads: [],
    });
    await messaging.setChannels("telegram", { home: "", status: "-1009999" });
    expect(messaging.states().find((state) => state.platform === "telegram")).toMatchObject({
      request: undefined,
      status: "-1009999",
    });
    expect(env()).toContain("TELEGRAM_HOME_CHANNEL=-1009999\n");
    await messaging.setChannels("telegram", { home: "-1001234", reads: "-1005678" });
    expect(env()).toContain("TELEGRAM_ALLOWED_CHATS=-1001234,-1005678\n");
    expect(messaging.states().find((state) => state.platform === "telegram")).toMatchObject({
      request: "-1001234",
      reads: ["-1005678"],
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
      tasks,
      dashboardUrl: () => "",
    });
    await own.restart();
    expect(calls[0]?.args).toEqual(["-p", "communicator", "gateway", "restart", "--yes"]);
  });

  it("reads quoted and exported values, and removes exported keys on disconnect", async () => {
    writeFileSync(
      join(root, "profiles", "communicator", ".env"),
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
      { args: ["-p", "communicator", "send", "--to", `discord:${CHANNEL}`], input: "hello" },
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
    tasks.notify("An old notice");
    messaging.setAlerts(true);
    tasks.notify("Task 3 needs you: approve the merge", null, "escalation");

    await messaging.sendAlerts();
    await messaging.sendAlerts();

    expect(calls.map((call) => call.input)).toEqual([
      "Hephaestus: Task 3 needs you: approve the merge\nhttp://192.168.1.5:7700/",
    ]);

    messaging.setAlerts(false);
    tasks.notify("Another");
    await messaging.sendAlerts();
    expect(calls).toHaveLength(1);
  });

  it("sends one pass at a time, never backwards, and retries a failed alert", async () => {
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, home: CHANNEL });
    messaging.setAlerts(true);
    tasks.notify("first");
    tasks.notify("second");
    const [one, two] = [messaging.sendAlerts(), messaging.sendAlerts()];
    await Promise.all([one, two]);
    expect(calls.map((call) => call.input?.split("\n")[0])).toEqual([
      "Hephaestus: first",
      "Hephaestus: second",
    ]);

    calls.length = 0;
    tasks.notify("third");
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
    tasks.notify("Task 2 needs you: MEDIA:/home/x/.hephaestus/secrets.json", null, "escalation");
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
    tasks.notify("first");
    tasks.notify("second");
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
      tasks,
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
      tasks,
      dashboardUrl: () => "",
    });
    tasks.notify("third");
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
      "hermes -p communicator gateway failed:   gateway.standalone: true in config.yaml,   then wait for the host gateway to rescan",
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
      tasks,
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
      tasks,
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
      tasks,
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
      tasks,
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
    // Nothing else was sent either, such as the deploy or the check.
    expect(calls).toHaveLength(1);

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
      tasks,
      dashboardUrl: () => "",
      extraAlerts: () => [quiet],
    });
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('messaging_alerts', 'on')").run();
    calls.length = 0;
    await own.sendAlerts();
    expect(calls).toEqual([]);
  });
});

describe("proposalAlerts", () => {
  it("asks for approval of each waiting proposal on the Proposals page, without naming a role", () => {
    const alerts = proposalAlerts([
      { id: 4, author: "improver", state: "draft" },
      { id: 5, author: "improver", state: "rejected" },
      { id: 6, author: "owner", state: "draft" },
      { id: 7, author: "hephaestus", state: "draft" },
    ]);

    expect(alerts).toEqual([
      {
        key: "proposal-4",
        text: "Config version 4 is proposed and waits for your approval on Proposals.",
      },
      {
        key: "proposal-7",
        text: "Config version 7 is proposed and waits for your approval on Proposals.",
      },
    ]);
    expect(alerts[0]?.text).not.toMatch(/communicator|lead|improver/i);
  });
});
