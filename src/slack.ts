import type { Fetch } from "./discord.js";

/** The few Slack Web API reads Hephaestus needs to find a request's thread. */
export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
}

const API = "https://slack.com/api";

export class SlackError extends Error {}

/** Reads from Slack as the factory's bot. The token goes only into the request header. */
export class SlackApi {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetch = (url, init) => fetch(url, init),
  ) {}

  private async get<T>(method: string, query: Record<string, string | undefined>): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, value);
    }
    const response = await this.fetcher(`${API}/${method}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${this.token}`, "User-Agent": "Hephaestus (factory bot)" },
    });
    if (!response.ok) {
      throw new SlackError(`Slack answered ${String(response.status)} for ${method}`);
    }
    // Slack answers 200 for most failures and says why in the body.
    const body = (await response.json()) as { ok?: boolean; error?: string } & T;
    if (body.ok !== true) {
      throw new SlackError(`Slack refused ${method}: ${body.error ?? "no reason given"}`);
    }
    return body;
  }

  /** The bot's own member ID, which its messages carry as their user. */
  async botId(): Promise<string> {
    return (await this.get<{ user_id: string }>("auth.test", {})).user_id;
  }

  /** A channel's newest top-level messages, newest first. */
  async history(channel: string, limit = 100): Promise<SlackMessage[]> {
    return (
      await this.get<{ messages: SlackMessage[] }>("conversations.history", {
        channel,
        limit: String(limit),
      })
    ).messages;
  }

  /** A thread's messages, oldest first, or only those after `oldest` when it is given. */
  async replies(
    channel: string,
    ts: string,
    oldest?: string,
    limit = 200,
  ): Promise<SlackMessage[]> {
    return (
      await this.get<{ messages: SlackMessage[] }>("conversations.replies", {
        channel,
        ts,
        oldest,
        limit: String(limit),
      })
    ).messages;
  }
}

/** A Slack timestamp as a number that keeps its order; Slack writes six digits after the point. */
export function tsOrder(ts: string): bigint {
  const [seconds = "0", micros = ""] = ts.split(".");
  return BigInt(seconds) * 1_000_000n + BigInt(micros.padEnd(6, "0").slice(0, 6) || "0");
}
