import {
  MessagingError,
  PLATFORMS,
  RestartError,
  type PlatformName,
  type PlatformState,
} from "../messaging.js";
import { STORE_ERROR, read, type FactoryPages } from "./factory.js";
import {
  buttonLink,
  callout,
  dialog,
  empty,
  escapeHtml,
  externalLink,
  input,
  layout,
  menu,
  pageHead,
  postButton,
  rowList,
  section,
  statusText,
  type Row,
} from "./html.js";
import { readBody, redirect, sendHtml, type Route, type RouteContext } from "./http.js";

const MAX_FORM_BYTES = 16 * 1024;

/** How to make a bot on each platform, shown beside its form. Safe HTML. */
const STEPS: Record<PlatformName, string[]> = {
  discord: [
    `On ${externalLink("https://discord.com/developers/applications", "the Discord developer portal")}, create an application, open Bot, and reset and copy the token. Turn on Message Content Intent.`,
    "Under OAuth2, URL Generator, tick bot, and the permissions View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, and Attach Files. Open the URL to invite the bot to your server.",
    "In Discord, turn on Developer Mode, then right-click your name for your user ID and the channel you will use for its ID.",
  ],
  telegram: [
    "In Telegram, message @BotFather, send /newbot, and copy the token it gives you.",
    "Message @userinfobot to get your numeric user ID.",
    "Leave the chat empty to use your direct chat with the bot, or give a group's ID.",
  ],
};

const NOTICES: Record<string, { title: string; text: string }> = {
  connected: {
    title: "Connected",
    text: "Hephaestus restarted its messaging gateway with the bot. Send a test message to check it.",
  },
  disconnected: { title: "Disconnected", text: "The bot's credentials were removed." },
  restarted: {
    title: "Reconnected",
    text: "The messaging gateway restarted with the saved settings.",
  },
  tested: { title: "Test message sent", text: "Check the chat for it." },
  "alerts-on": {
    title: "Alerts on",
    text: "Each new item that needs you is posted to the chat, starting from now.",
  },
  "alerts-off": { title: "Alerts off", text: "Nothing more is posted to the chat." },
};

const LEDE = "Ask for work in a chat and get told there when something needs you.";
const SEP = " &middot; ";

/** What went wrong with an action, for the page the owner lands on. */
interface Problem {
  label?: string;
  text: string;
  /** The settings were saved and only the gateway restart failed. */
  restart: boolean;
}

/** What the owner typed on a connect form that the server refused, without the token. */
interface Typed {
  users: string;
  channel: string;
}

