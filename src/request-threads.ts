import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { DiscordApi, type Fetch } from "./discord.js";
import type { Card, CardEvent, CardStore } from "./factory/cards.js";
import type { GitHub } from "./factory/github.js";
import { getMeta, setMeta } from "./meta.js";
import type { Messaging } from "./messaging.js";

/** The line a reply in a request's thread carries, which ties the thread to the issue. */
export function trackingLine(repo: string, number: number): string {
  return `Tracking ${repo}#${String(number)}`;
}

/** A tracking line on its own line, perhaps in backticks; quoted text inside a sentence does not count. */
const TRACKING = /^[ \t>*_-]*`?Tracking ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)`?[ \t.*_]*$/gm;
const CURSOR_KEY = "request_threads_event";

/** Where the engineer pushes evidence for a card: a ref outside every branch. */
export function evidenceRef(cardId: number): string {
  return `hephaestus/evidence/card-${String(cardId)}`;
}

export interface RequestThreadsOptions {
  db: Database;
  cards: Pick<CardStore, "get" | "list">;
  messaging: Pick<Messaging, "credentials" | "sendTo">;
  github: Pick<GitHub, "evidence">;
  dashboardUrl: () => string;
  fetcher?: Fetch;
  now?: () => Date;
}

interface Thread {
  platform: "discord";
  chat: string;
}

/**
 * Follows each request made in the chat through its work. A request's thread
 * is found by the tracking line the factory posts in it after filing the
 * issue, and each milestone of the issue's card is posted there: work
 * started, PR opened with any evidence the engineer pushed, review results,
 * merged, checks passed on the default branch, reverted, and anything that
 * needs the owner.
 */
export class RequestThreads {
  private readonly now: () => Date;
  private bot: { token: string; id: string; guild: string } | undefined;

