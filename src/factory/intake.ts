import type { Database } from "better-sqlite3";
import type { FactoryConfig } from "../config/document.js";
import { resolvePolicy } from "../config/policy.js";
import type { Card, CardStore } from "./cards.js";
import type { GitHub } from "./github.js";

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
  createdAt: string;
}

/** What admission does on the Hermes board; absent when the factory Hermes root is not set up. */
export interface Board {
  createCard(card: { title: string; body: string; idempotencyKey: string }): Promise<string>;
}

export interface IntakeOptions {
  db: Database;
  cards: CardStore;
  github: Pick<GitHub, "createIssue" | "openIssues" | "issue">;
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
      .prepare("SELECT * FROM issues WHERE repo = ? AND number = ?")
      .get(repo, number) as Row | undefined;
    return row === undefined ? undefined : toIssue(row);
  }

  issues(states?: readonly IssueState[]): TrackedIssue[] {
    const rows =
      states === undefined
        ? (this.db.prepare("SELECT * FROM issues ORDER BY created_at DESC").all() as Row[])
        : (this.db
            .prepare(
              `SELECT * FROM issues WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY created_at DESC`,
            )
            .all(...states) as Row[]);
    return rows.map(toIssue);
  }

  private policy(repo: string): ReturnType<typeof resolvePolicy> {
    const project = this.options.config()?.projects[repo];
    if (project === undefined) throw new NotAFactoryProjectError(repo);
    return resolvePolicy(project.policy);
  }

  /** Files an issue for a factory role and admits it when the project's cap allows. */
  fileIssue(role: string, repo: string, title: string, body: string): Promise<TrackedIssue> {
    return this.serial(async () => {
      this.policy(repo);
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
      for (const repo of Object.keys(this.options.config()?.projects ?? {})) {
        let open;
        try {
          open = await this.options.github.openIssues(repo);
        } catch (error) {
          console.error(`Reading the open issues of ${repo} failed`, error);
          continue;
        }
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
        await this.closeUnstarted(repo, new Set(open.map((issue) => issue.number)));
      }
    });
  }

  /**
   * Abandons the cards of admitted issues that were closed before any thread
   * started on them, so a closed issue holds no place under the cap.
   */
  private async closeUnstarted(repo: string, open: Set<number>): Promise<void> {
    const rows = this.db
      .prepare(
        `SELECT i.number, c.id AS cardId FROM issues i JOIN cards c ON c.id = i.card_id
         WHERE i.repo = ? AND i.state = 'admitted' AND c.started_at IS NULL
         AND c.stage IN ('Admitted', 'Implementing', 'Escalated')`,
      )
      .all(repo) as { number: number; cardId: number }[];
    for (const row of rows) {
      // The open list is capped, so an issue missing from it is read on its own before anything changes.
      if (open.has(row.number) || !(await this.isClosed(repo, row.number))) continue;
      const pending = this.db
        .prepare("SELECT 1 FROM factory_launches WHERE card_id = ? AND status = 'pending'")
        .get(String(row.cardId));
      if (pending !== undefined) continue;
      if (this.options.abandon !== undefined) {
        await this.options.abandon(row.cardId, "the issue was closed before work started");
      } else {
        this.options.cards.transition(
          row.cardId,
          "Abandoned",
          "the issue was closed before work started",
          {
            reason: "the issue was closed",
          },
        );
      }
    }
    const held = this.issues(["held-cap", "awaiting-owner"]).filter(
      (issue) => issue.repo === repo && !open.has(issue.number),
    );
    for (const issue of held) {
      if (await this.isClosed(repo, issue.number)) this.setState(repo, issue.number, "rejected");
    }
  }

  private async isClosed(repo: string, number: number): Promise<boolean> {
    try {
      return (await this.options.github.issue(repo, number)).state === "CLOSED";
    } catch {
      return false;
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
      }
      const current = await this.options.github.issue(repo, number);
      if (current.state !== "OPEN") throw new Error(`${repo}#${String(number)} is closed.`);
      return this.admit(issue);
    });
  }

  reject(repo: string, number: number): void {
    this.db
      .prepare(
        "UPDATE issues SET state = 'rejected', updated_at = ? WHERE repo = ? AND number = ? AND state != 'admitted'",
      )
      .run(this.now().toISOString(), repo, number);
  }

  /** Factory-filed issues admitted and awaiting work, whose card has no thread yet; the cap counts these. */
  awaitingWork(repo: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM issues i JOIN cards c ON c.id = i.card_id
           WHERE i.repo = ? AND i.provenance = 'factory' AND c.started_at IS NULL
           AND c.stage IN ('Admitted', 'Implementing', 'Escalated')`,
        )
        .get(repo) as { n: number }
    ).n;
  }

  private async admitIfRoom(repo: string, number: number): Promise<void> {
    const issue = this.issue(repo, number);
    if (issue === undefined || issue.provenance !== "factory") return;
    if (issue.state !== "held-cap" && issue.state !== "awaiting-owner") return;
    if (this.awaitingWork(repo) >= this.policy(repo).openIssueCap) {
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
        "UPDATE issues SET state = 'admitted', card_id = ?, updated_at = ? WHERE repo = ? AND number = ?",
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

  private record(issue: Omit<TrackedIssue, "state" | "cardId" | "createdAt">): void {
    const at = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO issues (repo, number, title, author, provenance, filed_by, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'awaiting-owner', ?, ?)
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
      .prepare("UPDATE issues SET state = ?, updated_at = ? WHERE repo = ? AND number = ?")
      .run(state, this.now().toISOString(), repo, number);
  }
}
