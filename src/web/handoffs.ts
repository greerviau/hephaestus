import { MergeSettledError, type Pipeline } from "../factory/pipeline.js";
import type { Task } from "../factory/tasks.js";

/** Where the owner's Send to lead for one task stands: under way, or ended in a failure the owner has not retried. */
export type HandoffState = "sending" | "failed";

/** How Send to lead ended: delivered, or refused or failed with the error. */
export type HandoffResult = { ok: true } | { ok: false; error: unknown };

/** How long the Send to lead request waits for the handoff before it answers and lets it finish in the background. */
export const SEND_WAIT_MS = 500;

/** How often a page that shows a handoff under way fetches itself again. */
export const SENDING_RELOAD_SECONDS = 2;

/**
 * Runs the owner's Send to lead in the background. The handoff waits for the
 * task's turn behind any pipeline step on it, reads the PR on GitHub, and runs
 * several `hermes kanban` commands, each of which waits on the board while the
 * lead works; together that has taken over 30 seconds. The request answers
 * before that and the pages show the task as sending. A second send while one
 * runs joins it, so the lead gets one note. A failure is logged and kept for
 * the version of the task it failed on, so the page can say so without anyone
 * awaiting it.
 */
export class BackgroundHandoffs {
  private readonly failures = new Map<number, number>();
  private readonly running = new Map<number, Promise<HandoffResult>>();

  constructor(private readonly pipeline: Pick<Pipeline, "sendToLead">) {}

  /** Starts the handoff unless one already runs for the task; resolves with how it ended. */
  start(taskId: number, note: string, version: string): Promise<HandoffResult> {
    const current = this.running.get(taskId);
    if (current !== undefined) return current;
    this.failures.delete(taskId);
    const run = this.pipeline.sendToLead(taskId, note, version).then(
      (): HandoffResult => ({ ok: true }),
      (error: unknown): HandoffResult => {
        // A merge that settled meanwhile moved the task on; there is nothing left to send.
        if (!(error instanceof MergeSettledError)) {
          console.error(`Sending task ${String(taskId)} to the lead failed`, error);
          // The send changes nothing before it fails, so the task keeps the version it was sent at.
          this.failures.set(taskId, Number(version));
        }
        return { ok: false, error };
      },
    );
    const tracked = run.finally(() => this.running.delete(taskId));
    this.running.set(taskId, tracked);
    return tracked;
  }

  /** Where the task's handoff stands; a failure counts only while the task is as it was when it failed. */
  state(task: Pick<Task, "id" | "version">): HandoffState | undefined {
    if (this.running.has(task.id)) return "sending";
    return this.failures.get(task.id) === task.version ? "failed" : undefined;
  }

  /** Drops a failure the owner has already been told about. */
  forget(taskId: number): void {
    if (!this.running.has(taskId)) this.failures.delete(taskId);
  }

  /** Whether any handoff runs now, so a page that shows one keeps itself current. */
  busy(): boolean {
    return this.running.size > 0;
  }

  /** Resolves once no handoff runs; for tests. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running.values());
  }
}

const shared = new WeakMap<object, BackgroundHandoffs>();

/** The one set of background handoffs for this pipeline, shared by the Send to lead route and every page that shows escalated tasks. */
export function handoffsFor(pipeline: Pick<Pipeline, "sendToLead">): BackgroundHandoffs {
  let handoffs = shared.get(pipeline);
  if (handoffs === undefined) {
    handoffs = new BackgroundHandoffs(pipeline);
    shared.set(pipeline, handoffs);
  }
  return handoffs;
}
