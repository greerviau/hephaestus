import { installPrefix } from "../config.js";
import type { PolicySettings } from "../config/policy.js";
import type { Database } from "better-sqlite3";
import type { Stage } from "../hermes/board.js";

/** The card event detail when a PR is sent back because it no longer merges cleanly. */
export const MERGE_CONFLICT_DETAIL = "the PR conflicts with its base branch";
/** The card event detail when a PR is sent back because its reviewer asked for changes. */
export const CHANGES_REQUESTED_DETAIL = "the reviewer asked for changes";

export type Provider = "claude" | "codex";
export type EscalationTarget = "lead" | "owner";

export interface Card {
  id: number;
  repo: string;
  issueNumber: number | null;
  title: string;
  stage: Stage;
  hermesCardId: string | null;
  brief: string | null;
  workerEnv: string | null;
  projectId: string | null;
  baseBranch: string | null;
  implementer: Provider | null;
  implementThread: string | null;
  reviewThread: string | null;
  /** The last message the pipeline acted on in each thread, so each result is handled once. */
  handled: Record<string, string>;
  prNumber: number | null;
  headSha: string | null;
  rounds: number;
  escalatedTo: EscalationTarget | null;
  /** Why the card is escalated, or why it was abandoned. */
  reason: string | null;
  /** Why the next thread has not started yet: a cap, a pause, or no ready worker. */
  waiting: string | null;
  mergeSha: string | null;
  revertPr: number | null;
  /** The head commit the owner approved for merging on the dashboard. */
  ownerApprovedSha: string | null;
  /** A message for the implement thread that waits for a cap to free up. */
  pendingMessage: string | null;
  /** What an owner's approval on the dashboard resumes: a merge of the PR, or of the revert PR. */
  ownerAction: "merge" | "revert-merge" | null;
  /** The branch the implement thread works on; only a PR from it counts. */
  branch: string | null;
  /** When the pipeline first saw the current head commit. */
  headAt: string | null;
  /** The checks that ran on the merged head, which the merge commit must run too. */
  expectedChecks: string[] | null;
  /** When the first implement thread started, for cycle time. */
  startedAt: string | null;
  foreignMerge: boolean;
  /** Set from the failed validation that opened a revert PR until that revert merges. */
  reverting: boolean;
  /** The policy the card last ran under, kept so a merge in flight can finish if its project is removed. */
  policy: PolicySettings | null;
  /**
   * When the card's thread stopped on a provider's usage limit: when the pipeline looks at it
   * again, and the T3 run that stopped, so a run T3 resumed on its own is told from it.
   */
  limitUntil: string | null;
  limitRun: string | null;
  /** Counts every change, so a form from an earlier state of the card is refused. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CardEvent {
  id: number;
  cardId: number;
  at: string;
  kind: string;
  detail: string;
}

/**
 * Every stage change the pipeline may make. Tests walk this table, and
 * {@link CardStore.transition} refuses any change it does not list.
 */
export const TRANSITIONS: Record<Stage, readonly Stage[]> = {
  Admitted: ["Implementing", "Escalated", "Abandoned"],
  // Done straight from Implementing, Reviewing, or Merging is a PR merged outside Hephaestus.
  Implementing: ["Implementing", "Reviewing", "Merging", "Escalated", "Abandoned", "Done"],
  Reviewing: ["Reviewing", "Implementing", "Merging", "Escalated", "Abandoned", "Done"],
  // Back to Implementing only when the PR conflicts with its base, so nothing was merged.
  Merging: ["Validating", "Implementing", "Escalated", "Abandoned", "Done"],
  Validating: ["Done", "Reverting", "Escalated"],
  Reverting: ["Implementing", "Escalated"],
  Escalated: ["Implementing", "Merging", "Reverting", "Abandoned", "Done"],
  Done: [],
  Abandoned: [],
};

export class TransitionError extends Error {
  constructor(card: Card, to: Stage) {
    super(`Card ${String(card.id)} cannot move from ${card.stage} to ${to}.`);
  }
}

interface Row {
  id: number;
  repo: string;
  issue_number: number | null;
  title: string;
  stage: Stage;
  hermes_card_id: string | null;
  brief: string | null;
  worker_env: string | null;
  project_id: string | null;
  base_branch: string | null;
  implementer: Provider | null;
  implement_thread: string | null;
  review_thread: string | null;
  handled_item: string | null;
  owner_action: "merge" | "revert-merge" | null;
  branch: string | null;
  head_at: string | null;
  expected_checks: string | null;
  pr_number: number | null;
  head_sha: string | null;
  rounds: number;
  escalated_to: EscalationTarget | null;
  reason: string | null;
  waiting: string | null;
  merge_sha: string | null;
  revert_pr: number | null;
  owner_approved_sha: string | null;
  pending_message: string | null;
  started_at: string | null;
  foreign_merge: number;
  reverting: number;
  policy: string | null;
  limit_until: string | null;
  limit_run: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS: Record<keyof Omit<Card, "id" | "createdAt" | "updatedAt" | "version">, string> = {
  repo: "repo",
  issueNumber: "issue_number",
  title: "title",
  stage: "stage",
  hermesCardId: "hermes_card_id",
  brief: "brief",
  workerEnv: "worker_env",
  projectId: "project_id",
  baseBranch: "base_branch",
  implementer: "implementer",
  implementThread: "implement_thread",
  reviewThread: "review_thread",
  handled: "handled_item",
  ownerAction: "owner_action",
  branch: "branch",
  headAt: "head_at",
  expectedChecks: "expected_checks",
  prNumber: "pr_number",
  headSha: "head_sha",
  rounds: "rounds",
  escalatedTo: "escalated_to",
  reason: "reason",
  waiting: "waiting",
  mergeSha: "merge_sha",
  revertPr: "revert_pr",
  ownerApprovedSha: "owner_approved_sha",
  pendingMessage: "pending_message",
  startedAt: "started_at",
  foreignMerge: "foreign_merge",
  reverting: "reverting",
  policy: "policy",
  limitUntil: "limit_until",
  limitRun: "limit_run",
};

function toCard(row: Row): Card {
  return {
    id: row.id,
    repo: row.repo,
    issueNumber: row.issue_number,
    title: row.title,
    stage: row.stage,
    hermesCardId: row.hermes_card_id,
    brief: row.brief,
    workerEnv: row.worker_env,
    projectId: row.project_id,
    baseBranch: row.base_branch,
    implementer: row.implementer,
    implementThread: row.implement_thread,
    reviewThread: row.review_thread,
    handled:
      row.handled_item === null ? {} : (JSON.parse(row.handled_item) as Record<string, string>),
    ownerAction: row.owner_action,
    branch: row.branch,
    headAt: row.head_at,
    expectedChecks:
      row.expected_checks === null ? null : (JSON.parse(row.expected_checks) as string[]),
    prNumber: row.pr_number,
    headSha: row.head_sha,
    rounds: row.rounds,
    escalatedTo: row.escalated_to,
    reason: row.reason,
    waiting: row.waiting,
    mergeSha: row.merge_sha,
    revertPr: row.revert_pr,
    ownerApprovedSha: row.owner_approved_sha,
    pendingMessage: row.pending_message,
    startedAt: row.started_at,
    foreignMerge: row.foreign_merge === 1,
    reverting: row.reverting === 1,
    policy: row.policy === null ? null : (JSON.parse(row.policy) as PolicySettings),
    limitUntil: row.limit_until,
    limitRun: row.limit_run,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Hephaestus's record of every card: its stage, threads, PR, and a log of what happened. */
export class CardStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(card: { repo: string; issueNumber: number | null; title: string }): Card {
    const at = this.now().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO cards (repo, issue_number, title, stage, created_at, updated_at)
         VALUES (?, ?, ?, 'Admitted', ?, ?)`,
      )
      .run(card.repo, card.issueNumber, card.title, at, at);
    const id = Number(result.lastInsertRowid);
    this.event(
      id,
      "admitted",
      card.issueNumber === null ? card.title : `issue #${String(card.issueNumber)}`,
    );
    return this.get(id);
  }

  get(id: number): Card {
    const row = this.db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new Error(`There is no card ${String(id)}.`);
    return toCard(row);
  }

  find(id: number): Card | undefined {
    const row = this.db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : toCard(row);
  }

  byHermesId(hermesCardId: string): Card | undefined {
    const row = this.db
      .prepare("SELECT * FROM cards WHERE hermes_card_id = ?")
      .get(hermesCardId) as Row | undefined;
    return row === undefined ? undefined : toCard(row);
  }

  /** The implement and review threads of every card that is not done or abandoned. */
  activeThreadIds(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT implement_thread AS i, review_thread AS r FROM cards
         WHERE stage NOT IN ('Done', 'Abandoned') AND (implement_thread IS NOT NULL OR review_thread IS NOT NULL)`,
      )
      .all() as { i: string | null; r: string | null }[];
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.i !== null) ids.add(row.i);
      if (row.r !== null) ids.add(row.r);
    }
    return ids;
  }

  /** Cards, newest first, optionally only those in the given stages. */
  list(stages?: readonly Stage[]): Card[] {
    const rows =
      stages === undefined
        ? (this.db.prepare("SELECT * FROM cards ORDER BY id DESC").all() as Row[])
        : (this.db
            .prepare(
              `SELECT * FROM cards WHERE stage IN (${stages.map(() => "?").join(", ")}) ORDER BY id DESC`,
            )
            .all(...stages) as Row[]);
    return rows.map(toCard);
  }

  update(
    id: number,
    fields: Partial<Omit<Card, "id" | "createdAt" | "updatedAt" | "stage" | "version">>,
  ): Card {
    const entries = Object.entries(fields) as [keyof typeof COLUMNS, unknown][];
    if (entries.length > 0) {
      const sets = entries.map(([key]) => `${COLUMNS[key]} = ?`).join(", ");
      const values = entries.map(([key, value]) =>
        key === "foreignMerge" || key === "reverting"
          ? value === true
            ? 1
            : 0
          : key === "handled" ||
              ((key === "expectedChecks" || key === "policy") &&
                value !== null &&
                value !== undefined)
            ? JSON.stringify(value ?? {})
            : (value ?? null),
      );
      this.db
        .prepare(`UPDATE cards SET ${sets}, updated_at = ?, version = version + 1 WHERE id = ?`)
        .run(...(values as (string | number | null)[]), this.now().toISOString(), id);
    }
    return this.get(id);
  }

  /** Moves a card to `to` if the stage diagram allows it, and logs why. */
  transition(
    id: number,
    to: Stage,
    detail: string,
    fields: Partial<Omit<Card, "id" | "createdAt" | "updatedAt" | "stage" | "version">> = {},
  ): Card {
    return this.db.transaction(() => {
      const card = this.get(id);
      if (!TRANSITIONS[card.stage].includes(to)) throw new TransitionError(card, to);
      this.db
        .prepare("UPDATE cards SET stage = ?, updated_at = ?, version = version + 1 WHERE id = ?")
        .run(to, this.now().toISOString(), id);
      this.update(id, fields);
      this.event(id, `stage:${to}`, detail);
      return this.get(id);
    })();
  }

  event(cardId: number, kind: string, detail: string): void {
    this.db
      .prepare("INSERT INTO card_events (card_id, at, kind, detail) VALUES (?, ?, ?, ?)")
      .run(cardId, this.now().toISOString(), kind, detail);
  }

  events(cardId: number): CardEvent[] {
    return this.db
      .prepare(
        "SELECT id, card_id AS cardId, at, kind, detail FROM card_events WHERE card_id = ? ORDER BY id",
      )
      .all(cardId) as CardEvent[];
  }

  /** The newest events across all cards, for the Activity page. */
  /** The newest card events, of one project's cards when `repo` is given. */
  recentEvents(limit = 200, repo?: string): (CardEvent & { title: string; repo: string })[] {
    return this.db
      .prepare(
        `SELECT e.id, e.card_id AS cardId, e.at, e.kind, e.detail, c.title, c.repo
         FROM card_events e JOIN cards c ON c.id = e.card_id
         WHERE @repo IS NULL OR c.repo = @repo ORDER BY e.id DESC LIMIT @limit`,
      )
      .all({ limit, repo: repo ?? null }) as (CardEvent & { title: string; repo: string })[];
  }

  recordReview(review: {
    cardId: number;
    headSha: string;
    reviewer: Provider;
    author: Provider;
    verdict: "approve" | "changes";
    threadId: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO review_results (card_id, head_sha, reviewer, author, verdict, thread_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        review.cardId,
        review.headSha,
        review.reviewer,
        review.author,
        review.verdict,
        review.threadId,
        this.now().toISOString(),
      );
  }

  /** Whether a reviewer other than the author approved exactly this head commit. */
  approvedAt(cardId: number, headSha: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM review_results WHERE card_id = ? AND head_sha = ? AND verdict = 'approve'
         AND reviewer != author ORDER BY at DESC LIMIT 1`,
      )
      .get(cardId, headSha);
    return row !== undefined;
  }

