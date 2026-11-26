/** The few Discord REST reads Hephaestus needs to find a request's thread. */
export interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; bot?: boolean };
}

export interface DiscordThread {
  id: string;
  parent_id: string | null;
}

export type Fetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const API = "https://discord.com/api/v10";

export class DiscordError extends Error {}

/** Reads from Discord as the factory's bot. The token goes only into the request header. */
export class DiscordApi {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetch = (url, init) => fetch(url, init),
  ) {}

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${API}${path}`, {
      headers: { Authorization: `Bot ${this.token}`, "User-Agent": "Hephaestus (factory bot)" },
    });
    if (!response.ok)
      throw new DiscordError(`Discord answered ${String(response.status)} for ${path}`);
    return (await response.json()) as T;
  }

  async botId(): Promise<string> {
    return (await this.get<{ id: string }>("/users/@me")).id;
  }

  async guildOf(channel: string): Promise<string> {
    const found = await this.get<{ guild_id?: string }>(`/channels/${channel}`);
    if (found.guild_id === undefined)
      throw new DiscordError(`Channel ${channel} is not in a server.`);
    return found.guild_id;
  }

  /** The server's active threads; Discord lists them for the whole server. */
  async activeThreads(guild: string): Promise<DiscordThread[]> {
    return (await this.get<{ threads: DiscordThread[] }>(`/guilds/${guild}/threads/active`))
      .threads;
  }

  async messages(channel: string, limit = 50): Promise<DiscordMessage[]> {
    return this.get<DiscordMessage[]>(`/channels/${channel}/messages?limit=${String(limit)}`);
  }
}