/** The Chat pages: connect Hephaestus to a chat, where you ask for work and get its alerts. */
export function messagingRoutes(factory: FactoryPages): Route[] {
  const messaging = factory.messaging;
  return [
    {
      method: "GET",
      path: /^\/chat$/,
      handle: (context) => {
        const { response, url } = context;
        sendHtml(response, 200, page(context, url.searchParams.get("notice") ?? "", undefined));
      },
    },
    {
      method: "GET",
      path: /^\/chat\/connect\/(discord|telegram)$/,
      handle: (context) => {
        const { response, params } = context;
        const platform = params[0] as PlatformName;
        // A connected platform has no form to show: connecting again would replace its bot unasked.
        if (messaging?.ready() === true && stateOf(platform)?.connected === true) {
          redirect(response, "/chat");
          return;
        }
        sendHtml(response, 200, connectPage(context, platform, undefined, undefined));
      },
    },
    {
      method: "POST",
      path: /^\/chat\/(discord|telegram)\/(connect|disconnect|test)$/,
      handle: (context) => act(context),
    },
    {
      method: "POST",
      path: /^\/chat\/restart$/,
      handle: async (context) => {
        const { response } = context;
        if (messaging === undefined) {
          redirect(response, "/chat");
          return;
        }
        try {
          await messaging.restart();
          redirect(response, "/chat?notice=restarted");
        } catch (error) {
          sendHtml(response, 400, page(context, "", { text: messageOf(error), restart: true }));
        }
      },
    },
    {
      method: "POST",
      path: /^\/chat\/alerts\/(on|off)$/,
      handle: ({ response, params }) => {
        if (messaging === undefined) {
          redirect(response, "/chat");
          return;
        }
        const on = params[0] === "on";
        messaging.setAlerts(on);
        redirect(response, `/chat?notice=alerts-${on ? "on" : "off"}`);
      },
    },
  ];

  function stateOf(platform: PlatformName): PlatformState | undefined {
    return messaging?.states().find((state) => state.platform === platform);
  }

  async function act(context: RouteContext): Promise<void> {
    const { request, response, params } = context;
    const platform = params[0] as PlatformName;
    const action = params[1];
    const body = await readBody(request, MAX_FORM_BYTES);
    if (messaging === undefined || body === undefined) {
      redirect(response, "/chat");
      return;
    }
    const form = new URLSearchParams(body);
    const typed = { users: form.get("users") ?? "", channel: form.get("channel") ?? "" };
    try {
      if (action === "connect") {
        await messaging.connect(platform, {
          token: form.get("token") ?? "",
          users: typed.users,
          home: typed.channel,
        });
        redirect(response, "/chat?notice=connected");
      } else if (action === "disconnect") {
        await messaging.disconnect(platform);
        redirect(response, "/chat?notice=disconnected");
      } else {
        await messaging.send(platform, "Hephaestus is connected. Ask for work here.");
        redirect(response, "/chat?notice=tested");
      }
    } catch (error) {
      const problem = {
        label: PLATFORMS[platform].label,
        text: messageOf(error),
        restart: error instanceof RestartError,
      };
      // A refused connect leaves the platform unconnected, so the owner goes back to the form; a
      // failed restart saved the settings, and the retry button is on the Chat page.
      sendHtml(
        response,
        400,
        action === "connect" && !problem.restart
          ? connectPage(context, platform, problem, typed)
          : page(context, "", problem),
      );
    }
  }

  /** The page when the chat cannot be set up yet, or undefined when it can. */
  function unavailable(): string | undefined {
    if (messaging === undefined) {
      return empty("Chat needs the factory's Hermes, which this install does not have.");
    }
    if (!messaging.ready()) {
      return callout(
        "info",
        "Not ready yet",
        'Deploy a config version on <a href="/config/versions">Config</a> first. It sets up the chat.',
      );
    }
    return undefined;
  }

  function page(context: RouteContext, notice: string, problem: Problem | undefined): string {
    const { shell } = context;
    const head = pageHead({ title: "Chat", lede: LEDE });
    const blocked = unavailable();
    if (messaging === undefined || blocked !== undefined) {
      return layout("Chat", `${head}${blocked ?? ""}`, { section: "/chat", shell });
    }
    const shown = NOTICES[notice];
    const live = read("the chat connections", () => ({
      states: messaging.states(),
      alerts: messaging.alertsOn(),
    }));
    if (!live.ok) return layout("Chat", `${head}${STORE_ERROR}`, { section: "/chat", shell });
    const { states, alerts } = live.value;
    const connected = states.filter((state) => state.connected);
    const alertsBody =
      connected.length === 0
        ? empty("Connect a platform first.")
        : rowList([
            {
              title: "Post what needs you to the chat",
              sub: `Escalations, reverts, proposals to approve, and workers that need a sign-in are posted to ${escapeHtml(connected.map((state) => state.label).join(" and "))}, each with a link to the dashboard.`,
              aside: `${statusText(alerts ? "done" : "off", alerts ? "On" : "Off")}${postButton(
                `/chat/alerts/${alerts ? "off" : "on"}`,
                alerts ? "Turn alerts off" : "Turn alerts on",
              )}`,
            },
          ]);
    const body = `${head}${shown === undefined ? "" : callout("info", shown.title, escapeHtml(shown.text))}${
      problem === undefined
        ? ""
        : callout(
            "err",
            problem.restart
              ? "Saved, but not reconnected"
              : `${problem.label ?? "Chat"}: not changed`,
            escapeHtml(problem.text),
            problem.restart
              ? postButton("/chat/restart", "Restart the gateway", { variant: "primary" })
              : undefined,
          )
    }${section({ title: "Platforms", body: rowList(states.map(platformRow)) })}${section({
      title: "Alerts",
      body: alertsBody,
    })}${connected.map(disconnectDialog).join("")}`;
    return layout("Chat", body, { section: "/chat", shell });
  }

  function connectPage(
    context: RouteContext,
    name: PlatformName,
    problem: Problem | undefined,
    typed: Typed | undefined,
  ): string {
    const platform = PLATFORMS[name];
    const title = `Connect ${platform.label}`;
    const head = pageHead({ title });
    const error =
      problem === undefined
        ? ""
        : callout("err", `${platform.label}: not changed`, escapeHtml(problem.text));
    const form = `<form class="form" method="post" action="/chat/${name}/connect" autocomplete="off">
${input("token", "Bot token", { type: "password", autocomplete: "off", hint: "Kept in a file only you can read on this host. It is never shown again." })}
${input("users", "Your user ID", { value: typed?.users, inputmode: "numeric", hint: "Only these users can use the bot. Separate several with commas." })}
${
  platform.needsChannel
    ? input("channel", "Channel ID", {
        value: typed?.channel,
        inputmode: "numeric",
        hint: "Ask for work here without mentioning the bot; each request gets its own thread. Alerts go here too.",
      })
    : input("channel", "Chat ID (optional)", {
        value: typed?.channel,
        inputmode: "numeric",
        required: false,
        hint: "Where alerts go. Empty uses your direct chat with the bot.",
      })
}
<div class="savebar"><button type="submit" class="primary">${escapeHtml(title)}</button><a href="/chat">Cancel</a></div>
</form>`;
    const steps = section({
      title: "Where to find these",
      body: `<ol class="steps">${STEPS[name].map((step) => `<li>${step}</li>`).join("")}</ol>`,
    });
    return layout(
      title,
      `${head}${unavailable() ?? `${error}<div class="cols">${form}${steps}</div>`}`,
      {
        section: "/chat",
        shell: context.shell,
        crumbs: [["Chat", "/chat"], [title]],
      },
    );
  }
}

