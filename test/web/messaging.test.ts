import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Messaging } from "../../src/messaging.js";
import { startDashboard, type Dashboard } from "./dashboard.js";

const TOKEN = `${"M".repeat(24)}.${"G".repeat(6)}.${"x".repeat(27)}`;

let dashboard: Dashboard | undefined;
let root: string | undefined;

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function withMessaging(
  sent: string[] = [],
  restart: () => Promise<void> = () => Promise.resolve(),
): Promise<Dashboard> {
  root = mkdtempSync(join(tmpdir(), "hephaestus-messaging-page-"));
  mkdirSync(join(root, "profiles", "communicator"), { recursive: true });
  const holder: { dashboard?: Dashboard } = {};
  const home = root;
  const messaging = new Messaging({
    root: home,
    run: (_args, options) => {
      sent.push(options?.input ?? "");
      return Promise.resolve("");
    },
    restartGateway: restart,
    get db() {
      if (holder.dashboard === undefined) throw new Error("not started");
      return holder.dashboard.h.db;
    },
    get tasks() {
      if (holder.dashboard === undefined) throw new Error("not started");
      return holder.dashboard.h.tasks;
    },
    dashboardUrl: () => "http://host:7700/",
  });
  holder.dashboard = await startDashboard({ messaging });
  return holder.dashboard;
}

const DISCORD = {
  token: TOKEN,
  users: "284102345871466496",
  status: "1234567890123456789",
  read_all: "0",
  reads: "2234567890123456789",
};

