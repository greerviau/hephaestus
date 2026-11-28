import {
  MessagingError,
  PLATFORM_NAMES,
  PLATFORMS,
  RestartError,
  statusTarget,
  type ChannelInput,
  type PlatformName,
  type PlatformState,
} from "../messaging.js";
import { STORE_ERROR, read, type FactoryPages } from "./factory.js";
import {
  buttonLink,
  callout,
  checkbox,
  dialog,
  empty,
  escapeHtml,
  externalLink,
  input,
  layout,
  lookup,
  menu,
  pageHead,
  postButton,
  rowList,
  section,
  statusText,
  textarea,
  type Row,
} from "./html.js";
import { readBody, redirect, sendHtml, type Route, type RouteContext } from "./http.js";

const MAX_FORM_BYTES = 16 * 1024;

/** The platform names as a regex group, so each route takes every platform. */
const NAMES = `(${PLATFORM_NAMES.join("|")})`;

/** How to make a bot on each platform, shown beside its form. Safe HTML. */
const STEPS: Record<PlatformName, string[]> = {
  discord: [
    `On ${externalLink("https://discord.com/developers/applications", "the Discord developer portal")}, create an application, open Bot, and reset and copy the token. Turn on Message Content Intent.`,
    "Under OAuth2, URL Generator, tick bot, and the permissions View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, and Attach Files. Open the URL to invite the bot to your server.",
    "In Discord, turn on Developer Mode, then right-click your name for your user ID and each channel you will use for its ID.",
  ],
  telegram: [
    "In Telegram, message @BotFather, send /newbot, and copy the token it gives you.",
    "Message @userinfobot to get your numeric user ID.",
    "Leave the chat empty to use your direct chat with the bot, or give a group's ID.",
  ],
  slack: [
    `On ${externalLink("https://api.slack.com/apps", "Slack's app page")}, create an app from scratch. Under Socket Mode, turn it on and make an app-level token with the connections:write scope. Under Event Subscriptions, subscribe the bot to message.channels, message.groups, message.im, and app_mention.`,
    "Under OAuth &amp; Permissions, add the bot scopes chat:write, channels:history, groups:history, im:history, app_mentions:read, users:read, files:read, and files:write, install the app to your workspace, and copy the Bot User OAuth Token. Invite the bot to your channels.",
    "In Slack, open your profile and choose Copy member ID for your user ID. Open a channel's details for its channel ID at the bottom.",
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
  tested: { title: "Test message sent", text: "Check the status channel for it." },
  channels: {
    title: "Channels saved",
    text: "Hephaestus restarted its messaging gateway with the new channels.",
  },
  "alerts-on": {
    title: "Alerts on",
    text: "Each new item that needs you is posted to the chat, starting from now.",
  },
  "alerts-off": { title: "Alerts off", text: "Nothing more is posted to the chat." },
};

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
  reads: string;
  readAll: boolean;
  status: string;
  alerts: string;
}

function typedFrom(form: URLSearchParams): Typed {
  return {
    users: form.get("users") ?? "",
    channel: form.get("channel") ?? "",
    reads: form.get("reads") ?? "",
    readAll: form.get("read_all") === "1",
    status: form.get("status") ?? "",
    alerts: form.get("alerts") ?? "",
  };
}

function channelInput(typed: Typed): ChannelInput {
  return {
    home: typed.channel,
    reads: typed.reads,
    readAll: typed.readAll,
    status: typed.status,
    alerts: typed.alerts,
  };
}

