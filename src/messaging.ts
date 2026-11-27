import { isProposal } from "./config/store.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import type { TaskStore } from "./factory/tasks.js";
import type { HermesRun } from "./hermes/cli.js";
import { getMeta, setMeta } from "./meta.js";

/** The factory role that talks to the owner in a chat; the owner never needs its name. */
const CHAT_ROLE = "communicator";

export const PLATFORM_NAMES = ["telegram", "discord", "slack"] as const;
export type PlatformName = (typeof PLATFORM_NAMES)[number];

interface Platform {
  label: string;
  /** The `.env` keys Hermes reads for the platform's bot. */
  token: string;
  users: string;
  /** Where Hermes posts its own notices, such as cron results and restarts. */
  home: string;
  /**
   * The list of channels Hermes answers in; with no list, it answers in every
   * channel the bot can see. Direct chats are never filtered.
   */
  readGate: string;
  /** Hephaestus's own keys, beside Hermes's, for the channels only Hephaestus uses. */
  requestKey: string;
  statusKey: string;
  alertsKey: string;
  /** What a bot token looks like, so a pasted typo is caught before the gateway restarts. */
  tokenShape: RegExp;
  /** What a channel ID looks like, and a user ID when `userShape` is absent. */
  idShape: RegExp;
  userShape?: RegExp;
  /** What a chat Hephaestus posts to looks like, such as a thread; `idShape` when absent. */
  chatShape?: RegExp;
  /** Whether IDs are numbers, so the forms bring up a number pad. */
  numericIds: boolean;
  /** How refusals name a user ID, a channel ID, and a list of channel IDs. */
  userIdText: string;
  channelIdText: string;
  channelIdsText: string;
  /**
   * A second token the bot needs, such as Slack's app-level token for Socket
   * Mode, kept and removed with the bot token.
   */
  appToken?: { key: string; shape: RegExp; text: string };
  /** Whether the platform needs a channel; Telegram can use the owner's direct chat instead. */
  needsChannel: boolean;
  /** Further `.env` settings for the channel, such as making it a request channel. */
  channelSettings: (channel: string | undefined) => Record<string, string | undefined>;
}

export const PLATFORMS: Record<PlatformName, Platform> = {
  telegram: {
    label: "Telegram",
    token: "TELEGRAM_BOT_TOKEN",
    users: "TELEGRAM_ALLOWED_USERS",
    home: "TELEGRAM_HOME_CHANNEL",
    readGate: "TELEGRAM_ALLOWED_CHATS",
    requestKey: "HEPHAESTUS_TELEGRAM_REQUEST_CHANNEL",
    statusKey: "HEPHAESTUS_TELEGRAM_STATUS_CHANNEL",
    alertsKey: "HEPHAESTUS_TELEGRAM_ALERTS_CHANNEL",
    tokenShape: /^\d{5,}:[A-Za-z0-9_-]{30,}$/,
    idShape: /^-?\d{3,}$/,
    numericIds: true,
    userIdText: "numeric Telegram user ID",
    channelIdText: "numeric Telegram ID",
    channelIdsText: "numeric IDs",
    needsChannel: false,
    channelSettings: () => ({}),
  },
  discord: {
    label: "Discord",
    token: "DISCORD_BOT_TOKEN",
    users: "DISCORD_ALLOWED_USERS",
    home: "DISCORD_HOME_CHANNEL",
    readGate: "DISCORD_ALLOWED_CHANNELS",
    requestKey: "HEPHAESTUS_DISCORD_REQUEST_CHANNEL",
    statusKey: "HEPHAESTUS_DISCORD_STATUS_CHANNEL",
    alertsKey: "HEPHAESTUS_DISCORD_ALERTS_CHANNEL",
    tokenShape: /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/,
    idShape: /^\d{15,22}$/,
    numericIds: true,
    userIdText: "numeric Discord user ID",
    channelIdText: "numeric Discord ID",
    channelIdsText: "numeric IDs",
    needsChannel: true,
    // In the request channel the bot answers without an @mention, in a new thread per message.
    channelSettings: (channel) => ({
      DISCORD_FREE_RESPONSE_CHANNELS: channel,
      DISCORD_AUTO_THREAD: channel === undefined ? undefined : "true",
      DISCORD_FREE_RESPONSE_AUTO_THREAD: channel === undefined ? undefined : "true",
    }),
  },
  slack: {
    label: "Slack",
    token: "SLACK_BOT_TOKEN",
    users: "SLACK_ALLOWED_USERS",
    home: "SLACK_HOME_CHANNEL",
    readGate: "SLACK_ALLOWED_CHANNELS",
    requestKey: "HEPHAESTUS_SLACK_REQUEST_CHANNEL",
    statusKey: "HEPHAESTUS_SLACK_STATUS_CHANNEL",
    alertsKey: "HEPHAESTUS_SLACK_ALERTS_CHANNEL",
    tokenShape: /^xoxb-[A-Za-z0-9-]{20,}$/,
    // Hermes's Slack adapter connects over Socket Mode, which needs an app-level token too.
    appToken: {
      key: "SLACK_APP_TOKEN",
      shape: /^xapp-[A-Za-z0-9-]{20,}$/,
      text: "Slack app-level token (xapp-...)",
    },
    // Public and private channels, and direct chats; member IDs start with U or W.
    idShape: /^[CGD][A-Z0-9]{8,}$/,
    userShape: /^[UW][A-Z0-9]{8,}$/,
    // A thread is its channel and the timestamp of its first message, the form Hermes sends to.
    chatShape: /^[CGD][A-Z0-9]{8,}(:\d+\.\d+)?$/,
    numericIds: false,
    userIdText: "Slack member ID, such as U0123ABCD",
    channelIdText: "Slack channel ID, such as C0123ABCD",
    channelIdsText: "IDs such as C0123ABCD",
    needsChannel: true,
    // In the request channel the bot answers without an @mention; Hermes replies in a thread
    // under each message by default.
    channelSettings: (channel) => ({ SLACK_FREE_RESPONSE_CHANNELS: channel }),
  },
};

