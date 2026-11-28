import { installPrefix } from "../config.js";
import type { PolicySettings } from "../config/policy.js";
import type { Database } from "better-sqlite3";
import type { Stage } from "../hermes/board.js";

/** The task event detail when a PR is sent back because it no longer merges cleanly. */
export const MERGE_CONFLICT_DETAIL = "the PR conflicts with its base branch";
/** The task event detail when a PR is sent back because its reviewer asked for changes. */
export const CHANGES_REQUESTED_DETAIL = "the reviewer asked for changes";
/** The task event detail when the owner unparks a task and its work goes on with their answer. */
export const UNPARKED_DETAIL = "the owner answered, and the work goes on";

export type Provider = "claude" | "codex";
export type EscalationTarget = "lead" | "owner";

export interface Task {
  id: number;
  repo: string;
  issueNumber: number | null;
  title: string;
  stage: Stage;
  hermesTaskId: string | null;
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
  /** Why the task is escalated, or why it was abandoned. */
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
  /** The policy the task last ran under, kept so a merge in flight can finish if its project is removed. */
  policy: PolicySettings | null;
  /**
   * When the task's thread stopped on a provider's usage limit: when the pipeline looks at it
   * again, and the T3 run that stopped, so a run T3 resumed on its own is told from it.
   */
  limitUntil: string | null;
  limitRun: string | null;
  /** The task's place in the lead's queue, lowest first, while it is Queued. */
  queueOrder: number | null;
  /** Why the lead deferred the admitted task; null when it is not deferred. */
  deferReason: string | null;
  /**
   * When a parked task comes back to the owner. A lead's deferral ends when a task finishes
   * instead, so it has none.
   */
  deferUntil: string | null;
  /** The task whose finish ends the deferral; null ends it when any task finishes. */
  deferAfter: number | null;
  /** The last task event when the task was deferred, so only later finishes end the deferral. */
  deferMark: number | null;
  /** When the task last went to the lead to be queued or deferred; null means since it was admitted. */
  triageSince: string | null;
  /** Whether the owner was told the task waits too long for the lead, since triageSince. */
  triageAlerted: boolean;
  /** A queued task whose board task may still be on the lead's ready list, such as one an upgrade queued. */
  parkPending: boolean;
  /**
   * Whether the task's escalation to the owner asks for their answer, from the lead's escalate
   * tool or a hold on the board, rather than a merge to approve or a failure. Only such a task
   * can be parked.
   */
  ownerQuestion: boolean;
  /** Counts every change, so a form from an earlier state of the task is refused. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  id: number;
  taskId: number;
  at: string;
  kind: string;
  detail: string;
}

/** An event with the task it belongs to, as the Activity page lists it. */
export type RecentEvent = TaskEvent & { title: string; repo: string; issueNumber: number | null };

/**
 * Every stage change the pipeline may make. Tests walk this table, and
 * {@link TaskStore.transition} refuses any change it does not list.
 */
export const TRANSITIONS: Record<Stage, readonly Stage[]> = {
  Admitted: ["Queued", "Escalated", "Abandoned"],
  // Implementing only once the implement thread launches; back to Admitted when the lead defers it.
  Queued: ["Implementing", "Admitted", "Escalated", "Abandoned"],
  // Done straight from Implementing, Reviewing, or Merging is a PR merged outside Hephaestus.
  Implementing: ["Implementing", "Reviewing", "Merging", "Escalated", "Abandoned", "Done"],
  Reviewing: ["Reviewing", "Implementing", "Merging", "Escalated", "Abandoned", "Done"],
  // Back to Implementing only when the PR conflicts with its base, so nothing was merged.
  Merging: ["Validating", "Implementing", "Escalated", "Abandoned", "Done"],
  Validating: ["Done", "Reverting", "Escalated"],
  Reverting: ["Implementing", "Escalated"],
  // Queued when the lead restarts a task that never launched a thread; Parked when the owner sets it aside.
  Escalated: ["Queued", "Implementing", "Merging", "Reverting", "Parked", "Abandoned", "Done"],
  // Escalated again when its re-alert time comes. Unparked, work already started goes on, and a
  // task with none starts again from the queue, or from Admitted without a brief. Merging and Done
  // only for a PR found merged meanwhile.
  Parked: ["Escalated", "Implementing", "Queued", "Admitted", "Merging", "Abandoned", "Done"],
  Done: [],
  Abandoned: [],
};

export class TransitionError extends Error {
  constructor(task: Task, to: Stage) {
    super(`Task ${String(task.id)} cannot move from ${task.stage} to ${to}.`);
  }
}

interface Row {
  id: number;
  repo: string;
  issue_number: number | null;
  title: string;
  stage: Stage;
  hermes_task_id: string | null;
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
  queue_order: number | null;
  defer_reason: string | null;
  defer_after: number | null;
  defer_until: string | null;
  owner_question: number;
  defer_mark: number | null;
  triage_since: string | null;
  triage_alerted: number;
  park_pending: number;
  version: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS: Record<keyof Omit<Task, "id" | "createdAt" | "updatedAt" | "version">, string> = {
  repo: "repo",
  issueNumber: "issue_number",
  title: "title",
  stage: "stage",
  hermesTaskId: "hermes_task_id",
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
  queueOrder: "queue_order",
  deferReason: "defer_reason",
  deferAfter: "defer_after",
  deferUntil: "defer_until",
  ownerQuestion: "owner_question",
  deferMark: "defer_mark",
  triageSince: "triage_since",
  triageAlerted: "triage_alerted",
  parkPending: "park_pending",
};

function toTask(row: Row): Task {
  return {
    id: row.id,
    repo: row.repo,
    issueNumber: row.issue_number,
    title: row.title,
    stage: row.stage,
    hermesTaskId: row.hermes_task_id,
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
    queueOrder: row.queue_order,
    deferReason: row.defer_reason,
    deferAfter: row.defer_after,
    deferUntil: row.defer_until,
    ownerQuestion: row.owner_question === 1,
    deferMark: row.defer_mark,
    triageSince: row.triage_since,
    triageAlerted: row.triage_alerted === 1,
    parkPending: row.park_pending === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Hephaestus's record of every task: its stage, threads, PR, and a log of what happened. */
export class TaskStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(task: { repo: string; issueNumber: number | null; title: string }): Task {
    const at = this.now().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO tasks (repo, issue_number, title, stage, created_at, updated_at)
         VALUES (?, ?, ?, 'Admitted', ?, ?)`,
      )
      .run(task.repo, task.issueNumber, task.title, at, at);
    const id = Number(result.lastInsertRowid);
    this.event(
      id,
      "admitted",
      task.issueNumber === null ? task.title : `issue #${String(task.issueNumber)}`,
    );
    return this.get(id);
  }

  get(id: number): Task {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new Error(`There is no task ${String(id)}.`);
    return toTask(row);
  }

  find(id: number): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  byHermesId(hermesTaskId: string): Task | undefined {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE hermes_task_id = ?")
      .get(hermesTaskId) as Row | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  /** The implement and review threads of every task that is not done or abandoned. */
  activeThreadIds(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT implement_thread AS i, review_thread AS r FROM tasks
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

  /** Tasks, newest first, optionally only those in the given stages. */
  list(stages?: readonly Stage[]): Task[] {
    const rows =
      stages === undefined
        ? (this.db.prepare("SELECT * FROM tasks ORDER BY id DESC").all() as Row[])
        : (this.db
            .prepare(
              `SELECT * FROM tasks WHERE stage IN (${stages.map(() => "?").join(", ")}) ORDER BY id DESC`,
            )
            .all(...stages) as Row[]);
    return rows.map(toTask);
  }

  /** The lead's queue: every Queued task, first to launch first. */
  queue(): Task[] {
    return (
      this.db
        .prepare("SELECT * FROM tasks WHERE stage = 'Queued' ORDER BY queue_order, id")
        .all() as Row[]
    ).map(toTask);
  }

  /**
   * Moves the task into the lead's queue, before `before` or at the end, and
   * logs it. Every step runs in one transaction, so the queue's order holds.
   */
  enqueue(
    id: number,
    before: number | undefined,
    detail: string,
    fields: Partial<Omit<Task, "id" | "createdAt" | "updatedAt" | "stage" | "version">>,
  ): Task {
    return this.db.transaction(() => {
      let order: number;
      if (before === undefined) {
        const last = this.db
          .prepare("SELECT MAX(queue_order) AS n FROM tasks WHERE stage = 'Queued' AND id != ?")
          .get(id) as { n: number | null };
        order = (last.n ?? 0) + 1;
      } else {
        const target = this.get(before);
        if (target.stage !== "Queued" || target.queueOrder === null || target.id === id) {
          throw new Error(
            `Task ${String(before)} is not queued, so nothing can be queued before it.`,
          );
        }
        order = target.queueOrder;
        this.db
          .prepare(
            "UPDATE tasks SET queue_order = queue_order + 1 WHERE stage = 'Queued' AND queue_order >= ? AND id != ?",
          )
          .run(order, id);
      }
      const task = this.get(id);
      const queue = {
        ...fields,
        queueOrder: order,
        deferReason: null,
        deferAfter: null,
        deferMark: null,
      };
      if (task.stage === "Queued") {
        this.update(id, queue);
        this.event(id, "queue:moved", detail);
        return this.get(id);
      }
      return this.transition(id, "Queued", detail, queue);
    })();
  }

  /** The id of the newest task event, or 0 when there is none. */
  lastEventId(): number {
    const row = this.db.prepare("SELECT MAX(id) AS n FROM task_events").get() as {
      n: number | null;
    };
    return row.n ?? 0;
  }

  /** Whether a task other than `except` reached Done or Abandoned after the event `mark`. */
  finishedSince(mark: number, except: number): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM task_events WHERE id > ? AND task_id != ?
           AND kind IN ('stage:Done', 'stage:Abandoned') LIMIT 1`,
        )
        .get(mark, except) !== undefined
    );
  }

  update(
    id: number,
    fields: Partial<Omit<Task, "id" | "createdAt" | "updatedAt" | "stage" | "version">>,
  ): Task {
    const entries = Object.entries(fields) as [keyof typeof COLUMNS, unknown][];
    if (entries.length > 0) {
      const sets = entries.map(([key]) => `${COLUMNS[key]} = ?`).join(", ");
      const values = entries.map(([key, value]) =>
        key === "foreignMerge" ||
        key === "reverting" ||
        key === "triageAlerted" ||
        key === "parkPending" ||
        key === "ownerQuestion"
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
        .prepare(`UPDATE tasks SET ${sets}, updated_at = ?, version = version + 1 WHERE id = ?`)
        .run(...(values as (string | number | null)[]), this.now().toISOString(), id);
    }
    return this.get(id);
  }

  /** Moves a task to `to` if the stage diagram allows it, and logs why. */
  transition(
    id: number,
    to: Stage,
    detail: string,
    fields: Partial<Omit<Task, "id" | "createdAt" | "updatedAt" | "stage" | "version">> = {},
  ): Task {
    return this.db.transaction(() => {
      const task = this.get(id);
      if (!TRANSITIONS[task.stage].includes(to)) throw new TransitionError(task, to);
      this.db
        .prepare("UPDATE tasks SET stage = ?, updated_at = ?, version = version + 1 WHERE id = ?")
        .run(to, this.now().toISOString(), id);
      this.update(id, fields);
      this.event(id, `stage:${to}`, detail);
      return this.get(id);
    })();
  }

  event(taskId: number, kind: string, detail: string): void {
    this.db
      .prepare("INSERT INTO task_events (task_id, at, kind, detail) VALUES (?, ?, ?, ?)")
      .run(taskId, this.now().toISOString(), kind, detail);
  }

  events(taskId: number): TaskEvent[] {
    return this.db
      .prepare(
        "SELECT id, task_id AS taskId, at, kind, detail FROM task_events WHERE task_id = ? ORDER BY id",
      )
      .all(taskId) as TaskEvent[];
  }

  /** The newest events across all tasks, for the Activity page. */
  /** The newest task events, of one project's tasks when `repo` is given. */
  /**
   * The newest events. `matches` keeps only the events it accepts, and is
   * applied before `limit` so an older match still counts.
   */
  recentEvents(
    limit = 200,
    repo?: string,
    matches?: (event: RecentEvent) => boolean,
  ): RecentEvent[] {
    const statement = this.db.prepare(
      `SELECT e.id, e.task_id AS taskId, e.at, e.kind, e.detail, c.title, c.repo,
              c.issue_number AS issueNumber
       FROM task_events e JOIN tasks c ON c.id = e.task_id
       WHERE @repo IS NULL OR c.repo = @repo ORDER BY e.id DESC${matches === undefined ? " LIMIT @limit" : ""}`,
    );
    if (matches === undefined) {
      return statement.all({ limit, repo: repo ?? null }) as RecentEvent[];
    }
    // The page matches the text it shows, which is built here in code, so the filter cannot be SQL.
    const found: RecentEvent[] = [];
    for (const row of statement.iterate({ repo: repo ?? null }) as Iterable<RecentEvent>) {
      if (found.length >= limit) break;
      if (matches(row)) found.push(row);
    }
    return found;
  }

  recordReview(review: {
    taskId: number;
    headSha: string;
    reviewer: Provider;
    author: Provider;
    verdict: "approve" | "changes";
    threadId: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO review_results (task_id, head_sha, reviewer, author, verdict, thread_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        review.taskId,
        review.headSha,
        review.reviewer,
        review.author,
        review.verdict,
        review.threadId,
        this.now().toISOString(),
      );
  }

  /**
   * Whether a review thread approved exactly this head commit. The Review job may run on the
   * same provider as the author, so a review counts whichever provider gave it.
   */
  approvedAt(taskId: number, headSha: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM review_results WHERE task_id = ? AND head_sha = ? AND verdict = 'approve'
         ORDER BY at DESC LIMIT 1`,
      )
      .get(taskId, headSha);
    return row !== undefined;
  }

  recordMerge(
    repo: string,
    prNumber: number,
    mergeSha: string,
    taskId: number,
    revert: boolean,
    /** Merged by someone else; recorded so a revert still counts, never as Hephaestus's merge. */
    foreign = false,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO merges (repo, pr_number, merge_sha, task_id, revert, foreign_merge, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repo,
        prNumber,
        mergeSha,
        taskId,
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
  recordForeignRevert(repo: string, prNumber: number, mergeSha: string, taskId: number): void {
    this.db.transaction(() => {
      this.recordMerge(repo, prNumber, mergeSha, taskId, true, true);
      this.event(
        taskId,
        "foreign-merge",
        `revert PR #${String(prNumber)} merged outside Hephaestus`,
      );
    })();
  }

  /** When the PR's merge was recorded, or null when none is. Unlike a task's update time, a later change does not move it. */
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

  /** `kind` is `escalation` for a task handed to the owner, which Home already lists. */
  notify(text: string, taskId: number | null = null, kind: "info" | "escalation" = "info"): void {
    this.db
      .prepare("INSERT INTO notifications (at, task_id, text, kind) VALUES (?, ?, ?, ?)")
      .run(this.now().toISOString(), taskId, text, kind);
  }

  notifications(): { id: number; at: string; taskId: number | null; text: string; kind: string }[] {
    return this.db
      .prepare(
        "SELECT id, at, task_id AS taskId, text, kind FROM notifications WHERE dismissed = 0 ORDER BY id DESC",
      )
      .all() as { id: number; at: string; taskId: number | null; text: string; kind: string }[];
  }

  /**
   * The newest notifications, dismissed or not, for the Activity page. With
   * `repo`, only those about one of that project's tasks.
   */
  /** The newest notifications. `text` keeps those whose text contains it, ignoring ASCII case. */
  recentNotifications(
    limit = 200,
    repo?: string,
    text?: string,
  ): { id: number; at: string; taskId: number | null; text: string; dismissed: boolean }[] {
    return (
      this.db
        .prepare(
          `SELECT id, at, task_id AS taskId, text, dismissed FROM notifications
           WHERE (@repo IS NULL OR task_id IN (SELECT id FROM tasks WHERE repo = @repo))
             AND (@text IS NULL OR instr(lower(text), lower(@text)) > 0)
           ORDER BY id DESC LIMIT @limit`,
        )
        .all({ limit, repo: repo ?? null, text: text ?? null }) as {
        id: number;
        at: string;
        taskId: number | null;
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
 * A task's name in refs and branches outside Hephaestus, scoped to this
 * install: task ids restart at 1 after a reinstall, and a bare
 * `factory/task-1` would collide with the last install's branch on GitHub.
 */
export function taskRef(install: string, taskId: number): string {
  return `${installPrefix(install)}-task-${String(taskId)}`;
}

/**
 * The evidence ref a task's engineer was told to push to. It follows the
 * task's branch, so a task started before branch names carried the install
 * still finds its evidence under its existing branch name.
 */
export function evidenceRefFor(task: Pick<Task, "id" | "branch">, install: string): string {
  const named =
    task.branch === null ? undefined : /^factory\/(.+?)(?:-retry-\d+)?$/.exec(task.branch)?.[1];
  return `hephaestus/evidence/${named ?? taskRef(install, task.id)}`;
}
