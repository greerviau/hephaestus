import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import type { CardStore } from "./factory/cards.js";
import type { HermesRun } from "./hermes/cli.js";
import { getMeta, setMeta } from "./meta.js";

/** The factory role that talks to the owner in a chat; the owner never needs its name. */
const CHAT_ROLE = "planner";

export const PLATFORM_NAMES = ["telegram", "discord"] as const;
export type PlatformName = (typeof PLATFORM_NAMES)[number];

interface Platform {
  label: string;
  /** The `.env` keys Hermes reads for the platform's bot. */
  token: string;
  users: string;
  home: string;
  /** What a bot token looks like, so a pasted typo is caught before the gateway restarts. */
  tokenShape: RegExp;
  /** What a user or channel ID looks like. */
  idShape: RegExp;
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
    tokenShape: /^\d{5,}:[A-Za-z0-9_-]{30,}$/,
    idShape: /^-?\d{3,}$/,
    needsChannel: false,
    channelSettings: () => ({}),
  },
  discord: {
    label: "Discord",
    token: "DISCORD_BOT_TOKEN",
    users: "DISCORD_ALLOWED_USERS",
    home: "DISCORD_HOME_CHANNEL",
    tokenShape: /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/,
    idShape: /^\d{15,22}$/,
    needsChannel: true,
    // In the request channel the bot answers without an @mention, in a new thread per message.
    channelSettings: (channel) => ({
      DISCORD_FREE_RESPONSE_CHANNELS: channel,
      DISCORD_AUTO_THREAD: channel === undefined ? undefined : "true",
      DISCORD_FREE_RESPONSE_AUTO_THREAD: channel === undefined ? undefined : "true",
    }),
  },
};

export interface PlatformState {
  platform: PlatformName;
  label: string;
  connected: boolean;
  /** The token's last four characters, so the owner can tell which bot is connected. */
  tokenEnd: string | undefined;
  users: string[];
  /** Where alerts go: the home channel, or the first allowed user's direct chat. */
  home: string | undefined;
}

export class MessagingError extends Error {}

const ALERTS_KEY = "messaging_alerts";
const ALERTS_SENT_KEY = "messaging_alerts_sent";

export interface MessagingOptions {
  /** The factory Hermes root, whose profiles hold the chat's credentials. */
  root: string;
  run: HermesRun;
  /** Restarts the factory gateway, so a connected bot starts answering. */
  restartGateway: () => void;
  db: Database;
  cards: Pick<CardStore, "notifications">;
  /** The dashboard's address, for the link in each alert. */
  dashboardUrl: () => string;
}

/**
 * Connects Hephaestus to a messaging platform: the owner asks for work in the
 * chat, and Hephaestus can post its notifications there. The bot's
 * credentials live in the factory profile's `.env`, which only the owner can
 * read, and never in a config version or on a command line.
 */
