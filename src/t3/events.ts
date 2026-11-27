import type { Database } from "better-sqlite3";
import type { ThreadItem } from "./adapter.js";

/** Thread statuses after which T3 runs nothing more until someone sends a message. */
export const ENDED_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
  // Set by Hephaestus when T3 no longer has the thread; its stored history stays.
  "unavailable",
]);
/** Item statuses that will not change again. */
const FINAL_ITEM_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "declined",
  "interrupted",
]);

/** What a thread used, when something recorded it. Each field is absent when it was not recorded. */
export interface ThreadUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface FactoryThread {
  environmentId: string;
  threadId: string;
  title: string;
  providerInstanceId: string;
  model: string;
  configVersion: number;
  cardId: string | null;
  /** What the thread is for, such as `implement`, `review`, or `setup`. */
  kind?: string;
}

export interface StoredThread extends FactoryThread {
  kind: string;
  status: string;
  /** The run T3 last reported for the thread, when a read has seen one. */
  latestRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ThreadRow {
  environment_id: string;
  thread_id: string;
  title: string;
  provider_instance_id: string;
  model: string;
  config_version: number;
  card_id: string | null;
  kind: string;
  status: string;
  latest_run_id: string | null;
  created_at: string;
  updated_at: string;
}

function toThread(row: ThreadRow): StoredThread {
  return {
    environmentId: row.environment_id,
    threadId: row.thread_id,
    title: row.title,
    providerInstanceId: row.provider_instance_id,
    model: row.model,
    configVersion: row.config_version,
    cardId: row.card_id,
    kind: row.kind,
    status: row.status,
    latestRunId: row.latest_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Every factory thread and its activity, kept in Hephaestus's own store so the
 * record outlives T3's cleanup of threads and worktrees. Items are keyed by
 * T3's item id, so reading an item again updates it in place.
 */
export class ThreadEvents {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  recordThread(thread: FactoryThread): void {
    const at = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO factory_threads (environment_id, thread_id, title, provider_instance_id, model,
           config_version, card_id, kind, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?)
         ON CONFLICT (environment_id, thread_id) DO NOTHING`,
      )
      .run(
        thread.environmentId,
        thread.threadId,
        thread.title,
        thread.providerInstanceId,
        thread.model,
        thread.configVersion,
        thread.cardId,
        thread.kind ?? "factory",
        at,
        at,
      );
  }

  thread(environmentId: string, threadId: string): StoredThread | undefined {
    const row = this.db
      .prepare("SELECT * FROM factory_threads WHERE environment_id = ? AND thread_id = ?")
      .get(environmentId, threadId) as ThreadRow | undefined;
    return row === undefined ? undefined : toThread(row);
  }

  /** Every thread a card has had, oldest first. */
  forCard(cardId: number): StoredThread[] {
    return (
      this.db
        .prepare("SELECT * FROM factory_threads WHERE card_id = ? ORDER BY created_at, thread_id")
        .all(String(cardId)) as ThreadRow[]
    ).map(toThread);
  }

  /** Threads that have not ended, oldest first. */
  following(): StoredThread[] {
    const ended = [...ENDED_STATUSES];
    return (
      this.db
        .prepare(
          `SELECT * FROM factory_threads WHERE status NOT IN (${ended.map(() => "?").join(", ")})
           ORDER BY created_at, thread_id`,
        )
        .all(...ended) as ThreadRow[]
    ).map(toThread);
  }

  /** Ended threads Hephaestus has not settled in T3 yet, oldest first. */
  unsettledEnded(): StoredThread[] {
    const ended = [...ENDED_STATUSES];
    return (
      this.db
        .prepare(
          `SELECT * FROM factory_threads WHERE settled_at IS NULL
           AND status IN (${ended.map(() => "?").join(", ")}) ORDER BY updated_at, thread_id`,
        )
        .all(...ended) as ThreadRow[]
    ).map(toThread);
  }

  markSettled(environmentId: string, threadId: string): void {
    this.db
      .prepare(
        "UPDATE factory_threads SET settled_at = ? WHERE environment_id = ? AND thread_id = ?",
      )
      .run(this.now().toISOString(), environmentId, threadId);
  }

  setStatus(environmentId: string, threadId: string, status: string): void {
    this.db
      .prepare(
        "UPDATE factory_threads SET status = ?, updated_at = ? WHERE environment_id = ? AND thread_id = ?",
      )
      .run(status, this.now().toISOString(), environmentId, threadId);
  }

  /**
   * Sets the status only if it is still `expected`, and reports whether it did. A run id
   * T3 reported with the status is kept with it.
   */
  setStatusIf(
    environmentId: string,
    threadId: string,
    expected: string,
    status: string,
    latestRunId: string | null = null,
  ): boolean {
    const result = this.db
      .prepare(
        "UPDATE factory_threads SET status = ?, latest_run_id = COALESCE(?, latest_run_id), updated_at = ? WHERE environment_id = ? AND thread_id = ? AND status = ?",
      )
      .run(status, latestRunId, this.now().toISOString(), environmentId, threadId, expected);
    return result.changes > 0;
  }

  /** Keeps the usage given; a field left out keeps what was recorded before. */
  setUsage(environmentId: string, threadId: string, usage: ThreadUsage): void {
    this.db
      .prepare(
        `UPDATE factory_threads SET input_tokens = COALESCE(?, input_tokens),
           output_tokens = COALESCE(?, output_tokens), cost_usd = COALESCE(?, cost_usd)
         WHERE environment_id = ? AND thread_id = ?`,
      )
      .run(
        usage.inputTokens ?? null,
        usage.outputTokens ?? null,
        usage.costUsd ?? null,
        environmentId,
        threadId,
      );
  }

  upsertItems(environmentId: string, threadId: string, items: ThreadItem[]): void {
    const at = this.now().toISOString();
    const upsert = this.db.prepare(
      `INSERT INTO thread_items (environment_id, thread_id, item_id, position, type, status, text, run_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (environment_id, thread_id, item_id) DO UPDATE SET
         position = excluded.position, type = excluded.type, status = excluded.status,
         text = excluded.text, run_id = excluded.run_id, updated_at = excluded.updated_at`,
    );
    this.db.transaction(() => {
      for (const item of items) {
        upsert.run(
          environmentId,
          threadId,
          item.itemId,
          item.position,
          item.type,
          item.status,
          item.text,
          item.runId ?? null,
          at,
        );
      }
    })();
  }

  items(environmentId: string, threadId: string): ThreadItem[] {
    return this.db
      .prepare(
        `SELECT item_id AS itemId, position, type, status, text, run_id AS runId FROM thread_items
         WHERE environment_id = ? AND thread_id = ? ORDER BY position, item_id`,
      )
      .all(environmentId, threadId) as ThreadItem[];
  }

  /**
   * The `afterPosition` for the next read: just before the oldest item that may
   * still change, or the newest position when every item is final. T3 updates
   * items in place, so a cursor that only moves forward would miss their final status.
   */
  resumePosition(environmentId: string, threadId: string): number {
    const items = this.items(environmentId, threadId);
    const open = items.find((item) => !FINAL_ITEM_STATUSES.has(item.status));
    if (open !== undefined) return open.position - 1;
    return items.at(-1)?.position ?? -1;
  }

  /** Records a launch before T3 is called, so a crash between the two leaves a trace. */
  recordLaunch(clientRequestId: string, thread: Omit<FactoryThread, "threadId">): void {
    const at = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO factory_launches (client_request_id, environment_id, title, provider_instance_id,
           model, config_version, card_id, kind, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT (client_request_id) DO UPDATE SET status = 'pending', error = NULL,
           environment_id = CASE WHEN factory_launches.status = 'failed' THEN excluded.environment_id ELSE factory_launches.environment_id END,
           updated_at = excluded.updated_at`,
      )
      .run(
        clientRequestId,
        thread.environmentId,
        thread.title,
        thread.providerInstanceId,
        thread.model,
        thread.configVersion,
        thread.cardId,
        thread.kind ?? "factory",
        at,
        at,
      );
  }

  finishLaunch(clientRequestId: string, outcome: { threadId: string } | { error: string }): void {
    const at = this.now().toISOString();
    if ("threadId" in outcome) {
      this.db
        .prepare(
          "UPDATE factory_launches SET status = 'launched', thread_id = ?, updated_at = ? WHERE client_request_id = ?",
        )
        .run(outcome.threadId, at, clientRequestId);
    } else {
      this.db
        .prepare(
          "UPDATE factory_launches SET status = 'failed', error = ?, updated_at = ? WHERE client_request_id = ?",
        )
        .run(outcome.error, at, clientRequestId);
    }
  }

  launch(
    clientRequestId: string,
  ): { status: "pending" | "launched" | "failed"; threadId: string | null } | undefined {
    return this.db
      .prepare(
        "SELECT status, thread_id AS threadId FROM factory_launches WHERE client_request_id = ?",
      )
      .get(clientRequestId) as
      { status: "pending" | "launched" | "failed"; threadId: string | null } | undefined;
  }
}
