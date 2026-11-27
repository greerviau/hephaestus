import type { T3Adapter } from "./adapter.js";
import { T3ToolError } from "./connection.js";
import { ENDED_STATUSES, type StoredThread, type ThreadEvents } from "./events.js";

export interface FollowerOptions {
  /** How long each wait on a running thread may block. */
  waitMs?: number;
  onError?: (error: unknown, thread: StoredThread) => void;
  now?: () => number;
  /** The least time between two polls of one thread, for when T3 answers a wait at once. */
  minIntervalMs?: number;
}

const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;

function key(thread: { environmentId: string; threadId: string }): string {
  return `${thread.environmentId}\n${thread.threadId}`;
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

/**
 * Copies the activity of every running factory thread from T3 into the event
 * store. Each thread is polled on its own, so a stalled worker delays only its
 * own threads, and a failing thread backs off up to five minutes.
 */
export class ThreadFollower {
  private readonly waitMs: number;
  private readonly onError: (error: unknown, thread: StoredThread) => void;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly failures = new Map<string, { count: number; retryAt: number }>();

  constructor(
    private readonly t3: T3Adapter,
    private readonly events: ThreadEvents,
    {
      waitMs = 20_000,
      onError = (error) => {
        console.error("Following a thread failed", error);
      },
      now = Date.now,
      minIntervalMs = 1_000,
    }: FollowerOptions = {},
  ) {
    this.waitMs = waitMs;
    this.minIntervalMs = minIntervalMs;
    this.onError = onError;
    this.now = now;
  }

  /** One wait and read for every thread that has not ended and is not backing off. */
  async followAll(): Promise<void> {
    const due = this.events.following().filter((thread) => this.retryIn(thread) <= 0);
    await Promise.all(due.map((thread) => this.attempt(thread)));
  }

  /** Follows threads until `signal` aborts, starting a loop per thread as threads appear. */
  async run(signal: AbortSignal, scanMs = 5_000): Promise<void> {
    const active = new Map<string, Promise<void>>();
    while (!signal.aborted) {
      for (const thread of this.events.following()) {
        const id = key(thread);
        if (active.has(id)) continue;
        active.set(
          id,
          this.followThread(thread, signal).finally(() => active.delete(id)),
        );
      }
      await sleep(scanMs, signal);
    }
    await Promise.allSettled(active.values());
  }

  private async followThread(thread: StoredThread, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const current = this.events.thread(thread.environmentId, thread.threadId);
      if (current === undefined || ENDED_STATUSES.has(current.status)) return;
      const wait = this.retryIn(current);
      if (wait > 0) {
        await sleep(wait, signal);
        continue;
      }
      const started = this.now();
      await this.attempt(current);
      const elapsed = this.now() - started;
      if (elapsed < this.minIntervalMs) await sleep(this.minIntervalMs - elapsed, signal);
    }
  }

  private retryIn(thread: StoredThread): number {
    const failure = this.failures.get(key(thread));
    return failure === undefined ? 0 : failure.retryAt - this.now();
  }

  private async attempt(thread: StoredThread): Promise<void> {
    try {
      await this.followOnce(thread);
      this.failures.delete(key(thread));
    } catch (error) {
      if (error instanceof T3ToolError && error.code === "thread_not_found") {
        this.events.setStatus(thread.environmentId, thread.threadId, "unavailable");
        this.failures.delete(key(thread));
        this.onError(error, thread);
        return;
      }
      const count = (this.failures.get(key(thread))?.count ?? 0) + 1;
      const delay = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (count - 1));
      this.failures.set(key(thread), { count, retryAt: this.now() + delay });
      this.onError(error, thread);
    }
  }

  private async followOnce(thread: StoredThread): Promise<void> {
    const { environmentId, threadId } = thread;
    const before = this.events.thread(environmentId, threadId)?.status ?? thread.status;
    await this.t3.wait(environmentId, threadId, this.waitMs);
    let last = await this.readAll(environmentId, threadId);
    // A run can end between pages, leaving an item from an earlier page stored
    // as running. One more pass from the oldest open item settles it.
    if (ENDED_STATUSES.has(last.status) && this.hasOpenItems(environmentId, threadId)) {
      last = await this.readAll(environmentId, threadId);
    }
    // A send may have reset the status to starting while this read ran; that wins.
    this.events.setStatusIf(environmentId, threadId, before, last.status, last.latestRunId);
  }

  private async readAll(
    environmentId: string,
    threadId: string,
  ): Promise<{ status: string; latestRunId: string | null }> {
    let after = this.events.resumePosition(environmentId, threadId);
    for (;;) {
      const page = await this.t3.read(environmentId, threadId, after);
      this.events.upsertItems(environmentId, threadId, page.items);
      if (!page.hasMore || page.nextPosition <= after) {
        return { status: page.status, latestRunId: page.latestRunId };
      }
      after = page.nextPosition;
    }
  }

  private hasOpenItems(environmentId: string, threadId: string): boolean {
    const items = this.events.items(environmentId, threadId);
    return this.events.resumePosition(environmentId, threadId) < (items.at(-1)?.position ?? -1);
  }
}
