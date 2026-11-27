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
  it("connects Discord to answer only when mentioned, posts to its status channel, and restarts the gateway", async () => {
    await messaging.connect("discord", {
      token: DISCORD_TOKEN,
      users: USER,
      status: CHANNEL,
      reads: OTHER,
    });

    expect(env()).toContain("HEPHAESTUS_MCP_TOKEN=keep-me");
    expect(env()).toContain(`DISCORD_BOT_TOKEN=${DISCORD_TOKEN}`);
    expect(env()).toContain(`DISCORD_ALLOWED_USERS=${USER}`);
    expect(env()).toContain(`DISCORD_HOME_CHANNEL=${CHANNEL}\n`);
    // No channel takes a message as a request without a mention.
    expect(env()).toContain("DISCORD_REQUIRE_MENTION=true\n");
    expect(env()).not.toContain("FREE_RESPONSE");
    expect(env()).not.toContain("REQUEST_CHANNEL");
    expect(env()).toContain("DISCORD_AUTO_THREAD=true\n");
    expect(statSync(join(root, "profiles", "communicator", ".env")).mode & 0o777).toBe(0o600);
    expect(restarts).toBe(1);
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      connected: true,
      tokenEnd: DISCORD_TOKEN.slice(-4),
      users: [USER],
      request: undefined,
      status: CHANNEL,
      home: CHANNEL,
    });
    await messaging.send("discord", "status line");
    await messaging.send("discord", "alert line", "alerts");
    expect(calls.map((call) => call.args.at(-1))).toEqual([
      `discord:${CHANNEL}`,
      `discord:${CHANNEL}`,
    ]);
  });

  it("lets the bot read only the Discord channels it is given, and not the status channel", async () => {
    await messaging.connect("discord", {
      token: DISCORD_TOKEN,
      users: USER,
      status: CHANNEL,
      reads: `${OTHER}, ${THIRD}\n${OTHER}`,
    });
    // Hermes drops every message from a channel outside the list.
    expect(env()).toContain(`DISCORD_ALLOWED_CHANNELS=${OTHER},${THIRD}\n`);
    expect(env()).not.toContain("DISCORD_IGNORED_CHANNELS");
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      readAll: false,
      reads: [OTHER, THIRD],
    });
  });

  it("lets the bot read no Discord channel when the list is empty", async () => {
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, status: CHANNEL });
    // Hermes reads an empty list as every channel, so every channel is ignored instead.
    expect(env()).toContain("DISCORD_IGNORED_CHANNELS=*\n");
    expect(env()).not.toContain("DISCORD_ALLOWED_CHANNELS");
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      readAll: false,
      reads: [],
    });
  });

  it("lets the bot read every Discord channel only when that is chosen, still only when mentioned", async () => {
    await messaging.connect("discord", {
      token: DISCORD_TOKEN,
      users: USER,
      status: CHANNEL,
      reads: OTHER,
      readAll: true,
    });
    expect(env()).not.toContain("DISCORD_ALLOWED_CHANNELS");
    expect(env()).not.toContain("DISCORD_IGNORED_CHANNELS");
    expect(env()).toContain("DISCORD_REQUIRE_MENTION=true\n");
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      readAll: true,
      reads: [],
    });
    await messaging.setChannels("discord", { status: CHANNEL, reads: OTHER });
    expect(env()).toContain(`DISCORD_ALLOWED_CHANNELS=${OTHER}\n`);
  });

  it("ignores a request channel it is given for Discord", async () => {
    await messaging.connect("discord", {
      token: DISCORD_TOKEN,
      users: USER,
      home: THIRD,
      status: CHANNEL,
      reads: OTHER,
    });
    expect(env()).not.toContain(THIRD);
    expect(messaging.states().find((state) => state.platform === "discord")?.request).toBe(
      undefined,
    );
  });

  it("posts status to the status channel and alerts to the alerts channel, and gives Hermes the status channel", async () => {
    await messaging.connect("discord", {
      token: DISCORD_TOKEN,
      users: USER,
      status: OTHER,
      alerts: THIRD,
      reads: CHANNEL,
    });
    // Hermes posts its own notices, such as cron results and restarts, to its home channel.
    expect(env()).toContain(`DISCORD_HOME_CHANNEL=${OTHER}\n`);
    // Posting somewhere does not let the bot read there.
    expect(env()).toContain(`DISCORD_ALLOWED_CHANNELS=${CHANNEL}\n`);
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      status: OTHER,
      alerts: THIRD,
      home: THIRD,
    });
    expect(messaging.credentials("discord")).toMatchObject({
      status: OTHER,
      reads: [CHANNEL],
      readAll: false,
    });

    messaging.setAlerts(true);
    tasks.notify("Task 3 needs you", null, "escalation");
    await messaging.sendAlerts();
    await messaging.send("discord", "Hephaestus is connected.");
    expect(calls.map((call) => call.args.at(-1))).toEqual([`discord:${THIRD}`, `discord:${OTHER}`]);
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
          status: CHANNEL,
          ...input,
        }),
      ).rejects.toThrow(MessagingError);
    }
    expect(env()).toBe("HEPHAESTUS_MCP_TOKEN=keep-me\n");
    expect(restarts).toBe(0);
  });

  it("changes a connected bot's channels without its token, and refuses an unconnected one", async () => {
    await expect(messaging.setChannels("discord", { status: CHANNEL })).rejects.toThrow(
      /not connected/,
    );
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, status: CHANNEL });
    await messaging.setChannels("discord", { status: OTHER, reads: THIRD, alerts: CHANNEL });
    expect(env()).toContain(`DISCORD_BOT_TOKEN=${DISCORD_TOKEN}`);
    expect(env()).toContain(`DISCORD_ALLOWED_USERS=${USER}`);
    expect(env()).toContain(`DISCORD_ALLOWED_CHANNELS=${THIRD}\n`);
    expect(env()).not.toContain("DISCORD_IGNORED_CHANNELS");
    expect(env()).toContain(`DISCORD_HOME_CHANNEL=${OTHER}\n`);
    expect(restarts).toBe(2);
    await expect(messaging.setChannels("discord", { status: "" })).rejects.toThrow(/status posts/);
    await expect(messaging.setChannels("discord", { status: OTHER, reads: "x" })).rejects.toThrow(
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
      request: undefined,
      // Hermes reads every channel when it has no list.
      readAll: true,
      // Its home channel is where Hermes posted, so status keeps going there.
      status: CHANNEL,
      alerts: undefined,
      home: CHANNEL,
    });
  });

  it("loads a Discord bot saved with a request channel, drops it, and keeps its read list", () => {
    writeFileSync(
      join(root, "profiles", "communicator", ".env"),
      [
        "HEPHAESTUS_MCP_TOKEN=keep-me",
        `DISCORD_BOT_TOKEN=${DISCORD_TOKEN}`,
        `DISCORD_ALLOWED_USERS=${USER}`,
        `HEPHAESTUS_DISCORD_REQUEST_CHANNEL=${CHANNEL}`,
        "HEPHAESTUS_DISCORD_STATUS_CHANNEL=",
        `DISCORD_HOME_CHANNEL=${CHANNEL}`,
        `DISCORD_ALLOWED_CHANNELS=${CHANNEL},${OTHER}`,
        `DISCORD_FREE_RESPONSE_CHANNELS=${CHANNEL}`,
        "DISCORD_AUTO_THREAD=true",
        "DISCORD_FREE_RESPONSE_AUTO_THREAD=true",
        "",
      ].join("\n"),
    );
    const before = messaging.states().find((state) => state.platform === "discord");
    expect(before).toMatchObject({ request: undefined, readAll: false, reads: [OTHER] });

    expect(messaging.upgrade()).toBe(true);
    // The request channel is no longer read on its own, and no channel answers without a mention.
    expect(env()).toContain(`DISCORD_ALLOWED_CHANNELS=${OTHER}\n`);
    expect(env()).toContain("DISCORD_REQUIRE_MENTION=true\n");
    expect(env()).not.toContain("FREE_RESPONSE");
    expect(env()).not.toContain("REQUEST_CHANNEL");
    expect(env()).toContain("HEPHAESTUS_MCP_TOKEN=keep-me");
    expect(env()).toContain(`DISCORD_BOT_TOKEN=${DISCORD_TOKEN}`);
    // Posts still go where they went.
    expect(env()).toContain(`DISCORD_HOME_CHANNEL=${CHANNEL}\n`);
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      readAll: false,
      reads: [OTHER],
      status: CHANNEL,
      home: CHANNEL,
    });
    // Once upgraded, nothing is left to change.
    expect(messaging.upgrade()).toBe(false);
  });

  it("upgrades a Discord bot that read only its request channel to read no channel", () => {
    writeFileSync(
      join(root, "profiles", "communicator", ".env"),
      `DISCORD_BOT_TOKEN=${DISCORD_TOKEN}\nDISCORD_ALLOWED_USERS=${USER}\nHEPHAESTUS_DISCORD_REQUEST_CHANNEL=${CHANNEL}\nHEPHAESTUS_DISCORD_STATUS_CHANNEL=${OTHER}\nDISCORD_HOME_CHANNEL=${OTHER}\nDISCORD_ALLOWED_CHANNELS=${CHANNEL}\nDISCORD_FREE_RESPONSE_CHANNELS=${CHANNEL}\n`,
    );
    expect(messaging.upgrade()).toBe(true);
    expect(env()).not.toContain("DISCORD_ALLOWED_CHANNELS");
    expect(env()).toContain("DISCORD_IGNORED_CHANNELS=*\n");
    expect(env()).not.toContain(CHANNEL);
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      readAll: false,
      reads: [],
      status: OTHER,
    });
  });

  it("upgrades a Discord bot that read every channel to keep reading them all, only when mentioned", () => {
    writeFileSync(
      join(root, "profiles", "communicator", ".env"),
      `DISCORD_BOT_TOKEN=${DISCORD_TOKEN}\nDISCORD_ALLOWED_USERS=${USER}\nHEPHAESTUS_DISCORD_REQUEST_CHANNEL=${CHANNEL}\nDISCORD_HOME_CHANNEL=${CHANNEL}\nDISCORD_FREE_RESPONSE_CHANNELS=${CHANNEL}\n`,
    );
    expect(messaging.upgrade()).toBe(true);
    expect(env()).not.toContain("DISCORD_ALLOWED_CHANNELS");
    expect(env()).not.toContain("DISCORD_IGNORED_CHANNELS");
    expect(env()).not.toContain("FREE_RESPONSE");
    expect(env()).toContain("DISCORD_REQUIRE_MENTION=true\n");
    expect(messaging.states().find((state) => state.platform === "discord")).toMatchObject({
      readAll: true,
    });
  });

  it("upgrades nothing when no Discord bot has a request channel", async () => {
    expect(messaging.upgrade()).toBe(false);
    await messaging.connect("slack", {
      token: `xoxb-${"1".repeat(24)}`,
      appToken: `xapp-${"1".repeat(24)}`,
      users: "U0123ABCDE",
      home: "C0123ABCDEF",
    });
    const before = env();
    expect(messaging.upgrade()).toBe(false);
    expect(env()).toBe(before);
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
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, status: CHANNEL });
    await messaging.disconnect("discord");
    expect(env()).toBe("HEPHAESTUS_MCP_TOKEN=keep-me\n");
    expect(restarts).toBe(2);
  });

  it("refuses a malformed token, a missing user, a Discord connection with no channel, and an unready factory", async () => {
    for (const input of [
      { token: "not-a-token", users: USER, status: CHANNEL },
      { token: DISCORD_TOKEN, users: "", status: CHANNEL },
      { token: DISCORD_TOKEN, users: "someone", status: CHANNEL },
      { token: DISCORD_TOKEN, users: USER, status: "" },
    ]) {
      await expect(messaging.connect("discord", input)).rejects.toThrow(MessagingError);
    }
    rmSync(join(root, "profiles"), { recursive: true });
    await expect(
      messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, status: CHANNEL }),
    ).rejects.toThrow(/Deploy a config version first/);
    expect(restarts).toBe(0);
  });

  it("says the settings were saved when the gateway does not restart", async () => {
    restartFails = true;
    await expect(
      messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, status: CHANNEL }),
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
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, status: CHANNEL });
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
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, status: CHANNEL });
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
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, status: CHANNEL });
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
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, status: CHANNEL });
    messaging.setAlerts(true);
    tasks.notify("Task 2 needs you: MEDIA:/home/x/.hephaestus/secrets.json", null, "escalation");
    await messaging.sendAlerts();
    expect(calls[0]?.input).not.toContain("MEDIA:/");
    expect(calls[0]?.input).toContain("MEDIA :/home");
  });

  it("retries only the platform that failed, gives up after three tries, and never moves the marker back", async () => {
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, status: CHANNEL });
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
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, status: CHANNEL });
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
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, status: CHANNEL });
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

