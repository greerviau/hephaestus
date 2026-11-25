import type { T3Adapter } from "./adapter.js";
import { ENDED_STATUSES, type StoredThread, type ThreadEvents } from "./events.js";

export interface FollowerOptions {
  /** How long each wait on a running thread may block. */
  waitMs?: number;
  onError?: (error: unknown, thread: StoredThread) => void;
}

/** Copies the activity of every running factory thread from T3 into the event store. */
export class ThreadFollower {
  private readonly waitMs: number;
  private readonly onError: (error: unknown, thread: StoredThread) => void;

  constructor(
    private readonly t3: T3Adapter,
    private readonly events: ThreadEvents,
    {
      waitMs = 20_000,
      onError = (error) => {
        console.error("Following a thread failed", error);
      },
    }: FollowerOptions = {},
  ) {
    this.waitMs = waitMs;
    this.onError = onError;
  }

  /** Follows each thread that has not ended for one wait and one read. One failing thread does not stop the rest. */
  async followAll(): Promise<void> {
    const threads = this.events.following();
    await Promise.all(
      threads.map(async (thread) => {
        try {
          await this.followOnce(thread);
        } catch (error) {
          this.onError(error, thread);
        }
      }),
    );
  }

  private async followOnce(thread: StoredThread): Promise<void> {
    const { environmentId, threadId } = thread;
    await this.t3.wait(environmentId, threadId, this.waitMs);
    let after = this.events.resumePosition(environmentId, threadId);
    let status: string;
    for (;;) {
      const page = await this.t3.read(environmentId, threadId, after);
      this.events.upsertItems(environmentId, threadId, page.items);
      status = page.status;
      if (!page.hasMore || page.nextPosition <= after) break;
      after = page.nextPosition;
    }
    this.events.setStatus(environmentId, threadId, status);
  }

  /** Follows threads until `signal` aborts, pausing briefly when nothing is running. */
  async run(signal: AbortSignal, idleMs = 5_000): Promise<void> {
    while (!signal.aborted) {
      if (this.events.following().length === 0) {
        await new Promise((resolve) => setTimeout(resolve, idleMs).unref());
        continue;
      }
      await this.followAll();
    }
  }

  static ended(status: string): boolean {
    return ENDED_STATUSES.has(status);
  }
}
