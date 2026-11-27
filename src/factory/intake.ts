import type { Database } from "better-sqlite3";
import { projectFor, projectKey, type FactoryConfig } from "../config/document.js";
import { resolvePolicy } from "../config/policy.js";
import type { Card, CardStore } from "./cards.js";
import { readAttachments, withAttachments, type StoredAttachment } from "./attachments.js";
import { INTAKE_READ_TIMEOUT_MS, OPEN_ISSUES_LIMIT, type GitHub } from "./github.js";

/** Issues missing from the open lists that one poll reads on their own, split among the projects; each gets at least one. */
const LOOKUPS_PER_POLL = 10;

interface Candidate {
  number: number;
  state: IssueState;
  closed: number;
  cardId: number | null;
  startedAt: string | null;
  stage: string | null;
}

/** An admitted issue's card that no thread has started, which closing the issue abandons. */
function unstarted(row: Pick<Candidate, "cardId" | "startedAt" | "stage">): boolean {
  return (
    row.cardId !== null &&
    row.startedAt === null &&
    ["Admitted", "Implementing", "Escalated"].includes(row.stage ?? "")
  );
}

export type IssueState = "admitted" | "awaiting-owner" | "held-cap" | "rejected";

export interface TrackedIssue {
  repo: string;
  number: number;
  title: string;
  author: string;
  provenance: "factory" | "external";
  filedBy: string | null;
  state: IssueState;
  cardId: number | null;
  /** Closed on GitHub while it waited for the owner; it returns to the queue if reopened. */
  closed: boolean;
  createdAt: string;
}

/** What admission does on the Hermes board; absent when the factory Hermes root is not set up. */
export interface Board {
  createCard(card: { title: string; body: string; idempotencyKey: string }): Promise<string>;
}

export interface IntakeOptions {
  db: Database;
  cards: CardStore;
  github: Pick<GitHub, "createIssue" | "openIssues" | "issue" | "storeAttachments">;
  /** The config in force: the deployed version. */
  config: () => FactoryConfig | undefined;
  board?: () => Board | undefined;
  /** Abandons a card through the pipeline, so it cannot race a launch for the same card. */
  abandon?: (cardId: number, reason: string) => Promise<unknown>;
  now?: () => Date;
}

export class NotAFactoryProjectError extends Error {
  constructor(repo: string) {
    super(`${repo} is not a factory project.`);
  }
}

interface Row {
  repo: string;
  number: number;
  title: string;
  author: string;
  provenance: "factory" | "external";
  filed_by: string | null;
  state: IssueState;
  card_id: number | null;
  closed: number;
  created_at: string;
}

function toIssue(row: Row): TrackedIssue {
  return {
    repo: row.repo,
    number: row.number,
    title: row.title,
    author: row.author,
    provenance: row.provenance,
    filedBy: row.filed_by,
    state: row.state,
    cardId: row.card_id,
    closed: row.closed === 1,
    createdAt: row.created_at,
  };
}

/**
 * Decides which GitHub issues the factory may work on. An issue Hephaestus
 * filed through `file_issue` is admitted unless the project's cap on open
 * factory-filed issues awaiting work is reached; any other issue waits for
 * the owner. Every admitted issue gets a card.
 */
export class Intake {
  private readonly now: () => Date;
  /** Serializes filing and polling, so a poll never records a just-filed issue as external. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: IntakeOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private get db(): Database {
    return this.options.db;
  }

  issue(repo: string, number: number): TrackedIssue | undefined {
    const row = this.db
      .prepare("SELECT * FROM issues WHERE repo = ? COLLATE NOCASE AND number = ?")
      .get(repo, number) as Row | undefined;
    return row === undefined ? undefined : toIssue(row);
  }

  issues(states?: readonly IssueState[]): TrackedIssue[] {
    const rows =
      states === undefined
        ? (this.db.prepare("SELECT * FROM issues ORDER BY created_at DESC").all() as Row[])
        : (this.db
            .prepare(
              `SELECT * FROM issues WHERE state IN (${states.map(() => "?").join(", ")}) AND closed = 0
               ORDER BY created_at DESC`,
            )
            .all(...states) as Row[]);
    return rows.map(toIssue);
  }

  private policy(repo: string): ReturnType<typeof resolvePolicy> {
    const project = projectFor(this.options.config()?.projects, repo);
    if (project === undefined) throw new NotAFactoryProjectError(repo);
    return resolvePolicy(project.policy);
  }

  /**
   * Files an issue for a factory role and admits it when the project's cap allows.
   * Attachments are paths of files in the role's chat cache: every one is checked before anything is
   * written, then committed to the repo's attachments branch, and the issue
   * body links them. A failure leaves no issue.
   */
  fileIssue(
    role: string,
    repo: string,
    title: string,
    body: string,
    attachments: readonly string[] = [],
    /** The only folders attachments may come from: the calling role's chat media caches. */
    attachmentRoots: readonly string[] = [],
  ): Promise<TrackedIssue> {
    return this.serial(async () => {
      // The config's spelling, so the same repo under another casing shares its cap and record.
      repo = projectKey(this.options.config()?.projects, repo) ?? repo;
      this.policy(repo);
      if (attachments.length > 0) {
        const files = await readAttachments(attachments, attachmentRoots);
        const commits = await this.options.github.storeAttachments(repo, files);
        const stored: StoredAttachment[] = files.map((attachment, index) => ({
          attachment,
          commit: commits[index] ?? "",
        }));
        body = withAttachments(repo, body, stored);
      }
      const number = await this.options.github.createIssue(repo, title, body);
      this.record({
        repo,
        number,
        title,
        author: "hephaestus",
        provenance: "factory",
        filedBy: role,
      });
      await this.admitIfRoom(repo, number);
      const issue = this.issue(repo, number);
      if (issue === undefined) throw new Error(`Issue ${repo}#${String(number)} was not recorded.`);
      return issue;
    });
  }

