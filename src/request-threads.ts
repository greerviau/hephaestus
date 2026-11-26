import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { DiscordApi, type Fetch } from "./discord.js";
import {
  MERGE_CONFLICT_DETAIL,
  type Card,
  type CardEvent,
  type CardStore,
  evidenceRefFor,
} from "./factory/cards.js";
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
/** Stages whose PR is open or merged, where a late thread is shown the evidence. */
const EVIDENCE_STAGES = new Set<Card["stage"]>(["Reviewing", "Merging", "Validating", "Done"]);

/** The PR and head an event names, as the pipeline writes them: `PR #N at <sha>`. */
function namedPr(detail: string): { number: number; head: string } | undefined {
  const match = /^PR #(\d+) at ([0-9a-f]+)/.exec(detail);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { number: Number(match[1]), head: match[2] };
}

/** Whether a PR an event names was put up before: never, at another head, or at this head. */
type PrHistory = "new" | "updated" | "same";

export interface RequestThreadsOptions {
  db: Database;
  /** This install's id, which scopes each card's evidence ref. */
  install: string;
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

  /**
   * Starts following an issue in a thread, and catches the thread up on its card at once.
   * No progress pass may run meanwhile, or a step could be posted before the catch-up and
   * again in it; the service runs link and progress one after the other.
   */
  async follow(repo: string, number: number, thread: Thread): Promise<void> {
    // Only an issue Hephaestus tracks can be followed, so a stray line cannot claim another repo's.
    const tracked = this.db
      .prepare("SELECT repo FROM issues WHERE repo = ? COLLATE NOCASE AND number = ?")
      .get(repo, number) as { repo: string } | undefined;
    if (tracked === undefined) return;
    repo = tracked.repo;
    // Events up to now are covered by the catch-up, once it is sent; until then every one is posted.
    const newest =
      (this.db.prepare("SELECT MAX(id) AS id FROM card_events").get() as { id: number | null })
        .id ?? 0;
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
    const sent = await this.post(
      thread,
      `Following ${repo}#${String(number)}${card === undefined ? "." : `: ${stageText(card, this.options.dashboardUrl())}`} Progress shows up here.`,
    );
    if (!sent) return;
    this.db
      .prepare("UPDATE chat_threads SET after_event = ? WHERE repo = ? AND number = ?")
      .run(newest, repo, number);
    // A card past opening its PR, and not sent back or stopped, may have evidence the thread has not seen.
    if (card !== undefined && card.prNumber !== null && EVIDENCE_STAGES.has(card.stage)) {
      await this.postEvidence(thread, card);
    }
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
      const followed =
        card.issueNumber === null ? undefined : this.threadFor(card.repo, card.issueNumber);
      const thread = followed !== undefined && event.id > followed.after ? followed : undefined;
      const text =
        thread === undefined
          ? undefined
          : milestone(event, card, this.options.dashboardUrl(), this.prHistory(event));
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

  /** Whether an earlier event of the card put up the PR this event names, and at which head. */
  private prHistory(event: CardEvent): PrHistory {
    const named = namedPr(event.detail);
    if (named === undefined) return "new";
    const earlier = this.db
      .prepare(
        `SELECT detail FROM card_events WHERE card_id = ? AND id < ?
         AND kind IN ('stage:Reviewing', 'stage:Merging')`,
      )
      .all(event.cardId, event.id) as { detail: string }[];
    const heads = earlier
      .map((row) => namedPr(row.detail))
      .filter((pr) => pr?.number === named.number)
      .map((pr) => pr?.head);
    if (heads.length === 0) return "new";
    return heads.includes(named.head) ? "same" : "updated";
  }

  /** The thread following an issue, and the last event its catch-up covered. */
  private threadFor(repo: string, number: number): (Thread & { after: number }) | undefined {
    const row = this.db
      .prepare(
        "SELECT platform, chat, after_event AS after FROM chat_threads WHERE repo = ? AND number = ?",
      )
      .get(repo, number) as { platform: string; chat: string; after: number } | undefined;
    return row?.platform === "discord"
      ? { platform: "discord", chat: row.chat, after: row.after }
      : undefined;
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
      evidence = await this.options.github.evidence(
        card.repo,
        evidenceRefFor(card, this.options.install),
      );
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

/** A reason as a clause: trimmed, kept short, and without its final stop, which the caller adds. */
function sentence(reason: string): string {
  const text = reason.trim().replace(/[.!?]+$/, "");
  return text.length > 300 ? `${text.slice(0, 300)} (cut short; the card has it all)` : text;
}

/** What the card is doing now, in a few words, for a thread that starts following it late. */
function stageText(card: Card, dashboard: string): string {
  const why = card.reason === null ? "" : `: ${sentence(card.reason)}`;
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
      return `its merge failed checks on the default branch, so it is being reverted${card.revertPr === null ? "" : ` with PR #${String(card.revertPr)}`}.`;
    case "Escalated":
      return card.escalatedTo === "owner"
        ? `it needs you${why}. ${dashboard}work/${String(card.id)}`
        : `it is waiting for a decision${why}.`;
    case "Done":
      return "it is done.";
    case "Abandoned":
      return `it was stopped${why}.`;
  }
}

/** The thread message for a card event, or undefined when the event is not a milestone. */
export function milestone(
  event: CardEvent,
  card: Card,
  dashboard: string,
  /** Whether the PR was put up before, and whether at another head. */
  history: PrHistory = "new",
): string | undefined {
  const pr = (number: number | null): string =>
    number === null ? "the PR" : `https://github.com/${card.repo}/pull/${String(number)}`;
  const detail = event.detail;
  // The PR the event names, which may be older than the card's current one in a backlog.
  const named = namedPr(detail)?.number ?? card.prNumber;
  switch (event.kind) {
    case "stage:Implementing":
      if (detail === "work started" || detail === "the lead restarted the work") {
        return "Work started.";
      }
      if (detail === "the reviewer asked for changes") {
        return "The review asked for changes. The engineer is on them.";
      }
      if (detail === MERGE_CONFLICT_DETAIL) {
        return "The PR conflicts with changes merged since it opened. The engineer is updating it.";
      }
      if (detail.includes("working on the issue again")) {
        return "The revert merged. Work on the issue starts again.";
      }
      return undefined;
    case "stage:Reviewing":
      return {
        new: `PR opened, now in review: ${pr(named)}`,
        updated: `The PR is updated and back in review: ${pr(named)}`,
        same: `The PR is back in review: ${pr(named)}`,
      }[history];
    case "stage:Merging":
      if (detail.includes("needs no review")) {
        return {
          new: `PR opened; it merges once its checks pass: ${pr(named)}`,
          updated: `The PR is updated; it merges once its checks pass: ${pr(named)}`,
          same: `The PR merges once its checks pass: ${pr(named)}`,
        }[history];
      }
      return detail.startsWith("approved") ? "The review approved it." : undefined;
    case "stage:Validating":
      return "Merged. Checks are running on the default branch.";
    case "stage:Done":
      return detail === "merged outside Hephaestus"
        ? "It was merged outside Hephaestus."
        : "Done: checks passed on the default branch.";
    case "stage:Reverting": {
      // Only the step that opens the revert; the owner's approval and its merge say nothing new.
      const revert = /opened revert PR #(\d+)$/.exec(detail)?.[1];
      return revert === undefined
        ? undefined
        : `Checks failed on the default branch after the merge, so it is being reverted with ${pr(Number(revert))}.`;
    }
    case "stage:Escalated":
      return detail.startsWith("to the owner")
        ? `This needs you: ${sentence(detail.replace(/^to the owner:\s*/, ""))}.\n${dashboard}work/${String(card.id)}`
        : undefined;
    // The lead handing a card it was given on to the owner.
    case "escalated:owner":
      return `This needs you: ${sentence(detail)}.\n${dashboard}work/${String(card.id)}`;
    case "stage:Abandoned":
      return `Stopped: ${card.reason ?? detail}.`;
    default:
      return undefined;
  }
}
