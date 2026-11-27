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
  channel: "1234567890123456789",
};

describe("Chat page", () => {
  it("lists Discord and Telegram with a link to connect each, and never names the factory's roles", async () => {
    dashboard = await withMessaging();
    const { status, html } = await dashboard.get("/chat");
    expect(status).toBe(200);
    expect(html).toContain('<h1 id="page-title">Chat</h1>');
    expect(html).toContain('href="/chat/connect/discord"');
    expect(html).toContain('href="/chat/connect/telegram"');
    expect(html).toContain("Not connected");
    expect(html).toContain("Connect a platform first.");
    expect(html).not.toContain('<form method="post" action="/chat/discord/connect"');
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toMatch(/communicator|lead|improver/i);
    expect((await dashboard.get("/messaging")).status).toBe(404);
  });

  it.each([
    ["discord", "Connect Discord", "Channel ID", true],
    ["telegram", "Connect Telegram", "Chat ID (optional)", false],
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
      expect(html).toContain(`>${channelLabel}</label>`);
      expect(/<input type="text" id="channel" name="channel"[^>]* required/.test(html)).toBe(
        channelRequired,
      );
      expect(html).toContain("Where to find these");
      expect(html.match(/<ol class="steps">.*?<\/ol>/s)?.[0].match(/<li>/g)).toHaveLength(3);
      expect(html).not.toContain('http-equiv="refresh"');
      expect(html).not.toMatch(/communicator|lead|improver/i);
    },
  );

  it("connects, shows the stored IDs, sends a test message, turns alerts on, and never shows the token", async () => {
    const sent: string[] = [];
    dashboard = await withMessaging(sent);
    const connected = await dashboard.post("/chat/discord/connect", DISCORD);
    expect(connected.headers.get("location")).toBe("/chat?notice=connected");
    const page = (await dashboard.get("/chat?notice=connected")).html;
    expect(page).toContain("Connected");
    expect(page).toContain(`Bot token ending <code>${TOKEN.slice(-4)}</code>`);
    expect(page).toContain("answers 284102345871466496");
    expect(page).toContain("alerts go to channel 1234567890123456789");
    expect(page).not.toContain(TOKEN);
    expect(page).toContain('action="/chat/discord/test"');
    expect(page).toContain("Send test message");
    expect(page).not.toContain('href="/chat/connect/discord"');
    expect(page).toContain('href="/chat/connect/telegram"');
    expect(page).not.toMatch(/communicator|lead|improver/i);

    await dashboard.post("/chat/discord/test");
    expect(sent).toEqual(["Hephaestus is connected. Ask for work here."]);
    const alerts = await dashboard.post("/chat/alerts/on");
    expect(alerts.headers.get("location")).toBe("/chat?notice=alerts-on");
    const on = (await dashboard.get("/chat")).html;
    expect(on).toContain('action="/chat/alerts/off"');
    expect(on).toContain("Turn alerts off");
    expect(on).toMatch(/class="st t-done">.*?On<\/span>/);
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