  /** Records open issues nobody has seen. Issues the cap held stay for the owner. */
  poll(): Promise<void> {
    return this.serial(async () => {
      const repos = Object.keys(this.options.config()?.projects ?? {});
      // Projects run side by side, so a slow list or read in one delays nothing in another,
      // and each has its own share of the reads, so none goes without.
      const share = Math.max(1, Math.floor(LOOKUPS_PER_POLL / Math.max(1, repos.length)));
      await Promise.all(
        repos.map(async (repo) => {
          try {
            await this.pollRepo(repo, share);
          } catch (error) {
            console.error(`Polling the issues of ${repo} failed`, error);
          }
        }),
      );
    });
  }

  private async pollRepo(repo: string, reads: number): Promise<void> {
    const open = await this.options.github.openIssues(repo);
    for (const issue of open) {
      if (this.issue(repo, issue.number) !== undefined) continue;
      this.record({
        repo,
        number: issue.number,
        title: issue.title,
        author: issue.author,
        provenance: "external",
        filedBy: null,
      });
    }
    await this.reconcile(repo, new Set(open.map((issue) => issue.number)), reads);
  }

  /**
   * Follows issues the open list leaves out. An admitted issue closed before
   * any thread started has its card abandoned, so it holds no place under the
   * cap. An issue waiting for the owner leaves the queue while it is closed,
   * and comes back if reopened. A full list may leave out open issues, so
   * missing issues are read on their own: a few per poll, in the order they
   * joined the line, to stay well inside GitHub's rate limit.
   */
  private async reconcile(repo: string, open: Set<number>, reads: number): Promise<void> {
    const mark = this.db.prepare(
      "UPDATE issues SET closed = ? WHERE repo = ? COLLATE NOCASE AND number = ?",
    );
    const complete = open.size < OPEN_ISSUES_LIMIT;
    const rows = this.db
      .prepare(
        `SELECT i.number, i.state, i.closed, i.card_id AS cardId, c.started_at AS startedAt, c.stage
         FROM issues i LEFT JOIN cards c ON c.id = i.card_id WHERE i.repo = ? COLLATE NOCASE
         AND i.state IN ('admitted', 'awaiting-owner', 'held-cap') ORDER BY i.read_order`,
      )
      .all(repo) as Candidate[];
    const candidates: Candidate[] = [];
    for (const row of rows) {
      if (row.state === "admitted") {
        if (unstarted(row) && !open.has(row.number)) candidates.push(row);
      } else if (open.has(row.number)) {
        if (row.closed === 1) mark.run(0, repo, row.number);
      } else if (row.closed === 0 || !complete) {
        // From a complete list, an issue already marked closed is settled.
        candidates.push(row);
      }
    }
    for (const candidate of candidates.slice(0, reads)) {
      try {
        const state = await this.lookup(repo, candidate.number);
        if (candidate.state !== "admitted") {
          if (state === "OPEN" && candidate.closed === 1) mark.run(0, repo, candidate.number);
          if (state === "CLOSED" && candidate.closed === 0) mark.run(1, repo, candidate.number);
        } else if (state === "CLOSED" && candidate.cardId !== null) {
          await this.abandonUnstarted(candidate.cardId);
        }
      } catch (error) {
        console.error(`Settling ${repo}#${String(candidate.number)} failed`, error);
      }
    }
  }

  private async abandonUnstarted(cardId: number): Promise<void> {
    // The card may have moved while its issue was read.
    const card = this.options.cards.get(cardId);
    if (!unstarted({ cardId, startedAt: card.startedAt, stage: card.stage })) return;
    const pending = this.db
      .prepare("SELECT 1 FROM factory_launches WHERE card_id = ? AND status = 'pending'")
      .get(String(cardId));
    if (pending !== undefined) return;
    if (this.options.abandon !== undefined) {
      await this.options.abandon(cardId, "the issue was closed before work started");
    } else {
      this.options.cards.transition(
        cardId,
        "Abandoned",
        "the issue was closed before work started",
        {
          reason: "the issue was closed",
        },
      );
    }
  }

  /** The issue's state on GitHub, or undefined when it could not be read; either way it goes to the back of the line. */
  private async lookup(repo: string, number: number): Promise<string | undefined> {
    this.db
      .prepare(
        `UPDATE issues SET read_order = (SELECT COALESCE(MAX(read_order), 0) + 1 FROM issues)
         WHERE repo = ? COLLATE NOCASE AND number = ?`,
      )
      .run(repo, number);
    try {
      return (await this.options.github.issue(repo, number, INTAKE_READ_TIMEOUT_MS)).state;
    } catch {
      return undefined;
    }
  }

