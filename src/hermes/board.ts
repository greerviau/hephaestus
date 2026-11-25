import type { FactoryHermes } from "./cli.js";

export const STAGES = [
  "Admitted",
  "Implementing",
  "Reviewing",
  "Merging",
  "Validating",
  "Reverting",
  "Escalated",
  "Done",
  "Abandoned",
] as const;
export type Stage = (typeof STAGES)[number];

export type KanbanState = "ready" | "blocked" | "done" | "archived";

/**
 * Where each card stage sits on the board, from the Hermes prototype (#4).
 * `running` belongs to a live Hermes worker, so the long stages, whose work
 * runs in T3 threads, park the card as `blocked`. Hephaestus's store holds
 * the stage itself, mirrored in a comment.
 */
export function kanbanStateFor(stage: Stage): KanbanState {
  switch (stage) {
    case "Admitted":
      return "ready";
    case "Done":
      return "done";
    case "Abandoned":
      return "archived";
    default:
      return "blocked";
  }
}

export interface NewCard {
  title: string;
  body: string;
  /** Retrying with the same key returns the existing card. */
  idempotencyKey: string;
  /** The lead picks up admitted cards. */
  assignee?: string;
}

function parseJson(output: string): unknown {
  const start = output.indexOf("{");
  if (start < 0) throw new Error(`hermes printed no JSON: ${output.slice(0, 200)}`);
  return JSON.parse(output.slice(start)) as unknown;
}

function taskOf(value: unknown): { id?: unknown; status?: unknown } {
  const record = value as { task?: unknown; id?: unknown; status?: unknown };
  return record.task ?? record;
}

/**
 * The factory kanban board in the factory Hermes root, driven through
 * `hermes kanban`. Option values use `--option=value` and free text comes
 * after `--`, so text that starts with a dash is never read as a flag.
 */
export class FactoryBoard {
  constructor(
    private readonly hermes: FactoryHermes,
    readonly slug = "factory",
  ) {}

  /** Creates the board; Hermes answers "already exists" and succeeds when it is there. */
  async ensure(): Promise<void> {
    await this.hermes.run(["kanban", "boards", "create", `--name=Factory`, "--", this.slug]);
  }

  async createCard(card: NewCard): Promise<string> {
    const output = await this.kanban(
      "create",
      `--body=${card.body}`,
      `--assignee=${card.assignee ?? "lead"}`,
      `--idempotency-key=${card.idempotencyKey}`,
      "--json",
      "--",
      card.title,
    );
    const id = taskOf(parseJson(output)).id;
    if (typeof id !== "string") throw new Error(`hermes kanban create returned no id: ${output}`);
    return id;
  }

  async status(id: string): Promise<string> {
    const status = taskOf(parseJson(await this.kanban("show", "--json", "--", id))).status;
    return typeof status === "string" ? status : "unknown";
  }

  /**
   * Moves a card to the kanban state for `stage`, checks that it got there,
   * and only then records the stage in a comment.
   */
  async setStage(id: string, stage: Stage, threadId?: string): Promise<void> {
    const target = kanbanStateFor(stage);
    const note = threadId === undefined ? `stage=${stage}` : `stage=${stage} thread=${threadId}`;
    const current = await this.status(id);
    if (target === "blocked") {
      if (current !== "blocked") await this.kanban("block", "--", id, `stage=${stage}`);
    } else if (target === "done") {
      if (current !== "done")
        await this.kanban("complete", "--result=Validated and merged.", "--", id);
    } else if (target === "archived") {
      if (current !== "archived") await this.kanban("archive", "--", id);
    } else if (current === "blocked" || current === "scheduled") {
      await this.kanban("unblock", "--", id);
    } else if (current !== "ready") {
      throw new Error(`Card ${id} is ${current}; it cannot move back to ready.`);
    }
    const reached = await this.status(id);
    if (reached !== target) {
      throw new Error(`Card ${id} is still ${reached}; expected ${target} for ${stage}.`);
    }
    await this.comment(id, note);
  }

  async comment(id: string, text: string): Promise<void> {
    await this.kanban("comment", "--author=hephaestus", "--", id, text);
  }

  private kanban(...args: string[]): Promise<string> {
    return this.hermes.run(["kanban", "--board", this.slug, ...args]);
  }
}