function disconnectId(state: PlatformState): string {
  return `disconnect-${state.platform}`;
}

function platformRow(state: PlatformState): Row {
  if (!state.connected) {
    return {
      title: state.label,
      sub: "Not connected",
      aside: buttonLink(`/chat/connect/${state.platform}`, "Connect"),
    };
  }
  const where =
    state.home === undefined
      ? "no chat is set for alerts"
      : `alerts go to ${state.platform === "discord" ? "channel" : "chat"} ${escapeHtml(state.home)}`;
  return {
    title: state.label,
    sub: [
      `Bot token ending <code>${escapeHtml(state.tokenEnd ?? "")}</code>`,
      `answers ${escapeHtml(state.users.join(", "))}`,
      where,
    ].join(SEP),
    aside: `${statusText("done", "Connected")}${postButton(`/chat/${state.platform}/test`, "Send test message")}${menu(
      [{ label: "Disconnect", dialog: disconnectId(state), danger: true }],
      `More actions for ${state.label}`,
    )}`,
  };
}

/** The confirm that Disconnect opens. It sits outside the menu, which hides its content when closed. */
function disconnectDialog(state: PlatformState): string {
  return dialog({
    id: disconnectId(state),
    title: `Disconnect ${state.label}`,
    body: `<p>Remove the ${escapeHtml(state.label)} bot's credentials from this host?</p><p class="muted">Requests and alerts stop there until you connect again.</p>`,
    action: `/chat/${state.platform}/disconnect`,
    submit: "Disconnect",
    danger: true,
  });
}

/** What to tell the owner: a refusal says what to fix; anything else is logged, since it may carry details. */
function messageOf(error: unknown): string {
  if (error instanceof MessagingError) return error.message;
  console.error("A messaging action failed", error);
  return "Hephaestus could not change the connection. The service log has the error.";
}
