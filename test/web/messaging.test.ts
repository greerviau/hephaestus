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
  mkdirSync(join(root, "profiles", "planner"), { recursive: true });
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
    get cards() {
      if (holder.dashboard === undefined) throw new Error("not started");
      return holder.dashboard.h.cards;
    },
    dashboardUrl: () => "http://host:7700/",
  });
  holder.dashboard = await startDashboard({ messaging });
  return holder.dashboard;
}

describe("Messaging page", () => {
  it("offers Discord and Telegram, and never names the factory's roles", async () => {
    dashboard = await withMessaging();
    const { status, html } = await dashboard.get("/messaging");
    expect(status).toBe(200);
    expect(html).toContain('action="/messaging/discord/connect"');
    expect(html).toContain('action="/messaging/telegram/connect"');
    expect(html).toContain('type="password" id="discord-token" name="token"');
    expect(html).not.toMatch(/planner|lead|improver/i);
  });

  it("connects, sends a test message, turns alerts on, and never shows the token", async () => {
    const sent: string[] = [];
    dashboard = await withMessaging(sent);
    const connected = await dashboard.post("/messaging/discord/connect", {
      token: TOKEN,
      users: "284102345871466496",
      channel: "1234567890123456789",
    });
    expect(connected.headers.get("location")).toBe("/messaging?notice=connected");
    const page = (await dashboard.get("/messaging")).html;
    expect(page).toContain("Connected");
    expect(page).toContain(TOKEN.slice(-4));
    expect(page).not.toContain(TOKEN);

    await dashboard.post("/messaging/discord/test");
    expect(sent).toEqual(["Hephaestus is connected. Ask for work here."]);
    const alerts = await dashboard.post("/messaging/alerts/on");
    expect(alerts.headers.get("location")).toBe("/messaging?notice=alerts-on");
    expect((await dashboard.get("/messaging")).html).toContain("Turn alerts off");
  });

  it("says what to fix when the token is malformed", async () => {
    dashboard = await withMessaging();
    const response = await dashboard.post("/messaging/discord/connect", {
      token: "oops",
      users: "284102345871466496",
      channel: "1234567890123456789",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("does not look like a Discord bot token");
  });

  it("says the settings were saved when the restart fails, and retries it", async () => {
    let restarts = 0;
    let fail = true;
    dashboard = await withMessaging([], () => {
      restarts += 1;
      return fail ? Promise.reject(new Error("exit 1")) : Promise.resolve();
    });
    const response = await dashboard.post("/messaging/discord/connect", {
      token: TOKEN,
      users: "284102345871466496",
      channel: "1234567890123456789",
    });
    const html = await response.text();
    expect(response.status).toBe(400);
    expect(html).toContain("Saved, but not reconnected");
    expect(html).not.toContain("not changed");
    expect(html).toContain('action="/messaging/restart"');

    fail = false;
    const retried = await dashboard.post("/messaging/restart");
    expect(retried.headers.get("location")).toBe("/messaging?notice=restarted");
    expect(restarts).toBe(2);
  });
});