  constructor(private readonly options: RequestThreadsOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private get db(): Database {
    return this.options.db;
  }

  /** Finds threads in the request channel whose tracking line names an issue not yet followed. */
  async link(): Promise<void> {
    const credentials = this.options.messaging.credentials("discord");
    if (credentials?.home === undefined) return;
    const api = new DiscordApi(credentials.token, this.options.fetcher);
    if (this.bot?.token !== credentials.token) {
      this.bot = {
        token: credentials.token,
        id: await api.botId(),
        guild: await api.guildOf(credentials.home),
      };
    }
    const { id: botId, guild } = this.bot;
    const threads = (await api.activeThreads(guild)).filter(
      (thread) => thread.parent_id === credentials.home,
    );
    for (const thread of threads) {
      // Each thread is read from the last message seen, so a request that files a second
      // issue later is followed for that one too.
      const seenKey = `thread_seen_${thread.id}`;
      const seen = getMeta(this.db, seenKey);
      let messages;
      try {
        messages = await api.messages(thread.id, 50, seen);
      } catch (error) {
        // One thread the bot cannot read does not stop the others.
        console.error(`Reading thread ${thread.id} failed`, error);
        continue;
      }
      const newest = messages.reduce<string | undefined>(
        (top, message) =>
          top === undefined || BigInt(message.id) > BigInt(top) ? message.id : top,
        seen,
      );
      // Only the bot's own words count, so nobody else can point the factory at a thread.
      for (const message of messages) {
        if (message.author.id !== botId) continue;
        for (const match of message.content.matchAll(TRACKING)) {
          if (match[1] === undefined || match[2] === undefined) continue;
          await this.follow(match[1], Number(match[2]), { platform: "discord", chat: thread.id });
        }
      }
      if (newest !== undefined) setMeta(this.db, seenKey, newest);
    }
  }

  /** Starts following an issue in a thread, and catches the thread up on its card at once. */
  async follow(repo: string, number: number, thread: Thread): Promise<void> {
    // Only an issue Hephaestus tracks can be followed, so a stray line cannot claim another repo's.
    const tracked = this.db
      .prepare("SELECT repo FROM issues WHERE repo = ? COLLATE NOCASE AND number = ?")
      .get(repo, number) as { repo: string } | undefined;
    if (tracked === undefined) return;
    repo = tracked.repo;
    const result = this.db
      .prepare(
        `INSERT INTO chat_threads (repo, number, platform, chat, linked_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (repo, number) DO NOTHING`,
      )
      .run(repo, number, thread.platform, thread.chat, this.now().toISOString());
    if (result.changes === 0) return;
    const card = this.options.cards
      .list()
      .find(
        (item) => item.repo.toLowerCase() === repo.toLowerCase() && item.issueNumber === number,
      );
    await this.post(
      thread,
      `Following ${repo}#${String(number)}${card === undefined ? "." : `: ${stageText(card)}`} Progress shows up here.`,
    );
  }

  /** Posts the milestones of followed cards that happened since the last pass. */
  async progress(): Promise<void> {
    const last = getMeta(this.db, CURSOR_KEY);
    const newest =
      (this.db.prepare("SELECT MAX(id) AS id FROM card_events").get() as { id: number | null })
        .id ?? 0;
    // On the first pass nothing earlier is posted; threads start from their tracking line.
    if (last === undefined) setMeta(this.db, CURSOR_KEY, String(newest));
    const events =
      last === undefined
        ? []
        : (this.db
            .prepare(
              "SELECT id, card_id AS cardId, at, kind, detail FROM card_events WHERE id > ? ORDER BY id LIMIT 200",
            )
            .all(Number(last)) as CardEvent[]);
    for (const event of events) {
      const card = this.options.cards.get(event.cardId);
      const thread =
        card.issueNumber === null ? undefined : this.threadFor(card.repo, card.issueNumber);
      const text =
        thread === undefined ? undefined : milestone(event, card, this.options.dashboardUrl());
      if (thread !== undefined && text !== undefined) await this.post(thread, text);
      // Saved before the evidence, so a failure there cannot hold the feed on this event.
      setMeta(this.db, CURSOR_KEY, String(event.id));
      const opened =
        event.kind === "stage:Reviewing" ||
        (event.kind === "stage:Merging" && event.detail.includes("needs no review"));
      if (thread !== undefined && text !== undefined && (opened || event.kind === "stage:Done")) {
        await this.postEvidence(thread, card);
      }
    }
  }

  private threadFor(repo: string, number: number): Thread | undefined {
    const row = this.db
      .prepare("SELECT platform, chat FROM chat_threads WHERE repo = ? AND number = ?")
      .get(repo, number) as { platform: string; chat: string } | undefined;
    return row?.platform === "discord" ? { platform: "discord", chat: row.chat } : undefined;
  }

  /** Posts to a thread; only Hephaestus's own evidence lines may attach files. True when sent. */
  private async post(thread: Thread, text: string, attachments = false): Promise<boolean> {
    try {
      await this.options.messaging.sendTo(thread.platform, thread.chat, text, attachments);
      return true;
    } catch (error) {
      // A thread that cannot be reached loses this update; the dashboard still has it.
      console.error(`Posting to thread ${thread.chat} failed`, error);
      return false;
    }
  }

  /** Attaches the evidence the engineer pushed for the card, once per set of files. */
  private async postEvidence(thread: Thread, card: Card): Promise<void> {
    const key = `evidence_posted_${String(card.id)}`;
    let evidence;
    try {
      evidence = await this.options.github.evidence(card.repo, evidenceRef(card.id));
    } catch (error) {
      console.error(`Reading the evidence for card ${String(card.id)} failed`, error);
      return;
    }
    if (evidence === undefined || evidence.files.length === 0) return;
    if (getMeta(this.db, key) === evidence.tree) return;
    let folder: string | undefined;
    try {
      folder = mkdtempSync(join(tmpdir(), "hephaestus-evidence-"));
      let attached = 0;
      for (const file of evidence.files) {
        // Only the file's own name, short, so a path in the tree cannot write outside the folder.
        const name = file.name
          .replace(/[^A-Za-z0-9._-]/g, "_")
          .replace(/^\.+/, "_")
          .slice(-100);
        const path = join(folder, name);
        writeFileSync(path, file.data, { mode: 0o600 });
        if (await this.post(thread, `Evidence: ${name}\nMEDIA:${path}`, true)) attached += 1;
      }
      if (attached > 0) setMeta(this.db, key, evidence.tree);
    } catch (error) {
      console.error(`Attaching the evidence for card ${String(card.id)} failed`, error);
    } finally {
      if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
    }
  }
}

/** What the card is doing now, in a few words, for a thread that starts following it late. */
function stageText(card: Card): string {
  switch (card.stage) {
    case "Admitted":
      return "it is admitted and waiting to start.";
    case "Implementing":
      return "the engineer is working on it.";
    case "Reviewing":
      return `PR #${String(card.prNumber ?? 0)} is in review.`;
    case "Merging":
      return "it is about to merge.";
    case "Validating":
      return "it merged, and checks are running on the default branch.";
    case "Reverting":
      return "its merge is being reverted.";
    case "Escalated":
      return "it is waiting for a decision.";
    case "Done":
      return "it is done.";
    case "Abandoned":
      return "it was abandoned.";
  }
}

/** The thread message for a card event, or undefined when the event is not a milestone. */
export function milestone(event: CardEvent, card: Card, dashboard: string): string | undefined {
  const pr = (number: number | null): string =>
    number === null ? "the PR" : `https://github.com/${card.repo}/pull/${String(number)}`;
  const detail = event.detail;
  switch (event.kind) {
    case "stage:Implementing":
      if (detail === "work started" || detail === "the lead restarted the work") {
        return "Work started.";
      }
      if (detail === "the reviewer asked for changes") {
        return "The review asked for changes. The engineer is on them.";
      }
      if (detail.includes("working on the issue again")) {
        return "The revert merged. Work on the issue starts again.";
      }
      return undefined;
    case "stage:Reviewing":
      return `PR opened, now in review: ${pr(card.prNumber)}`;
    case "stage:Merging":
      if (detail.includes("needs no review")) {
        return `PR opened; it merges once its checks pass: ${pr(card.prNumber)}`;
      }
      return detail.startsWith("approved") ? "The review approved it." : undefined;
    case "stage:Validating":
      return "Merged. Checks are running on the default branch.";
    case "stage:Done":
      return detail === "merged outside Hephaestus"
        ? "It was merged outside Hephaestus."
        : "Done: checks passed on the default branch.";
    case "stage:Reverting":
      return `Checks failed on the default branch after the merge, so it is being reverted with ${pr(card.revertPr)}.`;
    case "stage:Escalated":
      return detail.startsWith("to the owner")
        ? `This needs you: ${card.reason ?? detail}\n${dashboard}work/${String(card.id)}`
        : undefined;
    case "stage:Abandoned":
      return `Stopped: ${card.reason ?? detail}.`;
    default:
      return undefined;
  }
}
