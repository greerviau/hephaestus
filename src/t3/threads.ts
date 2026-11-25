import type { LaunchOptions, T3Adapter } from "./adapter.js";
import type { ThreadEvents } from "./events.js";

export interface ThreadRecord {
  configVersion: number;
  cardId: string | null;
}

/**
 * The one way to start or continue a factory thread. Each launch is recorded
 * before T3 is called and the thread is registered for the follower after, and
 * a message that starts a new run puts the thread back on the follower's list.
 */
export class FactoryThreads {
  constructor(
    private readonly t3: T3Adapter,
    private readonly events: ThreadEvents,
  ) {}

  async launch(options: LaunchOptions, record: ThreadRecord): Promise<string> {
    const thread = {
      environmentId: options.environmentId,
      title: options.title,
      providerInstanceId: options.providerInstanceId,
      model: options.model,
      configVersion: record.configVersion,
      cardId: record.cardId,
    };
    this.events.recordLaunch(options.clientRequestId, thread);
    let threadId: string;
    try {
      ({ threadId } = await this.t3.launchThread(options));
    } catch (error) {
      this.events.finishLaunch(options.clientRequestId, { error: String(error) });
      throw error;
    }
    this.events.recordThread({ ...thread, threadId });
    this.events.finishLaunch(options.clientRequestId, { threadId });
    return threadId;
  }

  async send(
    environmentId: string,
    threadId: string,
    message: string,
    clientRequestId: string,
  ): Promise<void> {
    await this.t3.send(environmentId, threadId, message, clientRequestId);
    this.events.setStatus(environmentId, threadId, "starting");
  }
}