export interface PlatformState {
  platform: PlatformName;
  label: string;
  connected: boolean;
  /** The token's last four characters, so the owner can tell which bot is connected. */
  tokenEnd: string | undefined;
  users: string[];
  /** The request channel, where the bot answers without an @mention; undefined is the direct chat. */
  request: string | undefined;
  /** Whether the bot reads every channel it can see. */
  readAll: boolean;
  /** Channels the bot reads besides the request channel, when it does not read them all. */
  reads: string[];
  /** The channel for status posts, when one is set apart. */
  status: string | undefined;
  /** The channel for alerts, when one is set apart. */
  alerts: string | undefined;
  /** Where alerts go: the alerts channel, the status channel, the request channel, or the first allowed user's direct chat. */
  home: string | undefined;
}

/**
 * Which channels the bot reads and where Hephaestus posts. Read lists are
 * IDs separated by commas, spaces, or lines.
 */
export interface ChannelInput {
  home: string;
  reads?: string;
  readAll?: boolean;
  status?: string;
  alerts?: string;
}

/** What kind of post a message is, which picks its channel. */
export type PostKind = "status" | "alerts";

/** Channels the bot reads besides the request channel, at most. */
const MAX_READS = 50;

export class MessagingError extends Error {}

/** The credentials were saved or removed, but the gateway did not reconnect. */
export class RestartError extends MessagingError {}

/** Failed sends of one alert retried on later passes before it is given up. */
const ALERT_ATTEMPTS = 3;

/**
 * Text from outside, such as an escalation's reason, cannot attach a file:
 * Hermes reads `MEDIA:<path>` in a message as an attachment.
 */
export function neutralize(text: string): string {
  return text.replace(/MEDIA:/gi, "MEDIA :");
}

const ALERTS_KEY = "messaging_alerts";
const ALERTS_SENT_KEY = "messaging_alerts_sent";
const EXTRA_SENT_KEY = "messaging_alerts_extra";

/**
 * Something that needs the owner, outside the task notifications. An item is
 * sent once per key while its group keeps appearing; a quiet item is never
 * sent, and only keeps its group's sent keys, such as a worker whose checks
 * are running again.
 */
export interface ExtraAlert {
  key: string;
  text: string;
  /** Items about the same thing; the key alone when absent. */
  group?: string;
  quiet?: boolean;
}

/** A chat alert for each proposal that waits for the owner, naming the page that approves it. */
export function proposalAlerts(
  versions: readonly { id: number; author: string; state: string }[],
): ExtraAlert[] {
  return versions
    .filter((version) => isProposal(version) && version.state === "draft")
    .map((version) => ({
      key: `proposal-${String(version.id)}`,
      text: `Config version ${String(version.id)} is proposed and waits for your approval on Proposals.`,
    }));
}

