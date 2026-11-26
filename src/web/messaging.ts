import {
  MessagingError,
  PLATFORMS,
  RestartError,
  type PlatformName,
  type PlatformState,
} from "../messaging.js";
import type { FactoryPages } from "./factory.js";
import { banner, card, empty, escapeHtml, layout, pageHead, pill, postButton } from "./html.js";
import { readBody, redirect, sendHtml, type Route, type RouteContext } from "./http.js";

const MAX_FORM_BYTES = 16 * 1024;

/** How to make a bot on each platform, shown beside its form. */
const STEPS: Record<PlatformName, string[]> = {
  discord: [
    'On <a href="https://discord.com/developers/applications" rel="noreferrer" target="_blank">the Discord developer portal</a>, create an application, open Bot, and reset and copy the token. Turn on Message Content Intent.',
    "Under OAuth2, URL Generator, tick bot, and the permissions View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, and Attach Files. Open the URL to invite the bot to your server.",
    "In Discord, turn on Developer Mode, then right-click your name for your user ID and the channel you will use for its ID.",
  ],
  telegram: [
    "In Telegram, message @BotFather, send /newbot, and copy the token it gives you.",
    "Message @userinfobot to get your numeric user ID.",
    "Leave the chat empty to use your direct chat with the bot, or give a group's ID.",
  ],
};

const NOTICES: Record<string, { kind: "info" | "err"; title: string; text: string }> = {
  connected: {
    kind: "info",
    title: "Connected",
    text: "Hephaestus restarted its messaging gateway with the bot. Send a test message to check it.",
  },
  disconnected: {
    kind: "info",
    title: "Disconnected",
    text: "The bot's credentials were removed.",
  },
  restarted: {
    kind: "info",
    title: "Reconnected",
    text: "The messaging gateway restarted with the saved settings.",
  },
  tested: { kind: "info", title: "Test message sent", text: "Check the chat for it." },
  "alerts-on": {
    kind: "info",
    title: "Alerts on",
    text: "Each new item that needs you is posted to the chat, starting from now.",
  },
  "alerts-off": { kind: "info", title: "Alerts off", text: "Nothing more is posted to the chat." },
};

/** The Messaging page: connect Hephaestus to a chat, where you ask for work and get its alerts. */
export function messagingRoutes(factory: FactoryPages): Route[] {
  const messaging = factory.messaging;
  return [
    {
      method: "GET",
      path: /^\/messaging$/,
      handle: ({ response, url }) => {
        sendHtml(response, 200, page(url.searchParams.get("notice") ?? "", undefined));
      },
    },
    {
      method: "POST",
      path: /^\/messaging\/(discord|telegram)\/(connect|disconnect|test)$/,
      handle: (context) => act(context),
    },
    {
      method: "POST",
      path: /^\/messaging\/restart$/,
      handle: async ({ response }) => {
        if (messaging === undefined) {
          redirect(response, "/messaging");
          return;
        }
        try {
          await messaging.restart();
          redirect(response, "/messaging?notice=restarted");
        } catch (error) {
          sendHtml(response, 400, page("", { text: messageOf(error), restart: true }));
        }
      },
    },
    {
      method: "POST",
      path: /^\/messaging\/alerts\/(on|off)$/,
      handle: ({ response, params }) => {
        if (messaging === undefined) {
          redirect(response, "/messaging");
          return;
        }
        const on = params[0] === "on";
        messaging.setAlerts(on);
        redirect(response, `/messaging?notice=alerts-${on ? "on" : "off"}`);
      },
    },
  ];

  async function act({ request, response, params }: RouteContext): Promise<void> {
    const platform = params[0] as PlatformName;
    const action = params[1];
    const body = await readBody(request, MAX_FORM_BYTES);
    if (messaging === undefined || body === undefined) {
      redirect(response, "/messaging");
      return;
    }
    const form = new URLSearchParams(body);
    try {
      if (action === "connect") {
        await messaging.connect(platform, {
          token: form.get("token") ?? "",
          users: form.get("users") ?? "",
          home: form.get("channel") ?? "",
        });
        redirect(response, "/messaging?notice=connected");
      } else if (action === "disconnect") {
        await messaging.disconnect(platform);
        redirect(response, "/messaging?notice=disconnected");
      } else {
        await messaging.send(platform, "Hephaestus is connected. Ask for work here.");
        redirect(response, "/messaging?notice=tested");
      }
    } catch (error) {
      sendHtml(
        response,
        400,
        page("", {
          label: PLATFORMS[platform].label,
          text: messageOf(error),
          restart: error instanceof RestartError,
        }),
      );
    }
  }

  function page(
    notice: string,
    problem: { label?: string; text: string; restart: boolean } | undefined,
  ): string {
    const head = pageHead({
      title: "Messaging",
      lede: "Connect Hephaestus to a chat. You ask for work there, each request gets its own thread with progress as it goes, and Hephaestus tells you when something needs you.",
    });
    if (messaging === undefined) {
      return layout(
        "Messaging",
        `${head}${empty("Messaging needs the factory's Hermes, which this install does not have.")}`,
        {
          section: "/messaging",
        },
      );
    }
    if (!messaging.ready()) {
      return layout(
        "Messaging",
        `${head}${banner("info", "Not ready yet", "Deploy a config version on Settings first; it sets up the factory's Hermes, which runs the chat.")}`,
        { section: "/messaging" },
      );
    }
    const shown = NOTICES[notice];
    const states = messaging.states();
    const connected = states.filter((state) => state.connected);
    const alerts = messaging.alertsOn();
    const alertsCard = card({
      title: "Alerts",
      meta: pill(alerts ? "run" : "off", alerts ? "On" : "Off"),
      body:
        connected.length === 0
          ? empty("Connect a platform first.")
          : `<p class="lede">Posts each new item that needs you, such as an escalation, a revert, a proposal to approve, or a worker that needs a sign-in, to ${escapeHtml(connected.map((state) => state.label).join(" and "))}, with a link to the dashboard.</p>${postButton(
              `/messaging/alerts/${alerts ? "off" : "on"}`,
              alerts ? "Turn alerts off" : "Turn alerts on",
              { variant: alerts ? "secondary" : "primary", small: false },
            )}`,
    });
    const body = `${head}${shown === undefined ? "" : banner(shown.kind, shown.title, shown.text)}${
      problem === undefined
        ? ""
        : `${banner("err", problem.restart ? "Saved, but not reconnected" : `${problem.label ?? "Messaging"}: not changed`, problem.text)}${
            problem.restart
              ? `<div class="btn-row">${postButton("/messaging/restart", "Restart the gateway", { variant: "primary", small: false })}</div>`
              : ""
          }`
    }<div class="grid">${states.map((state) => platformCard(state)).join("")}${alertsCard}</div>`;
    return layout("Messaging", body, { section: "/messaging" });
  }
}