  /** The owner's approval on the Work items page: the issue is admitted whatever the cap. */
  approve(repo: string, number: number): Promise<Card> {
    return this.serial(async () => {
      const issue = this.issue(repo, number);
      if (issue === undefined)
        throw new Error(`Hephaestus has not seen ${repo}#${String(number)}.`);
      if (issue.state === "admitted" && issue.cardId !== null) {
        // A reopened issue whose card was abandoned gets a new card.
        const card = this.options.cards.get(issue.cardId);
        if (card.stage !== "Abandoned") return card;
      } else if (issue.state !== "awaiting-owner" && issue.state !== "held-cap") {
        // A stale form must not undo a rejection.
        throw new Error(`${repo}#${String(number)} is ${issue.state}, not waiting for you.`);
      }
      const current = await this.options.github.issue(repo, number);
      if (current.state !== "OPEN") throw new Error(`${repo}#${String(number)} is closed.`);
      return this.admit(issue);
    });
  }

  /** The owner's rejection; it runs in turn with admissions, and only an issue waiting for the owner changes. */
  reject(repo: string, number: number): Promise<void> {
    return this.serial(() => {
      const result = this.db
        .prepare(
          `UPDATE issues SET state = 'rejected', updated_at = ? WHERE repo = ? COLLATE NOCASE AND number = ?
           AND state IN ('awaiting-owner', 'held-cap')`,
        )
        .run(this.now().toISOString(), repo, number);
      if (result.changes === 0) {
        throw new Error(`${repo}#${String(number)} is not waiting for you.`);
      }
      return Promise.resolve();
    });
  }

  /** Factory-filed issues admitted and awaiting work, whose card has no thread yet; the cap counts these. */
  awaitingWork(repo: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM issues i JOIN cards c ON c.id = i.card_id
           WHERE i.repo = ? COLLATE NOCASE AND i.provenance = 'factory' AND c.started_at IS NULL
           AND c.stage IN ('Admitted', 'Implementing', 'Escalated')`,
        )
        .get(repo) as { n: number }
    ).n;
  }

  private async admitIfRoom(repo: string, number: number): Promise<void> {
    const issue = this.issue(repo, number);
    if (issue === undefined || issue.provenance !== "factory") return;
    if (issue.state !== "held-cap" && issue.state !== "awaiting-owner") return;
    let cap: number;
    try {
      cap = this.policy(repo).openIssueCap;
    } catch (error) {
      // The project was removed while GitHub filed the issue; it waits for the owner instead.
      if (error instanceof NotAFactoryProjectError) return;
      throw error;
    }
    if (this.awaitingWork(repo) >= cap) {
      this.setState(repo, number, "held-cap");
      return;
    }
    await this.admit(issue);
  }

  private async admit(issue: TrackedIssue): Promise<Card> {
    const card = this.options.cards.create({
      repo: issue.repo,
      issueNumber: issue.number,
      title: issue.title,
    });
    this.db
      .prepare(
        "UPDATE issues SET state = 'admitted', card_id = ?, updated_at = ? WHERE repo = ? COLLATE NOCASE AND number = ?",
      )
      .run(card.id, this.now().toISOString(), issue.repo, issue.number);
    const board = this.options.board?.();
    if (board !== undefined) {
      try {
        const hermesCardId = await board.createCard({
          title: `[card ${String(card.id)}] ${issue.title}`,
          body: `Hephaestus card ${String(card.id)} for https://github.com/${issue.repo}/issues/${String(issue.number)}. Start it with start_work and card_id ${String(card.id)}.`,
          idempotencyKey: `hephaestus-card-${String(card.id)}`,
        });
        this.options.cards.update(card.id, { hermesCardId });
      } catch (error) {
        console.error(`Creating the Hermes card for card ${String(card.id)} failed`, error);
        this.options.cards.event(card.id, "hermes", "the Hermes card could not be created");
      }
    }
    return this.options.cards.get(card.id);
  }

  private record(issue: Omit<TrackedIssue, "state" | "cardId" | "closed" | "createdAt">): void {
    const at = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO issues (repo, number, title, author, provenance, filed_by, state, created_at, updated_at, read_order)
         VALUES (?, ?, ?, ?, ?, ?, 'awaiting-owner', ?, ?, (SELECT COALESCE(MAX(read_order), 0) + 1 FROM issues))
         ON CONFLICT (repo, number) DO NOTHING`,
      )
      .run(
        issue.repo,
        issue.number,
        issue.title,
        issue.author,
        issue.provenance,
        issue.filedBy,
        at,
        at,
      );
  }

  private setState(repo: string, number: number, state: IssueState): void {
    this.db
      .prepare(
        "UPDATE issues SET state = ?, updated_at = ? WHERE repo = ? COLLATE NOCASE AND number = ?",
      )
      .run(state, this.now().toISOString(), repo, number);
  }
}