export interface MessagingOptions {
  /** The factory Hermes root, whose profiles hold the chat's credentials. */
  root: string;
  run: HermesRun;
  /**
   * Reconnects the chat profile's bots with its current settings. When absent,
   * `hermes -p <profile> gateway restart` does it, which leaves the other
   * profiles' work running.
   */
  restartGateway?: () => Promise<void>;
  /**
   * The factory gateway's service. A failed restart starts it when it is not
   * running, since a profile cannot restart without the gateway that serves it.
   */
  gateway?: { stopped(): boolean; start(): void };
  db: Database;
  tasks: Pick<TaskStore, "notifications">;
  /** The dashboard's address, for the link in each alert. */
  dashboardUrl: () => string;
  /** Other things that need the owner, such as a proposal or a worker sign-in, each keyed so it is sent once. */
  extraAlerts?: () => ExtraAlert[];
}

/**
 * Connects Hephaestus to a messaging platform: the owner asks for work in the
 * chat, and Hephaestus can post its notifications there. The bot's
 * credentials live in the factory profile's `.env`, which only the owner can
 * read, and never in a config version or on a command line.
 */
export class Messaging {
  /** The pass of alerts that is running, so passes never overlap. */
  private sending: Promise<void> | undefined;
  /** Failed sends of each alert, by key, so a later pass retries it. */
  private readonly attempts = new Map<string, { tries: number; done: Set<PlatformName> }>();

  constructor(private readonly options: MessagingOptions) {}

