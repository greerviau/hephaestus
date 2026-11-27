import type { Deploy } from "./versions.js";

/** How long a finished deploy stays in the sidebar before it reads as nothing to say. */
const SUCCESS_SHOWN_MS = 30_000;

/** How a deploy ended: `hermes-failed` reached the workers but not the factory Hermes root. */
export type DeployOutcome = "succeeded" | "failed" | "hermes-failed";

/** What the sidebar shows about deploys. Both parts are absent when there is nothing to say. */
export interface DeployStatus {
  /** The deploy under way, and how many more wait behind it. */
  running?: { version: number; queued: number };
  /** The last deploy that ended; a failure stays until a later deploy succeeds. */
  last?: { version: number; outcome: DeployOutcome };
}

/**
 * Runs deploys in the background, one at a time, so a save can answer at once.
 * A version already running or waiting is not queued again, which makes a
 * second click or a repeated save harmless. A failed deploy is logged in full
 * and kept in the status, so the owner sees it without anyone awaiting it.
 */
export class BackgroundDeploys {
  private readonly waiting: number[] = [];
  private current: number | undefined;
  private last: { version: number; outcome: DeployOutcome; at: number } | undefined;
  private pumping: Promise<void> = Promise.resolve();

  constructor(
    private readonly run: Deploy,
    private readonly now: () => number = Date.now,
  ) {}

  /** Queues the version unless it is already running or waiting; returns without waiting for it. */
  start(id: number): void {
    if (this.has(id)) return;
    this.waiting.push(id);
    if (this.current === undefined) this.pumping = this.pump();
  }

  /** Whether the version is running or waiting, so starting it again would do nothing. */
  has(id: number): boolean {
    return this.current === id || this.waiting.includes(id);
  }

  status(): DeployStatus {
    const status: DeployStatus = {};
    if (this.current !== undefined) {
      status.running = { version: this.current, queued: this.waiting.length };
    }
    const { last } = this;
    if (
      last !== undefined &&
      (last.outcome !== "succeeded" || this.now() - last.at < SUCCESS_SHOWN_MS)
    ) {
      status.last = { version: last.version, outcome: last.outcome };
    }
    return status;
  }

  /** Resolves once nothing runs or waits; for tests. */
  async settled(): Promise<void> {
    do {
      await this.pumping;
    } while (this.current !== undefined || this.waiting.length > 0);
  }

  private async pump(): Promise<void> {
    for (let id = this.waiting.shift(); id !== undefined; id = this.waiting.shift()) {
      this.current = id;
      let outcome: DeployOutcome;
      try {
        const { hermesError } = await this.run(id);
        outcome = hermesError === undefined ? "succeeded" : "hermes-failed";
        if (hermesError !== undefined) {
          console.error(
            `Applying version ${String(id)} to the factory Hermes root failed`,
            hermesError,
          );
        }
      } catch (error) {
        console.error(`Deploying version ${String(id)} failed`, error);
        outcome = "failed";
      }
      this.current = undefined;
      this.last = { version: id, outcome, at: this.now() };
    }
  }
}