describe("Chat page", () => {
  it("lists Discord and Telegram with a link to connect each, and never names the factory's roles", async () => {
    dashboard = await withMessaging();
    const { status, html } = await dashboard.get("/chat");
    expect(status).toBe(200);
    expect(html).toContain('<h1 id="page-title">Chat</h1>');
    expect(html).toContain('href="/chat/connect/discord"');
    expect(html).toContain('href="/chat/connect/telegram"');
    expect(html).toContain('href="/chat/connect/slack"');
    expect(html).toContain("Not connected");
    expect(html).toContain("Connect a platform first.");
    expect(html).not.toContain('<form method="post" action="/chat/discord/connect"');
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toMatch(/communicator|lead|improver/i);
    expect((await dashboard.get("/messaging")).status).toBe(404);
  });

  it.each([
    ["telegram", "Connect Telegram", "Request chat ID (optional)", false],
    ["slack", "Connect Slack", "Request channel ID", true],
  ] as const)(
    "gives %s a connect page of its own with the steps and the form",
    async (platform, title, channelLabel, channelRequired) => {
      dashboard = await withMessaging();
      const { status, html } = await dashboard.get(`/chat/connect/${platform}`);
      expect(status).toBe(200);
      expect(html).toContain(`<h1 id="page-title">${title}</h1>`);
      expect(html).toContain('<a href="/chat">Chat</a>');
      expect(html).toContain(`<form class="form" method="post" action="/chat/${platform}/connect"`);
      expect(html).toContain('<input type="password" id="token" name="token"');
      // Only Slack needs a second, app-level token, for Socket Mode.
      expect(html.includes('<input type="password" id="app_token" name="app_token"')).toBe(
        platform === "slack",
      );
      expect(html).toContain(`>${channelLabel}</label>`);
      expect(/<input type="text" id="channel" name="channel"[^>]* required/.test(html)).toBe(
        channelRequired,
      );
      for (const name of ["reads", "status", "alerts"]) {
        expect(html).toMatch(new RegExp(`name="${name}"(?![^>]* required)[^>]*>`));
      }
      expect(html).toContain('<input type="checkbox" name="read_all" value="1">');
      expect(html).toContain("Where to find these");
      expect(html.match(/<ol class="steps">.*?<\/ol>/s)?.[0].match(/<li>/g)).toHaveLength(3);
      expect(html).not.toContain('http-equiv="refresh"');
      expect(html).not.toMatch(/communicator|lead|improver/i);
    },
  );

  it("gives Discord no request channel, and one choice between listed channels and every channel", async () => {
    dashboard = await withMessaging();
    const { status, html } = await dashboard.get("/chat/connect/discord");
    expect(status).toBe(200);
    expect(html).toContain('<h1 id="page-title">Connect Discord</h1>');
    expect(html).toContain('<form class="form" method="post" action="/chat/discord/connect"');
    expect(html).not.toMatch(/request channel/i);
    expect(html).not.toContain('name="channel"');
    expect(html).not.toContain('type="checkbox"');
    // The status channel is where posts go, so it is the one channel Discord needs.
    expect(html).toMatch(/<input type="text" id="status" name="status"[^>]* required/);
    expect(html).toMatch(/name="alerts"(?![^>]* required)[^>]*>/);
    // Two ways to let the bot read, one at a time; the list hides while every channel is chosen.
    expect(html.match(/<input type="radio" name="read_all"/g)).toHaveLength(2);
    expect(html).toContain('<input type="radio" name="read_all" value="0" checked>');
    expect(html).toContain('<input type="radio" name="read_all" value="1">');
    expect(html).toMatch(/<div class="access-list">.*?name="reads"(?![^>]* required)/s);
    expect(html).toContain("only when you mention it");
    expect(html.match(/<ol class="steps">.*?<\/ol>/s)?.[0].match(/<li>/g)).toHaveLength(3);
    expect(html).not.toMatch(/communicator|lead|improver/i);
  });

  it("connects, shows the stored IDs, sends a test message, turns alerts on, and never shows the token", async () => {
    const sent: string[] = [];
    dashboard = await withMessaging(sent);
    const connected = await dashboard.post("/chat/discord/connect", DISCORD);
    expect(connected.headers.get("location")).toBe("/chat?notice=connected");
    const page = (await dashboard.get("/chat?notice=connected")).html;
    expect(page).toContain("Connected");
    expect(page).toContain(`Bot token ending <code>${TOKEN.slice(-4)}</code>`);
    expect(page).toContain("answers 284102345871466496");
    expect(page).toContain("reads channel 2234567890123456789 when mentioned");
    expect(page).toContain("status goes to channel 1234567890123456789");
    expect(page).toContain("alerts go to channel 1234567890123456789");
    expect(page).not.toContain(TOKEN);
    expect(page).toContain('action="/chat/discord/test"');
    expect(page).toContain("Send test message");
    expect(page).not.toContain('href="/chat/connect/discord"');
    expect(page).toContain('href="/chat/connect/telegram"');
    expect(page).not.toMatch(/communicator|lead|improver/i);

    await dashboard.post("/chat/discord/test");
    // The status channel takes no request, so the test says how to ask.
    expect(sent).toEqual(["Hephaestus is connected. Mention the bot to ask for work."]);
    const alerts = await dashboard.post("/chat/alerts/on");
    expect(alerts.headers.get("location")).toBe("/chat?notice=alerts-on");
    const on = (await dashboard.get("/chat")).html;
    expect(on).toContain('action="/chat/alerts/off"');
    expect(on).toContain("Turn alerts off");
    expect(on).toMatch(/class="st t-done">.*?On<\/span>/);
  });

  it("connects with status and alerts channels and a read list, and shows where each goes", async () => {
    const sent: string[] = [];
    dashboard = await withMessaging(sent);
    await dashboard.post("/chat/discord/connect", {
      ...DISCORD,
      reads: "2234567890123456789, 5234567890123456789",
      status: "3234567890123456789",
      alerts: "4234567890123456789",
    });
    const page = (await dashboard.get("/chat")).html;
    expect(page).toContain(
      "reads channels 2234567890123456789, 5234567890123456789 when mentioned",
    );
    expect(page).toContain("status goes to channel 3234567890123456789");
    expect(page).toContain("alerts go to channel 4234567890123456789");
    expect(page).toContain('href="/chat/discord/channels"');
  });

  it("changes a connected bot's channels on a page of its own, and keeps what was typed when refused", async () => {
    dashboard = await withMessaging();
    const unconnected = await fetch(`${dashboard.base}/chat/discord/channels`, {
      headers: { cookie: dashboard.cookie },
      redirect: "manual",
    });
    expect(unconnected.headers.get("location")).toBe("/chat");
    await dashboard.post("/chat/discord/connect", DISCORD);

    const form = await dashboard.get("/chat/discord/channels");
    expect(form.status).toBe(200);
    expect(form.html).toContain('<h1 id="page-title">Discord channels</h1>');
    expect(form.html).toContain('action="/chat/discord/channels"');
    expect(form.html).toContain('name="status" value="1234567890123456789"');
    expect(form.html).toContain("2234567890123456789</textarea>");
    expect(form.html).not.toContain('name="token"');
    expect(form.html).not.toContain(TOKEN);
    expect(form.html).not.toMatch(/communicator|lead|improver/i);

    const refused = await dashboard.post("/chat/discord/channels", {
      status: "1234567890123456789",
      read_all: "0",
      reads: "general",
    });
    const html = await refused.text();
    expect(refused.status).toBe(400);
    expect(html).toContain("Discord: not changed");
    expect(html).toContain("general is not a Discord channel ID");
    expect(html).toContain("general</textarea>");

    const saved = await dashboard.post("/chat/discord/channels", {
      status: "1234567890123456789",
      read_all: "1",
      reads: "2234567890123456789",
    });
    expect(saved.headers.get("location")).toBe("/chat?notice=channels");
    const page = (await dashboard.get("/chat?notice=channels")).html;
    expect(page).toContain("Channels saved");
    expect(page).toContain("reads every channel it can see when mentioned");
    expect((await dashboard.get("/chat/discord/channels")).html).toContain(
      '<input type="radio" name="read_all" value="1" checked>',
    );

    await dashboard.post("/chat/discord/channels", {
      status: "1234567890123456789",
      read_all: "0",
      reads: "",
    });
    expect((await dashboard.get("/chat")).html).toContain("reads no channel");
  });

  it("asks before it disconnects, from a menu", async () => {
    dashboard = await withMessaging();
    await dashboard.post("/chat/discord/connect", DISCORD);
    const { html } = await dashboard.get("/chat");
    expect(html).toMatch(/<details class="menu"[^>]*>.*?popovertarget="disconnect-discord"/s);
    expect(html).toMatch(
      /id="disconnect-discord" popover role="dialog"[^>]*><form method="post" action="\/chat\/discord\/disconnect">/,
    );
    expect(html).toContain("Remove the Discord bot's credentials from this host?");

    const response = await dashboard.post("/chat/discord/disconnect");
    expect(response.headers.get("location")).toBe("/chat?notice=disconnected");
    expect((await dashboard.get("/chat")).html).toContain('href="/chat/connect/discord"');
  });

  it("sends a connected platform's connect page back to Chat", async () => {
    dashboard = await withMessaging();
    await dashboard.post("/chat/discord/connect", DISCORD);
    const response = await fetch(`${dashboard.base}/chat/connect/discord`, {
      headers: { cookie: dashboard.cookie },
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/chat");
  });

  it("says what to fix on the connect page when the token is malformed", async () => {
    dashboard = await withMessaging();
    const response = await dashboard.post("/chat/discord/connect", { ...DISCORD, token: "oops" });
    const html = await response.text();
    expect(response.status).toBe(400);
    expect(html).toContain("Discord: not changed");
    expect(html).toContain("does not look like a Discord bot token");
    expect(html).toContain('<h1 id="page-title">Connect Discord</h1>');
    expect(html).toContain('action="/chat/discord/connect"');
    expect(html).toContain('name="users" value="284102345871466496"');
    expect(html).not.toContain("oops");
  });

  it("says a deploy comes first when the chat is not set up yet", async () => {
    dashboard = await withMessaging();
    if (root === undefined) throw new Error("no root");
    rmSync(join(root, "profiles"), { recursive: true });
    for (const path of ["/chat", "/chat/connect/discord"]) {
      const { html } = await dashboard.get(path);
      expect(html).toContain("Not ready yet");
      expect(html).toContain('<a href="/config/versions">Config</a>');
      expect(html).not.toContain('<form class="form"');
      expect(html).not.toMatch(/communicator|lead|improver/i);
    }
  });

  it("says the settings were saved when the restart fails, and retries it", async () => {
    let restarts = 0;
    let fail = true;
    dashboard = await withMessaging([], () => {
      restarts += 1;
      return fail ? Promise.reject(new Error("exit 1")) : Promise.resolve();
    });
    const response = await dashboard.post("/chat/discord/connect", DISCORD);
    const html = await response.text();
    expect(response.status).toBe(400);
    expect(html).toContain('<h1 id="page-title">Chat</h1>');
    expect(html).toContain("Saved, but not reconnected");
    expect(html).not.toContain("not changed");
    expect(html).toContain('action="/chat/restart"');

    fail = false;
    const retried = await dashboard.post("/chat/restart");
    expect(retried.headers.get("location")).toBe("/chat?notice=restarted");
    expect(restarts).toBe(2);
  });
});

const SLACK_BOT = `xoxb-1234567890-1234567890123-${"a".repeat(24)}`;
const SLACK_APP = `xapp-1-A0123456789-1234567890123-${"b".repeat(64)}`;
const SLACK = {
  token: SLACK_BOT,
  app_token: SLACK_APP,
  users: "U0123ABCDEF",
  channel: "C0123ABCDEF",
};

describe("Chat page, Slack", () => {
  it("connects Slack beside Discord, shows its IDs, sends a test, and never shows either token", async () => {
    const sent: string[] = [];
    dashboard = await withMessaging(sent);
    await dashboard.post("/chat/discord/connect", DISCORD);
    const connected = await dashboard.post("/chat/slack/connect", {
      ...SLACK,
      reads: "C0456GHIJKL",
      alerts: "G0789MNOPQR",
    });
    expect(connected.headers.get("location")).toBe("/chat?notice=connected");
    const page = (await dashboard.get("/chat")).html;
    expect(page).toContain(`Bot token ending <code>${SLACK_BOT.slice(-4)}</code>`);
    expect(page).toContain("answers U0123ABCDEF");
    expect(page).toContain("reads channel C0123ABCDEF, C0456GHIJKL");
    expect(page).toContain("status goes to channel C0123ABCDEF");
    expect(page).toContain("alerts go to channel G0789MNOPQR");
    expect(page).toContain("Discord and Slack");
    expect(page).not.toContain(SLACK_BOT);
    expect(page).not.toContain(SLACK_APP);
    expect(page).toContain('action="/chat/slack/test"');
    expect(page).toContain('href="/chat/slack/channels"');
    expect(page).toContain("Remove the Slack bot's credentials from this host?");
    expect(page).not.toContain('href="/chat/connect/slack"');
    expect(page).not.toMatch(/communicator|lead|improver/i);

    await dashboard.post("/chat/slack/test");
    expect(sent).toEqual(["Hephaestus is connected. Ask for work here."]);

    const form = await dashboard.get("/chat/slack/channels");
    expect(form.html).toContain('<h1 id="page-title">Slack channels</h1>');
    expect(form.html).toContain('name="channel" value="C0123ABCDEF"');
    expect(form.html).not.toContain('inputmode="numeric"');
    expect(form.html).not.toContain(SLACK_APP);

    const gone = await dashboard.post("/chat/slack/disconnect");
    expect(gone.headers.get("location")).toBe("/chat?notice=disconnected");
    const after = (await dashboard.get("/chat")).html;
    expect(after).toContain('href="/chat/connect/slack"');
    expect(after).not.toContain('href="/chat/connect/discord"');
  });

  it("says what to fix when the app token is missing, and keeps neither token", async () => {
    dashboard = await withMessaging();
    const response = await dashboard.post("/chat/slack/connect", { ...SLACK, app_token: "" });
    const html = await response.text();
    expect(response.status).toBe(400);
    expect(html).toContain("Slack: not changed");
    expect(html).toContain("does not look like a Slack app-level token");
    expect(html).toContain('name="users" value="U0123ABCDEF"');
    expect(html).not.toContain(SLACK_BOT);
  });
});