const SLACK_BOT = `xoxb-1234567890-1234567890123-${"a".repeat(24)}`;
const SLACK_APP = `xapp-1-A0123456789-1234567890123-${"b".repeat(64)}`;
const SLACK_USER = "U0123ABCDEF";
const SLACK_CHANNEL = "C0123ABCDEF";
const SLACK_OTHER = "C0456GHIJKL";
const SLACK_THIRD = "G0789MNOPQR";

describe("Messaging on Slack", () => {
  it("connects Slack with its bot and app tokens, answers in the request channel, and reads only it", async () => {
    await messaging.connect("slack", {
      token: SLACK_BOT,
      appToken: SLACK_APP,
      users: SLACK_USER,
      home: SLACK_CHANNEL,
    });

    expect(env()).toContain("HEPHAESTUS_MCP_TOKEN=keep-me");
    expect(env()).toContain(`SLACK_BOT_TOKEN=${SLACK_BOT}\n`);
    expect(env()).toContain(`SLACK_APP_TOKEN=${SLACK_APP}\n`);
    expect(env()).toContain(`SLACK_ALLOWED_USERS=${SLACK_USER}\n`);
    expect(env()).toContain(`SLACK_HOME_CHANNEL=${SLACK_CHANNEL}\n`);
    expect(env()).toContain(`SLACK_FREE_RESPONSE_CHANNELS=${SLACK_CHANNEL}\n`);
    expect(env()).toContain(`SLACK_ALLOWED_CHANNELS=${SLACK_CHANNEL}\n`);
    expect(statSync(join(root, "profiles", "communicator", ".env")).mode & 0o777).toBe(0o600);
    expect(restarts).toBe(1);
    expect(messaging.states().find((state) => state.platform === "slack")).toMatchObject({
      label: "Slack",
      connected: true,
      tokenEnd: SLACK_BOT.slice(-4),
      users: [SLACK_USER],
      request: SLACK_CHANNEL,
      readAll: false,
      home: SLACK_CHANNEL,
    });
    expect(messaging.credentials("slack")).toMatchObject({
      token: SLACK_BOT,
      request: SLACK_CHANNEL,
    });
  });

  it("reads the listed channels, posts status and alerts apart, and keeps the tokens when channels change", async () => {
    await messaging.connect("slack", {
      token: SLACK_BOT,
      appToken: SLACK_APP,
      users: SLACK_USER,
      home: SLACK_CHANNEL,
      reads: `${SLACK_OTHER}, ${SLACK_THIRD}`,
      status: SLACK_OTHER,
      alerts: SLACK_THIRD,
    });
    expect(env()).toContain(
      `SLACK_ALLOWED_CHANNELS=${SLACK_CHANNEL},${SLACK_OTHER},${SLACK_THIRD}\n`,
    );
    expect(env()).toContain(`SLACK_HOME_CHANNEL=${SLACK_OTHER}\n`);
    await messaging.send("slack", "status line");
    await messaging.send("slack", "alert line", "alerts");
    expect(calls.map((call) => call.args.at(-1))).toEqual([
      `slack:${SLACK_OTHER}`,
      `slack:${SLACK_THIRD}`,
    ]);

    await messaging.setChannels("slack", { home: SLACK_CHANNEL, readAll: true });
    expect(env()).not.toContain("SLACK_ALLOWED_CHANNELS");
    expect(env()).toContain(`SLACK_BOT_TOKEN=${SLACK_BOT}\n`);
    expect(env()).toContain(`SLACK_APP_TOKEN=${SLACK_APP}\n`);
    expect(messaging.states().find((state) => state.platform === "slack")?.readAll).toBe(true);
  });

  it("refuses a wrong bot or app token, user, or channel, and changes nothing", async () => {
    const good = { token: SLACK_BOT, appToken: SLACK_APP, users: SLACK_USER, home: SLACK_CHANNEL };
    for (const input of [
      { ...good, token: SLACK_APP },
      { ...good, token: DISCORD_TOKEN },
      { ...good, appToken: "" },
      { ...good, appToken: SLACK_BOT },
      { ...good, users: USER },
      { ...good, users: "" },
      { ...good, home: "" },
      { ...good, home: "general" },
      { ...good, reads: "#random" },
      { ...good, status: CHANNEL },
    ]) {
      await expect(messaging.connect("slack", input)).rejects.toThrow(MessagingError);
    }
    await expect(messaging.connect("slack", { ...good, appToken: "" })).rejects.toThrow(
      /Slack app-level token/,
    );
    await expect(messaging.connect("slack", { ...good, users: USER })).rejects.toThrow(
      /Slack member ID/,
    );
    expect(env()).toBe("HEPHAESTUS_MCP_TOKEN=keep-me\n");
    expect(restarts).toBe(0);
  });

  it("removes only the Slack settings on disconnect, and leaves Discord connected", async () => {
    await messaging.connect("discord", { token: DISCORD_TOKEN, users: USER, status: CHANNEL });
    const discord = env();
    await messaging.connect("slack", {
      token: SLACK_BOT,
      appToken: SLACK_APP,
      users: SLACK_USER,
      home: SLACK_CHANNEL,
    });
    await messaging.disconnect("slack");
    expect(env()).toBe(discord);
    expect(messaging.states().find((state) => state.platform === "slack")?.connected).toBe(false);
    expect(messaging.states().find((state) => state.platform === "discord")?.connected).toBe(true);
  });

  it("posts to a Slack thread and hides both tokens in errors", async () => {
    await messaging.connect("slack", {
      token: SLACK_BOT,
      appToken: SLACK_APP,
      users: SLACK_USER,
      home: SLACK_CHANNEL,
    });
    await messaging.sendTo("slack", `${SLACK_CHANNEL}:1712345678.000100`, "in the thread");
    expect(calls.at(-1)).toEqual({
      args: ["-p", "communicator", "send", "--to", `slack:${SLACK_CHANNEL}:1712345678.000100`],
      input: "in the thread",
    });
    await expect(messaging.sendTo("slack", `${SLACK_CHANNEL}:x y`, "no")).rejects.toThrow(
      /not a chat ID/,
    );
    expect(calls.some((call) => call.args.join(" ").includes("xox"))).toBe(false);

    fail = new Error(`invalid_auth for ${SLACK_BOT} and ${SLACK_APP}`);
    await expect(messaging.send("slack", "hello")).rejects.toThrow(
      "invalid_auth for [token] and [token]",
    );
  });
});