  /** Reconnects the chat profile's bots, so a change of credentials takes effect. */
  async restart(): Promise<void> {
    try {
      if (this.options.restartGateway !== undefined) await this.options.restartGateway();
      else await this.options.run(["-p", CHAT_ROLE, "gateway", "restart", "--yes"]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Hermes's wording for a stopped gateway is not stable, so systemd is asked instead.
      const gateway = this.options.gateway;
      let stopped = false;
      try {
        stopped = gateway !== undefined && gateway.stopped();
      } catch (check) {
        console.error("Checking the factory gateway failed", check);
      }
      if (gateway !== undefined && stopped) {
        try {
          gateway.start();
          return;
        } catch (start) {
          throw new RestartError(
            `The settings were saved, but the factory gateway is not running and did not start: ${this.scrub(start instanceof Error ? start.message : String(start))}`,
          );
        }
      }
      throw new RestartError(
        `The settings were saved, but the messaging gateway did not restart: ${this.scrub(message)}`,
      );
    }
  }

  private get profileDir(): string {
    return join(this.options.root, "profiles", CHAT_ROLE);
  }

  private get envPath(): string {
    return join(this.profileDir, ".env");
  }

  /** Whether the factory's Hermes profiles exist yet; the first deploy creates them. */
  ready(): boolean {
    return existsSync(this.profileDir);
  }

  states(): PlatformState[] {
    const env = this.readEnv();
    return PLATFORM_NAMES.map((name) => {
      const platform = PLATFORMS[name];
      const token = env.get(platform.token);
      const users = idList(env.get(platform.users) ?? "");
      // A bot saved before the request channel had a key of its own used Hermes's home channel.
      const request = env.has(platform.requestKey)
        ? setting(env, platform.requestKey)
        : setting(env, platform.home);
      const status = setting(env, platform.statusKey);
      const alerts = setting(env, platform.alertsKey);
      const gate = env.get(platform.readGate);
      const readAll = gate === undefined || gate.trim() === "" || idList(gate).includes("*");
      const own = new Set([request, ...(name === "telegram" ? users : [])]);
      return {
        platform: name,
        label: platform.label,
        connected: token !== undefined && token !== "",
        tokenEnd: token === undefined || token === "" ? undefined : token.slice(-4),
        users,
        request,
        readAll,
        reads: readAll ? [] : idList(gate).filter((id) => !own.has(id)),
        status,
        alerts,
        home: alerts ?? status ?? request ?? (name === "telegram" ? users[0] : undefined),
      };
    });
  }

  /** Saves the bot's credentials and restarts the gateway, so the bot starts answering. */
  async connect(
    name: PlatformName,
    input: { token: string; appToken?: string; users: string } & ChannelInput,
  ): Promise<void> {
    if (!this.ready()) {
      throw new MessagingError("Deploy a config version first; it sets up the factory's Hermes.");
    }
    const platform = PLATFORMS[name];
    const token = input.token.trim();
    if (!platform.tokenShape.test(token)) {
      throw new MessagingError(
        `That does not look like a ${platform.label} bot token. Paste the whole token.`,
      );
    }
    const appToken = input.appToken?.trim() ?? "";
    if (platform.appToken !== undefined && !platform.appToken.shape.test(appToken)) {
      throw new MessagingError(
        `That does not look like a ${platform.appToken.text}. Paste the whole token.`,
      );
    }
    const users = input.users
      .split(/[\s,]+/)
      .map((user) => user.trim())
      .filter((user) => user !== "");
    const userShape = platform.userShape ?? platform.idShape;
    if (users.length === 0 || !users.every((user) => userShape.test(user))) {
      throw new MessagingError(
        `Give your ${platform.userIdText}; separate several with commas. Only these users can use the bot.`,
      );
    }
    const channels = this.channelSettings(name, input, users);
    this.writeEnv({
      [platform.token]: token,
      ...(platform.appToken === undefined ? {} : { [platform.appToken.key]: appToken }),
      [platform.users]: users.join(","),
      ...channels,
    });
    await this.restart();
  }

  /** Changes a connected bot's channels, keeping its token and users, and restarts the gateway. */
  async setChannels(name: PlatformName, input: ChannelInput): Promise<void> {
    const state = this.states().find((entry) => entry.platform === name);
    if (state?.connected !== true) {
      throw new MessagingError(`${PLATFORMS[name].label} is not connected.`);
    }
    this.writeEnv(this.channelSettings(name, input, state.users));
    await this.restart();
  }

  /**
   * The .env settings for the bot's channels, checked before anything is
   * written. Hermes enforces the read list itself: the bot never sees a
   * message from a channel outside it, whatever its instructions say.
   */
  private channelSettings(
    name: PlatformName,
    input: ChannelInput,
    users: string[],
  ): Record<string, string | undefined> {
    const platform = PLATFORMS[name];
    const home = input.home.trim();
    if (home === "" && platform.needsChannel) {
      throw new MessagingError(
        `Give the ID of the ${platform.label} channel for requests and alerts.`,
      );
    }
    if (home !== "" && !platform.idShape.test(home)) {
      throw new MessagingError(`The channel must be a ${platform.channelIdText}.`);
    }
    const request = home === "" ? undefined : home;
    const single = (value: string | undefined, what: string): string | undefined => {
      const id = value?.trim() ?? "";
      if (id === "") return undefined;
      if (!platform.idShape.test(id)) {
        throw new MessagingError(`The ${what} must be a ${platform.channelIdText}.`);
      }
      return id;
    };
    const status = single(input.status, "status channel");
    const alerts = single(input.alerts, "alerts channel");
    const readAll = input.readAll === true;
    const listed = readAll ? [] : idList(input.reads ?? "");
    const wrong = listed.find((id) => !platform.idShape.test(id));
    if (wrong !== undefined) {
      throw new MessagingError(
        `${wrong} is not a ${platform.label} channel ID. Give ${platform.channelIdsText}, separated by commas.`,
      );
    }
    const reads = [...new Set(listed)].filter((id) => id !== request);
    if (reads.length > MAX_READS) {
      throw new MessagingError(
        `List at most ${String(MAX_READS)} channels, or let the bot read every channel.`,
      );
    }
    // Direct chats are never filtered, so the owner's own chat stands in when the
    // list would be empty and would otherwise mean every group.
    const gate = [...(request === undefined ? users.slice(0, 1) : [request]), ...reads];
    return {
      // Written even when empty, so an empty request channel is not read as one saved before it had a key.
      [platform.requestKey]: request ?? "",
      [platform.statusKey]: status,
      [platform.alertsKey]: alerts,
      [platform.home]: status ?? request,
      [platform.readGate]: readAll ? undefined : gate.join(","),
      ...platform.channelSettings(request),
    };
  }

  async disconnect(name: PlatformName): Promise<void> {
    const platform = PLATFORMS[name];
    this.writeEnv({
      [platform.token]: undefined,
      ...(platform.appToken === undefined ? {} : { [platform.appToken.key]: undefined }),
      [platform.users]: undefined,
      [platform.home]: undefined,
      [platform.readGate]: undefined,
      [platform.requestKey]: undefined,
      [platform.statusKey]: undefined,
      [platform.alertsKey]: undefined,
      ...platform.channelSettings(undefined),
    });
    await this.restart();
  }

  /**
   * Sends a message to the platform's channel for its kind: alerts to the
   * alerts channel, status to the status channel, each falling back the way
   * `statusTarget` and `home` say.
   */
  async send(name: PlatformName, text: string, kind: PostKind = "status"): Promise<void> {
    const state = this.states().find((entry) => entry.platform === name);
    if (state?.connected !== true) {
      throw new MessagingError(`${PLATFORMS[name].label} is not connected.`);
    }
    const chat = kind === "alerts" ? state.home : statusTarget(state);
    if (chat === undefined) {
      throw new MessagingError(
        `Name a ${PLATFORMS[name].label} channel for alerts, so Hephaestus knows where to post.`,
      );
    }
    await this.sendTo(name, chat, text);
  }

  /**
   * Sends a message to one chat or thread on the platform. With `attachments`,
   * a line `MEDIA:<path>` in the text attaches that file; otherwise such a tag
   * is neutralized, so outside text cannot attach one.
   */
  async sendTo(name: PlatformName, chat: string, text: string, attachments = false): Promise<void> {
    const platform = PLATFORMS[name];
    if (!(platform.chatShape ?? platform.idShape).test(chat))
      throw new MessagingError(`${chat} is not a chat ID.`);
    try {
      // The token stays in the profile's .env; the command line carries only the target. Hermes
      // reports why a send failed only without --quiet.
      await this.options.run(["-p", CHAT_ROLE, "send", "--to", `${name}:${chat}`], {
        input: attachments ? text : neutralize(text),
      });
    } catch (error) {
      throw new MessagingError(
        `${platform.label} did not take the message: ${this.scrub(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  /** The connected bot's token and request channel, for reads Hephaestus makes as the bot itself. */
  credentials(name: PlatformName): { token: string; request: string | undefined } | undefined {
    const token = this.readEnv().get(PLATFORMS[name].token);
    if (token === undefined || token === "") return undefined;
    return { token, request: this.states().find((state) => state.platform === name)?.request };
  }

  alertsOn(): boolean {
    return getMeta(this.options.db, ALERTS_KEY) === "on";
  }

  /** Turns alerts on from the newest notification, so earlier ones are not sent. */
  setAlerts(on: boolean): void {
    if (on) {
      const newest = this.options.tasks.notifications()[0]?.id ?? 0;
      setMeta(this.options.db, ALERTS_SENT_KEY, String(newest));
      this.saveExtraSent(
        (this.options.extraAlerts?.() ?? [])
          .filter((item) => item.quiet !== true)
          .map((item) => this.extraKey(item)),
      );
    }
    setMeta(this.options.db, ALERTS_KEY, on ? "on" : "off");
  }

  /** Posts each notification newer than the last one sent to every connected platform. */
  sendAlerts(): Promise<void> {
    this.sending ??= this.alertPass().finally(() => {
      this.sending = undefined;
    });
    return this.sending;
  }

  private async alertPass(): Promise<void> {
    if (!this.alertsOn()) return;
    const targets = this.states().filter((state) => state.connected && state.home !== undefined);
    if (targets.length === 0) return;
    const sent = Number(getMeta(this.options.db, ALERTS_SENT_KEY) ?? "0");
    const pending = this.options.tasks
      .notifications()
      .filter((item) => item.id > sent)
      .sort((a, b) => a.id - b.id);
    for (const item of pending) {
      if (!(await this.deliver(`notice-${String(item.id)}`, item.text, targets))) return;
      // Never backwards, though only one pass runs at a time.
      const stored = Number(getMeta(this.options.db, ALERTS_SENT_KEY) ?? "0");
      setMeta(this.options.db, ALERTS_SENT_KEY, String(Math.max(stored, item.id)));
    }
    const extras = this.options.extraAlerts?.() ?? [];
    const sentExtra = new Set(this.extraSent());
    for (const item of extras) {
      if (item.quiet === true || sentExtra.has(this.extraKey(item))) continue;
      if (!(await this.deliver(item.key, item.text, targets))) break;
      sentExtra.add(this.extraKey(item));
    }
    // Keys of groups that went away are dropped, so an item that comes back is sent again.
    const groups = new Set(extras.map((item) => item.group ?? item.key));
    this.saveExtraSent([...sentExtra].filter((key) => groups.has(key.split("\n")[0] ?? "")));
  }

  /** The stored form of a sent item: its group, a line break, and its key. */
  private extraKey(item: ExtraAlert): string {
    return `${item.group ?? item.key}\n${item.key}`;
  }

  private extraSent(): string[] {
    try {
      const parsed: unknown = JSON.parse(getMeta(this.options.db, EXTRA_SENT_KEY) ?? "[]");
      return Array.isArray(parsed)
        ? parsed.filter((key): key is string => typeof key === "string")
        : [];
    } catch {
      return [];
    }
  }

  private saveExtraSent(keys: string[]): void {
    setMeta(this.options.db, EXTRA_SENT_KEY, JSON.stringify(keys.slice(-500)));
  }

  /**
   * Sends one alert to every target. A failed send is retried on later passes,
   * up to a limit, and stops this pass so alerts keep their order. Returns true
   * once the alert is done with.
   */
  private async deliver(key: string, text: string, targets: PlatformState[]): Promise<boolean> {
    const record = this.attempts.get(key) ?? { tries: 0, done: new Set<PlatformName>() };
    let failed = false;
    for (const target of targets) {
      // A retry goes only to the platforms that did not take the alert yet.
      if (record.done.has(target.platform)) continue;
      try {
        await this.send(
          target.platform,
          `Hephaestus: ${text}\n${this.options.dashboardUrl()}`,
          "alerts",
        );
        record.done.add(target.platform);
      } catch (error) {
        failed = true;
        console.error(`Sending an alert to ${target.label} failed`, error);
      }
    }
    record.tries += 1;
    if (!failed || record.tries >= ALERT_ATTEMPTS) {
      // Delivered, or given up; the item is still on the dashboard either way.
      this.attempts.delete(key);
      return true;
    }
    this.attempts.set(key, record);
    return false;
  }

  private readEnv(): Map<string, string> {
    const env = new Map<string, string>();
    if (!existsSync(this.envPath)) return env;
    for (const line of readFileSync(this.envPath, "utf8").split("\n")) {
      const at = line.indexOf("=");
      if (at <= 0 || line.trimStart().startsWith("#")) continue;
      env.set(envKey(line), unquote(line.slice(at + 1)));
    }
    return env;
  }

  /** Sets or removes keys in the profile's .env and keeps every other line, written owner-only. */
  private writeEnv(changes: Record<string, string | undefined>): void {
    mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    const keys = new Set(Object.keys(changes));
    const lines = existsSync(this.envPath)
      ? readFileSync(this.envPath, "utf8")
          .split("\n")
          .filter((line) => line !== "" && !keys.has(envKey(line)))
      : [];
    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined) lines.push(`${key}=${value}`);
    }
    const temporary = `${this.envPath}.hephaestus-tmp`;
    writeFileSync(temporary, lines.length === 0 ? "" : `${lines.join("\n")}\n`, { mode: 0o600 });
    renameSync(temporary, this.envPath);
  }

  /** Removes any bot token from a message before it is shown or logged. */
  private scrub(text: string): string {
    let clean = text;
    const tokens = new Set(
      Object.values(PLATFORMS).flatMap((platform) => [platform.token, platform.appToken?.key]),
    );
    for (const [key, value] of this.readEnv()) {
      if (tokens.has(key) && value !== "") {
        clean = clean.split(value).join("[token]");
      }
    }
    return clean.slice(0, 300);
  }
}

/** Where status posts go: the status channel, the request channel, or the first allowed user's direct chat. */
export function statusTarget(state: PlatformState): string | undefined {
  return (
    state.status ?? state.request ?? (state.platform === "telegram" ? state.users[0] : undefined)
  );
}

/** IDs separated by commas, spaces, or lines. */
function idList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter((id) => id !== "");
}

/** A .env value, or undefined when it is missing or empty. */
function setting(env: Map<string, string>, key: string): string | undefined {
  const value = env.get(key)?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** A .env line's key, without an `export` in front. */
function envKey(line: string): string {
  return line
    .slice(0, Math.max(0, line.indexOf("=")))
    .trim()
    .replace(/^export\s+/, "");
}

/** A .env value without its quotes, or without a trailing comment when it is unquoted. */
function unquote(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
    return value.slice(1, value.lastIndexOf(quote));
  }
  return value.replace(/\s+#.*$/, "");
}
