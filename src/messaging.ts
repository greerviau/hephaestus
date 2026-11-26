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
  async connect(
    name: PlatformName,
    input: { token: string; users: string; home: string },
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
    await this.restart();
  }

  async disconnect(name: PlatformName): Promise<void> {
    const platform = PLATFORMS[name];
    this.writeEnv({
      [platform.token]: undefined,
      [platform.users]: undefined,
      [platform.home]: undefined,
      ...platform.channelSettings(undefined),
    });
    await this.restart();
  }

  /** Sends a message to the platform's home chat, which proves the token and the chat work. */
  async send(name: PlatformName, text: string): Promise<void> {
    const state = this.states().find((entry) => entry.platform === name);
    if (state?.connected !== true) {
      throw new MessagingError(`${PLATFORMS[name].label} is not connected.`);
    }
    if (state.home === undefined) {
      throw new MessagingError(
        `Name a ${PLATFORMS[name].label} channel for alerts, so Hephaestus knows where to post.`,
      );
    }
    await this.sendTo(name, state.home, text);
  }

  /**
   * Sends a message to one chat or thread on the platform. With `attachments`,
   * a line `MEDIA:<path>` in the text attaches that file; otherwise such a tag
   * is neutralized, so outside text cannot attach one.
   */
  async sendTo(name: PlatformName, chat: string, text: string, attachments = false): Promise<void> {
    if (!PLATFORMS[name].idShape.test(chat)) throw new MessagingError(`${chat} is not a chat ID.`);
    try {
      // The token stays in the profile's .env; the command line carries only the target. Hermes
      // reports why a send failed only without --quiet.
      await this.options.run(["-p", CHAT_ROLE, "send", "--to", `${name}:${chat}`], {
        input: attachments ? text : neutralize(text),
      });
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
    const pending = this.options.cards
      .notifications()
      .filter((item) => item.id > sent)
      .sort((a, b) => a.id - b.id);
    for (const item of pending) {
      if (!(await this.deliver(`notice-${String(item.id)}`, item.text, targets))) return;
      // Never backwards, though only one pass runs at a time.
      const stored = Number(getMeta(this.options.db, ALERTS_SENT_KEY) ?? "0");
      setMeta(this.options.db, ALERTS_SENT_KEY, String(Math.max(stored, item.id)));
    }
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
        await this.send(target.platform, `Hephaestus: ${text}\n${this.options.dashboardUrl()}`);
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
    for (const [key, value] of this.readEnv()) {
      if (Object.values(PLATFORMS).some((platform) => platform.token === key) && value !== "") {
        clean = clean.split(value).join("[token]");
      }
    }
    return clean.slice(0, 300);
  }
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