function platformCard(state: PlatformState): string {
  const platform = PLATFORMS[state.platform];
  const base = `/messaging/${state.platform}`;
  if (state.connected) {
    const where =
      state.home === undefined
        ? "No chat is set for alerts."
        : `Requests and alerts use ${state.platform === "discord" ? "channel" : "chat"} ${escapeHtml(state.home)}.`;
    return card({
      title: platform.label,
      span: 6,
      meta: pill("run", "Connected"),
      body: `<p class="lede">The bot whose token ends in <code>${escapeHtml(state.tokenEnd ?? "")}</code> answers ${escapeHtml(state.users.join(", "))}. ${where}</p><div class="btn-row">${postButton(`${base}/test`, "Send a test message", { small: false })}${postButton(`${base}/disconnect`, "Disconnect", { variant: "danger", small: false })}</div>`,
    });
  }
  const steps = STEPS[state.platform].map((step) => `<li>${step}</li>`).join("");
  return card({
    title: platform.label,
    span: 6,
    meta: pill("off", "Not connected"),
    body: `<ol class="steps">${steps}</ol>
<form method="post" action="${base}/connect" class="form-grid" autocomplete="off">
<div class="field"><label for="${state.platform}-token">Bot token</label><input type="password" id="${state.platform}-token" name="token" required autocomplete="off"><span class="meta">Kept in a file only you can read on this host. It is never shown again.</span></div>
<div class="field"><label for="${state.platform}-users">Your user ID</label><input type="text" id="${state.platform}-users" name="users" required inputmode="numeric"><span class="meta">Only these users can use the bot. Separate several with commas.</span></div>
<div class="field"><label for="${state.platform}-channel">${platform.needsChannel ? "Channel ID" : "Chat ID (optional)"}</label><input type="text" id="${state.platform}-channel" name="channel"${platform.needsChannel ? " required" : ""} inputmode="numeric"><span class="meta">${platform.needsChannel ? "Ask for work here without mentioning the bot; each request gets its own thread. Alerts go here too." : "Where alerts go. Empty uses your direct chat with the bot."}</span></div>
<div class="btn-row"><button type="submit" class="btn-primary">Connect</button></div>
</form>`,
  });
}

/** What to tell the owner: a refusal says what to fix; anything else is logged, since it may carry details. */
function messageOf(error: unknown): string {
  if (error instanceof MessagingError) return error.message;
  console.error("A messaging action failed", error);
  return "Hephaestus could not change the connection. The service log has the error.";
}
