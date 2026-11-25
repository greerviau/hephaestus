import type { T3Connection } from "./connection.js";

export interface Environment {
  environmentId: string;
  label: string;
  reachable: boolean;
  status: string;
  access: string;
  expiresAt: string;
  /** Whether T3's last call over this link failed. T3's message is not kept: it can name private addresses. */
  lastCallFailed: boolean;
}

export interface Environments {
  localEnvironmentId: string;
  environments: Environment[];
}

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

export type Workspace =
  | { type: "root" }
  | { type: "worktree"; baseRef: string; branch?: string }
  | { type: "existing_worktree"; worktreePath: string };

export interface LaunchOptions {
  environmentId: string;
  /** The project to work in. Without one, T3 makes a new scratch folder and `workspace` is ignored. */
  projectId?: string;
  title: string;
  providerInstanceId: string;
  model: string;
  options?: { id: string; value: string | boolean }[];
  runtimeMode: RuntimeMode;
  workspace?: Workspace;
  /** The first prompt. Content for the agent goes here inline: T3 cannot send attachments to a linked environment. */
  message: string;
  /** Makes the launch idempotent: a retry with the same id returns the same thread. */
  clientRequestId: string;
}

export interface ThreadItem {
  itemId: string;
  position: number;
  type: string;
  status: string;
  text: string;
}

export interface ThreadPage {
  status: string;
  items: ThreadItem[];
  nextPosition: number;
  hasMore: boolean;
}

export interface RunWait {
  status: string;
  timedOut: boolean;
}

interface RawItem {
  itemId: string;
  position: number;
  type: string;
  status?: string | null;
  text?: string | null;
  title?: string | null;
  textTruncated?: boolean;
  nextTextOffset?: number | null;
}

/** Stored for an item whose text could not be read to the end; not final, so it is read again. */
export const TEXT_INCOMPLETE = "text-incomplete";

/** Typed calls to the T3 tools Hephaestus uses. */
export class T3Adapter {
  constructor(private readonly connection: T3Connection) {}

  async environments(): Promise<Environments> {
    const result = (await this.connection.call("t3_environment_links", {})) as {
      environmentId: string;
      links: (Omit<Environment, "reachable" | "lastCallFailed"> & { lastError: string | null })[];
    };
    return {
      localEnvironmentId: result.environmentId,
      environments: result.links.map((link) => ({
        environmentId: link.environmentId,
        label: link.label,
        reachable: link.status === "reachable",
        status: link.status,
        access: link.access,
        expiresAt: link.expiresAt,
        lastCallFailed: link.lastError !== null,
      })),
    };
  }

  async launchThread(
    options: LaunchOptions,
  ): Promise<{ threadId: string; runId: string | null; projectId: string }> {
    const workspace = options.workspace ?? { type: "root" };
    const workspaceStrategy =
      workspace.type === "worktree" ? { ...workspace, startFromOrigin: true } : workspace;
    const target =
      options.projectId === undefined
        ? { scratch: true }
        : { projectId: options.projectId, workspaceStrategy };
    const result = await this.connection.call("t3_thread_launch", {
      environmentId: options.environmentId,
      ...target,
      title: options.title,
      modelSelection: {
        instanceId: options.providerInstanceId,
        model: options.model,
        ...(options.options === undefined ? {} : { options: options.options }),
      },
      runtimeMode: options.runtimeMode,
      message: options.message,
      clientRequestId: options.clientRequestId,
    });
    return {
      threadId: String(result.threadId),
      runId: typeof result.runId === "string" ? result.runId : null,
      projectId: String(result.projectId),
    };
  }

  async send(
    environmentId: string,
    threadId: string,
    message: string,
    clientRequestId: string,
  ): Promise<void> {
    await this.connection.call("t3_thread_send", {
      environmentId,
      threadId,
      message,
      mode: "auto",
      clientRequestId,
    });
  }

  /** Activity items after `afterPosition`, oldest first, each with its whole text. */
  async read(environmentId: string, threadId: string, afterPosition: number): Promise<ThreadPage> {
    const result = (await this.connection.call("t3_thread_read", {
      environmentId,
      threadId,
      view: "activity",
      afterPosition,
      limit: 100,
      maxCharsPerItem: 20000,
    })) as { thread: { status: string }; items: RawItem[]; nextPosition: number; hasMore: boolean };
    const items: ThreadItem[] = [];
    for (const item of result.items) {
      let text = item.text ?? item.title ?? "";
      let next = item.textTruncated === true ? item.nextTextOffset : null;
      let offset = -1;
      // Read until T3 reports the end; stop if an offset fails to move forward.
      while (typeof next === "number" && next > offset) {
        offset = next;
        const rest = (await this.connection.call("t3_thread_read", {
          environmentId,
          threadId,
          view: "activity",
          itemId: item.itemId,
          textOffset: next,
          maxCharsPerItem: 20000,
        })) as { items: RawItem[] };
        const part = rest.items.find((candidate) => candidate.itemId === item.itemId);
        if (part === undefined) break;
        text += part.text ?? "";
        next = part.textTruncated === true ? part.nextTextOffset : null;
      }
      const complete = typeof next !== "number";
      items.push({
        itemId: item.itemId,
        position: item.position,
        type: item.type,
        status: complete ? (item.status ?? "completed") : TEXT_INCOMPLETE,
        text,
      });
    }
    return {
      status: result.thread.status,
      items,
      nextPosition: result.nextPosition,
      hasMore: result.hasMore,
    };
  }

  /** Waits up to `timeoutMs` for the thread's latest run to finish. */
  async wait(environmentId: string, threadId: string, timeoutMs: number): Promise<RunWait> {
    const result = await this.connection.call("t3_thread_wait", {
      environmentId,
      threadId,
      timeoutMs,
    });
    return { status: String(result.status), timedOut: result.timedOut === true };
  }

  /** Clones `owner/repo` from GitHub into `destinationPath` and registers it as a project. */
  async cloneProject(
    environmentId: string,
    repo: string,
    destinationPath: string,
  ): Promise<string> {
    await this.connection.call("t3_project_clone", {
      environmentId,
      remoteUrl: `https://github.com/${repo}.git`,
      destinationPath,
      protocol: "https",
    });
    const project = await this.connection.call("t3_project_create", {
      environmentId,
      title: repo,
      workspaceRoot: destinationPath,
    });
    return String(project.id);
  }

  async archive(environmentId: string, threadId: string): Promise<void> {
    await this.connection.call("t3_thread_organize", {
      environmentId,
      threadId,
      action: "archive",
    });
  }
}