  recordMerge(
    repo: string,
    prNumber: number,
    mergeSha: string,
    cardId: number,
    revert: boolean,
    /** Merged by someone else; recorded so a revert still counts, never as Hephaestus's merge. */
    foreign = false,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO merges (repo, pr_number, merge_sha, card_id, revert, foreign_merge, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repo,
        prNumber,
        mergeSha,
        cardId,
        revert ? 1 : 0,
        foreign ? 1 : 0,
        this.now().toISOString(),
      );
  }

  /** Revert PRs that merged, by Hephaestus or anyone else, which is when a revert is complete. */
  revertCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM merges WHERE revert = 1").get() as { n: number }
    ).n;
  }

  /** Records a revert PR someone else merged, with its audit event, in one write. */
  recordForeignRevert(repo: string, prNumber: number, mergeSha: string, cardId: number): void {
    this.db.transaction(() => {
      this.recordMerge(repo, prNumber, mergeSha, cardId, true, true);
      this.event(
        cardId,
        "foreign-merge",
        `revert PR #${String(prNumber)} merged outside Hephaestus`,
      );
    })();
  }

  /** When the PR's merge was recorded, or null when none is. Unlike a card's update time, a later change does not move it. */
  mergedAt(repo: string, prNumber: number | null): string | null {
    if (prNumber === null) return null;
    const row = this.db
      .prepare("SELECT at FROM merges WHERE repo = ? AND pr_number = ?")
      .get(repo, prNumber) as { at: string } | undefined;
    return row?.at ?? null;
  }

  /** Whether any merge of the PR is recorded, by Hephaestus or anyone else. */
  hasMerge(repo: string, prNumber: number): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM merges WHERE repo = ? AND pr_number = ?")
        .get(repo, prNumber) !== undefined
    );
  }

  mergedByHephaestus(repo: string, prNumber: number): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM merges WHERE repo = ? AND pr_number = ? AND foreign_merge = 0")
        .get(repo, prNumber) !== undefined
    );
  }

  /** `kind` is `escalation` for a card handed to the owner, which Home already lists. */
  notify(text: string, cardId: number | null = null, kind: "info" | "escalation" = "info"): void {
    this.db
      .prepare("INSERT INTO notifications (at, card_id, text, kind) VALUES (?, ?, ?, ?)")
      .run(this.now().toISOString(), cardId, text, kind);
  }

  notifications(): { id: number; at: string; cardId: number | null; text: string; kind: string }[] {
    return this.db
      .prepare(
        "SELECT id, at, card_id AS cardId, text, kind FROM notifications WHERE dismissed = 0 ORDER BY id DESC",
      )
      .all() as { id: number; at: string; cardId: number | null; text: string; kind: string }[];
  }

  /**
   * The newest notifications, dismissed or not, for the Activity page. With
   * `repo`, only those about one of that project's cards.
   */
  recentNotifications(
    limit = 200,
    repo?: string,
  ): { id: number; at: string; cardId: number | null; text: string; dismissed: boolean }[] {
    return (
      this.db
        .prepare(
          `SELECT id, at, card_id AS cardId, text, dismissed FROM notifications
           WHERE @repo IS NULL OR card_id IN (SELECT id FROM cards WHERE repo = @repo)
           ORDER BY id DESC LIMIT @limit`,
        )
        .all({ limit, repo: repo ?? null }) as {
        id: number;
        at: string;
        cardId: number | null;
        text: string;
        dismissed: number;
      }[]
    ).map((row) => ({ ...row, dismissed: row.dismissed === 1 }));
  }

  dismissNotification(id: number): void {
    this.db.prepare("UPDATE notifications SET dismissed = 1 WHERE id = ?").run(id);
  }
}

/**
 * A card's name in refs and branches outside Hephaestus, scoped to this
 * install: card ids restart at 1 after a reinstall, and a bare
 * `factory/card-1` would collide with the last install's branch on GitHub.
 */
export function cardRef(install: string, cardId: number): string {
  return `${installPrefix(install)}-card-${String(cardId)}`;
}

/**
 * The evidence ref a card's engineer was told to push to. It follows the
 * card's branch, so a card started before branch names carried the install
 * still finds its evidence under the old `card-<id>` name.
 */
export function evidenceRefFor(card: Pick<Card, "id" | "branch">, install: string): string {
  const named =
    card.branch === null ? undefined : /^factory\/(.+?)(?:-retry-\d+)?$/.exec(card.branch)?.[1];
  return `hephaestus/evidence/${named ?? cardRef(install, card.id)}`;
}