export class Messaging {
  constructor(private readonly options: MessagingOptions) {}

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
      const users = (env.get(platform.users) ?? "")
        .split(",")
        .map((user) => user.trim())
        .filter((user) => user !== "");
      return {
        platform: name,
        label: platform.label,
        connected: token !== undefined && token !== "",
        tokenEnd: token === undefined || token === "" ? undefined : token.slice(-4),
        users,
        home: env.get(platform.home) ?? (name === "telegram" ? users[0] : undefined),
      };
    });
  }

  /** Saves the bot's credentials and restarts the gateway, so the bot starts answering. */
  connect(name: PlatformName, input: { token: string; users: string; home: string }): void {
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
    const users = input.users
      .split(/[\s,]+/)
      .map((user) => user.trim())
      .filter((user) => user !== "");
    if (users.length === 0 || !users.every((user) => platform.idShape.test(user))) {
      throw new MessagingError(
        `Give your numeric ${platform.label} user ID; separate several with commas. Only these users can use the bot.`,
      );
    }
    const home = input.home.trim();
    if (home === "" && platform.needsChannel) {
      throw new MessagingError(
        `Give the ID of the ${platform.label} channel for requests and alerts.`,
      );
    }
    if (home !== "" && !platform.idShape.test(home)) {
      throw new MessagingError(`The channel must be a numeric ${platform.label} ID.`);
    }
    this.writeEnv({
      [platform.token]: token,
      [platform.users]: users.join(","),
      [platform.home]: home === "" ? undefined : home,
      ...platform.channelSettings(home === "" ? undefined : home),
    });
    this.options.restartGateway();
  }

  disconnect(name: PlatformName): void {
    const platform = PLATFORMS[name];
    this.writeEnv({
      [platform.token]: undefined,
      [platform.users]: undefined,
      [platform.home]: undefined,
      ...platform.channelSettings(undefined),
    });
    this.options.restartGateway();
  }

  /** Sends a message through the platform, which proves the token and the chat work. */
  async send(name: PlatformName, text: string): Promise<void> {
    const state = this.states().find((entry) => entry.platform === name);
    if (state?.connected !== true)
      throw new MessagingError(`${PLATFORMS[name].label} is not connected.`);
    if (state.home === undefined) {
      throw new MessagingError(
        `Name a ${PLATFORMS[name].label} channel for alerts, so Hephaestus knows where to post.`,
      );
    }
    try {
      // The token stays in the profile's .env; the command line carries only the target.
      await this.options.run(
        ["-p", CHAT_ROLE, "send", "--quiet", "--to", `${name}:${state.home}`],
        {
          input: text,
        },
      );
    } catch (error) {
      throw new MessagingError(
        `${PLATFORMS[name].label} did not take the message: ${this.scrub(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  alertsOn(): boolean {
    return getMeta(this.options.db, ALERTS_KEY) === "on";
  }

  /** Turns alerts on from the newest notification, so earlier ones are not sent. */
  setAlerts(on: boolean): void {
    if (on) {
      const newest = this.options.cards.notifications()[0]?.id ?? 0;
      setMeta(this.options.db, ALERTS_SENT_KEY, String(newest));
    }
    setMeta(this.options.db, ALERTS_KEY, on ? "on" : "off");
  }

  /** Posts each notification newer than the last one sent to every connected platform. */
  async sendAlerts(): Promise<void> {
    if (!this.alertsOn()) return;
    const targets = this.states().filter((state) => state.connected && state.home !== undefined);
    if (targets.length === 0) return;
    const sent = Number(getMeta(this.options.db, ALERTS_SENT_KEY) ?? "0");
    const pending = this.options.cards
      .notifications()
      .filter((item) => item.id > sent)
      .sort((a, b) => a.id - b.id);
    for (const item of pending) {
      const text = `Hephaestus: ${item.text}\n${this.options.dashboardUrl()}`;
      for (const target of targets) {
        try {
          await this.send(target.platform, text);
        } catch (error) {
          // The notification stays on the dashboard; the next pass does not retry it.
          console.error(`Sending an alert to ${target.label} failed`, error);
        }
      }
      setMeta(this.options.db, ALERTS_SENT_KEY, String(item.id));
    }
  }

  private readEnv(): Map<string, string> {
    const env = new Map<string, string>();
    if (!existsSync(this.envPath)) return env;
    for (const line of readFileSync(this.envPath, "utf8").split("\n")) {
      const at = line.indexOf("=");
      if (at <= 0 || line.trimStart().startsWith("#")) continue;
      env.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
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
          .filter((line) => line !== "" && !keys.has(line.slice(0, line.indexOf("=")).trim()))
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
    for (const [key, value] of this.readEnv()) {
      if (Object.values(PLATFORMS).some((platform) => platform.token === key) && value !== "") {
        clean = clean.split(value).join("[token]");
      }
    }
    return clean.slice(0, 300);
  }
}