/** What a connected platform has saved, in the form's terms. */
function typedOf(state: PlatformState): Typed {
  return {
    users: state.users.join(", "),
    channel: state.request ?? "",
    reads: state.reads.join(", "),
    readAll: state.readAll,
    status: state.status ?? "",
    alerts: state.alerts ?? "",
  };
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
      path: new RegExp(`^/chat/connect/${NAMES}$`),
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
      path: new RegExp(`^/chat/${NAMES}/(connect|disconnect|test)$`),
      handle: (context) => act(context),
    },
    {
      method: "GET",
      path: new RegExp(`^/chat/${NAMES}/channels$`),
      handle: (context) => {
        const { response, params } = context;
        const platform = params[0] as PlatformName;
        const state = stateOf(platform);
        // Only a connected bot has channels to change; connecting sets them first.
        if (messaging?.ready() === true && state?.connected !== true) {
          redirect(response, "/chat");
          return;
        }
        sendHtml(
          response,
          200,
          channelsPage(
            context,
            platform,
            undefined,
            state === undefined ? undefined : typedOf(state),
          ),
        );
      },
    },
    {
      method: "POST",
      path: new RegExp(`^/chat/${NAMES}/channels$`),
      handle: async (context) => {
        const { request, response, params } = context;
        const platform = params[0] as PlatformName;
        const body = await readBody(request, MAX_FORM_BYTES);
        if (messaging === undefined || body === undefined) {
          redirect(response, "/chat");
          return;
        }
        const typed = typedFrom(new URLSearchParams(body));
        try {
          await messaging.setChannels(platform, channelInput(typed));
          redirect(response, "/chat?notice=channels");
        } catch (error) {
          const problem = {
            label: PLATFORMS[platform].label,
            text: messageOf(error),
            restart: error instanceof RestartError,
          };
          sendHtml(
            response,
            400,
            problem.restart
              ? page(context, "", problem)
              : channelsPage(context, platform, problem, typed),
          );
        }
      },
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
    const typed = typedFrom(form);
    try {
      if (action === "connect") {
        await messaging.connect(platform, {
          token: form.get("token") ?? "",
          appToken: form.get("app_token") ?? "",
          users: typed.users,
          ...channelInput(typed),
        });
        redirect(response, "/chat?notice=connected");
      } else if (action === "disconnect") {
        await messaging.disconnect(platform);
        redirect(response, "/chat?notice=disconnected");
      } else {
        await messaging.send(
          platform,
          // Discord's status channel takes no request without a mention.
          PLATFORMS[platform].request === "none"
            ? "Hephaestus is connected. Mention the bot to ask for work."
            : "Hephaestus is connected. Ask for work here.",
        );
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
    const head = pageHead({ title: "Chat" });
    const blocked = unavailable();
    if (messaging === undefined || blocked !== undefined) {
      return layout("Chat", `${head}${blocked ?? ""}`, { section: "/chat", shell });
    }
    const shown = lookup(NOTICES, notice);
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
              sub: `Escalations, reverts, proposals, and worker sign-ins, to the alerts channel on ${escapeHtml(listed(connected.map((state) => state.label)))}.`,
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
${input("token", "Bot token", { type: "password", autocomplete: "off", hint: "Stored on this host and never shown again." })}
${platform.appToken === undefined ? "" : `${input("app_token", "App-level token", { type: "password", autocomplete: "off", hint: "The xapp- token for Socket Mode." })}\n`}${input("users", "Your user ID", { value: typed?.users, inputmode: numeric(name), hint: "Only these users can use the bot. Comma-separated." })}
${channelFields(name, typed)}
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

  /** The page that changes a connected bot's channels, without its token. */
  function channelsPage(
    context: RouteContext,
    name: PlatformName,
    problem: Problem | undefined,
    typed: Typed | undefined,
  ): string {
    const platform = PLATFORMS[name];
    const title = `${platform.label} channels`;
    const head = pageHead({ title });
    const error =
      problem === undefined
        ? ""
        : callout("err", `${platform.label}: not changed`, escapeHtml(problem.text));
    const form = `<form class="form" method="post" action="/chat/${name}/channels" autocomplete="off">
${channelFields(name, typed)}
<div class="savebar"><button type="submit" class="primary">Save channels</button><a href="/chat">Cancel</a></div>
</form>`;
    return layout(title, `${head}${unavailable() ?? `${error}${form}`}`, {
      section: "/chat",
      shell: context.shell,
      crumbs: [["Chat", "/chat"], [title]],
    });
  }
}

/** The channel fields that the connect and channels forms share. */
function channelFields(name: PlatformName, typed: Typed | undefined): string {
  if (PLATFORMS[name].request === "none") return mentionFields(name, typed);
  const platform = PLATFORMS[name];
  const where = noun(name);
  const inputmode = numeric(name);
  const request =
    platform.request === "required"
      ? input("channel", "Request channel ID", {
          value: typed?.channel,
          inputmode,
          hint: "Requests here need no mention. Each gets its own thread.",
        })
      : input("channel", "Request chat ID (optional)", {
          value: typed?.channel,
          inputmode,
          required: false,
          hint: "Empty uses your direct chat with the bot.",
        });
  return [
    request,
    textarea("reads", `Other ${where}s the bot reads (optional)`, {
      value: typed?.reads,
      rows: 2,
      required: false,
      hint:
        platform.request === "required"
          ? "Comma-separated. The bot answers there when mentioned."
          : "Group chat IDs, comma-separated.",
    }),
    checkbox("read_all", `Let the bot read every ${where} it can see`, {
      checked: typed?.readAll === true,
    }),
    input("status", `Status ${where} ID (optional)`, {
      value: typed?.status,
      inputmode,
      required: false,
      hint: `Job results and restarts. Empty uses the request ${where}.`,
    }),
    input("alerts", `Alerts ${where} ID (optional)`, {
      value: typed?.alerts,
      inputmode,
      required: false,
      hint: `Anything that needs you. Empty uses the status ${where}.`,
    }),
  ].join("\n");
}

/**
 * The channel fields of a platform with no request channel, where the bot
 * answers only when mentioned: one choice of where it reads, and where
 * Hephaestus posts. The list hides while every channel is chosen.
 */
function mentionFields(name: PlatformName, typed: Typed | undefined): string {
  const inputmode = numeric(name);
  const all = typed?.readAll === true;
  const choice = (value: string, checked: boolean, title: string): string =>
    `<label class="choice"><input type="radio" name="read_all" value="${value}"${checked ? " checked" : ""}><strong>${escapeHtml(title)}</strong></label>`;
  const access = `<fieldset class="access"><legend>Channels the bot reads</legend><div class="choices two">${choice(
    "0",
    !all,
    "Only the channels I list",
  )}${choice("1", all, "Every channel it is in")}</div>
<div class="access-list">${textarea("reads", "Channel IDs", {
    value: typed?.reads,
    rows: 2,
    required: false,
    hint: "Comma-separated.",
  })}</div>
<p class="hint">The bot answers only when mentioned, in its own thread.</p></fieldset>`;
  return [
    access,
    input("status", "Status channel ID", {
      value: typed?.status,
      inputmode,
      hint: "Job results, restarts, and test messages.",
    }),
    input("alerts", "Alerts channel ID (optional)", {
      value: typed?.alerts,
      inputmode,
      required: false,
      hint: "Anything that needs you. Empty uses the status channel.",
    }),
  ].join("\n");
}

/** What the platform calls the place a bot reads: a channel, or a chat on Telegram. */
function noun(name: PlatformName): string {
  return PLATFORMS[name].noun;
}

/** The number pad for platforms whose IDs are numbers. */
function numeric(name: PlatformName): "numeric" | undefined {
  return PLATFORMS[name].numericIds ? "numeric" : undefined;
}

/** Names as a sentence lists them: "A", "A and B", or "A, B, and C". */
function listed(names: string[]): string {
  return names.length < 3
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names.at(-1) ?? ""}`;
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
  const where = noun(state.platform);
  const at = (id: string | undefined, direct: string): string =>
    id === undefined ? direct : `${where} ${escapeHtml(id)}`;
  const direct = "your direct chat";
  const mention = PLATFORMS[state.platform].request === "none";
  const reads = mention
    ? state.readAll
      ? `reads every ${where} it can see when mentioned`
      : state.reads.length === 0
        ? `reads no ${where}`
        : `reads ${where}${state.reads.length === 1 ? "" : "s"} ${state.reads.map(escapeHtml).join(", ")} when mentioned`
    : state.readAll
      ? `reads every ${where} it can see`
      : `reads ${[
          state.request === undefined ? direct : `${where} ${escapeHtml(state.request)}`,
          ...state.reads.map(escapeHtml),
        ].join(", ")}`;
  const status = statusTarget(state);
  return {
    title: state.label,
    sub: [
      `Bot token ending <code>${escapeHtml(state.tokenEnd ?? "")}</code>`,
      `answers ${escapeHtml(state.users.join(", "))}`,
      reads,
      status === undefined ? "no chat is set for status" : `status goes to ${at(status, direct)}`,
      state.home === undefined
        ? "no chat is set for alerts"
        : `alerts go to ${at(state.home, direct)}`,
    ].join(SEP),
    aside: `${statusText("done", "Connected")}${postButton(`/chat/${state.platform}/test`, "Send test message")}${menu(
      [
        { label: "Change channels", href: `/chat/${state.platform}/channels` },
        { label: "Disconnect", dialog: disconnectId(state), danger: true },
      ],
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
