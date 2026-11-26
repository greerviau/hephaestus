import type { LaunchOptions, T3Adapter } from "./adapter.js";
import { T3ToolError } from "./connection.js";
import type { ThreadEvents } from "./events.js";

export interface ThreadRecord {
  configVersion: number;
  cardId: string | null;
  kind?: string;
}

/**
 * The one way to start or continue a factory thread. Each launch is recorded
 * before T3 is called and the thread is registered for the follower after.
 * When T3 may have acted but its reply was lost, the record says so instead
 * of claiming a failure.
 */
export class FactoryThreads {
  constructor(
    private readonly t3: T3Adapter,
    private readonly events: ThreadEvents,
  ) {}

  /**
   * Launches a thread and returns its id. A launch T3 refused is marked
   * failed. A launch whose reply was lost stays pending, since T3 may have
   * started it (see issue #21).
   */
  async launch(options: LaunchOptions, record: ThreadRecord): Promise<string> {
    const thread = {
      environmentId: options.environmentId,
      title: options.title,
      providerInstanceId: options.providerInstanceId,
      model: options.model,
      configVersion: record.configVersion,
      cardId: record.cardId,
      kind: record.kind ?? "factory",
    };
    this.events.recordLaunch(options.clientRequestId, thread);
    let threadId: string;
    try {
      ({ threadId } = await this.t3.launchThread(options));
    } catch (error) {
      if (error instanceof T3ToolError) {
        this.events.finishLaunch(options.clientRequestId, { error: error.code });
      }
      throw error;
    }
    this.events.recordThread({ ...thread, threadId });
    this.events.finishLaunch(options.clientRequestId, { threadId });
    return threadId;
  }

  /**
   * Settles a finished thread in T3 and records that it did. A thread T3 no
   * longer has is recorded too, so it is not retried forever. Any other
   * failure, such as a worker that is offline for a while, throws, and the
   * thread is tried again later.
   */
  async settle(environmentId: string, threadId: string): Promise<void> {
    try {
      await this.t3.settle(environmentId, threadId);
    } catch (error) {
      if (!(error instanceof T3ToolError && error.code === "thread_not_found")) throw error;
    }
    this.events.markSettled(environmentId, threadId);
  }

  /**
   * Sends a message. The thread goes back on the follower's list first, so a
   * run the message starts is followed even if T3's reply is lost. If T3
   * refuses the message, the thread's earlier status comes back.
   */
  async send(
    environmentId: string,
    threadId: string,
    message: string,
    clientRequestId: string,
  ): Promise<void> {
    const before = this.events.thread(environmentId, threadId)?.status;
    this.events.setStatus(environmentId, threadId, "starting");
    try {
      await this.t3.send(environmentId, threadId, message, clientRequestId);
    } catch (error) {
      if (error instanceof T3ToolError && before !== undefined) {
        this.events.setStatusIf(environmentId, threadId, "starting", before);
      }
      throw error;
    }
  }
}
