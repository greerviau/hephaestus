import { lastJsonLine, type FactoryHermes } from "./cli.js";

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

export type KanbanState = "ready" | "scheduled" | "done" | "archived";

/**
 * Where each card stage sits on the board. `running` belongs to a live Hermes
 * worker, so the long stages, whose work runs in T3 threads, park the card as
 * `scheduled`, which no worker claims. Hephaestus's store holds the stage
 * itself, mirrored in a comment.
 *
 * Parking a card with `block` instead would feed Hermes's unblock-loop
 * breaker: a task blocked again for the same kind after an unblock goes to
 * `triage`, and the count resets only when the task completes. Every card the
 * lead takes back a second time would then land in `triage`, where nothing
 * picks it up.
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
      return "scheduled";
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
    if (target === "scheduled") {
      if (current === "triage") await this.moveTask(id, "scheduled");
      else if (current !== "scheduled") await this.kanban("schedule", "--", id, `stage=${stage}`);
    } else if (target === "done") {
      // Hermes completes nothing from scheduled or triage; blocked, unlike ready, is never claimed meanwhile.
      if (current === "scheduled" || current === "triage") await this.moveTask(id, "blocked");
      if (current !== "done")
        await this.kanban("complete", "--result=Validated and merged.", "--", id);
    } else if (target === "archived") {
      if (current !== "archived") await this.kanban("archive", "--", id);
    } else if (current !== "ready" && !(await this.release(id, current))) {
      throw new Error(`Card ${id} is ${current}; it cannot move back to ready.`);
    }
    const reached = await this.status(id);
    if (reached !== target) {
      throw new Error(`Card ${id} is still ${reached}; expected ${target} for ${stage}.`);
    }
    await this.comment(id, note);
  }

  /**
   * Puts an escalated card back in the lead's ready queue with a note saying why.
   * A card whose parent the lead linked is still unfinished waits in `todo`,
   * and Hermes readies it when the parent is done.
   */
  async handBack(id: string, note: string): Promise<void> {
    let failure: Error | undefined;
    try {
      await this.release(id, await this.status(id));
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    // The note goes on even when the card could not move, so the lead sees it whenever it looks.
    await this.comment(id, note);
    if (failure !== undefined) throw failure;
  }

  /** Moves a parked card toward the lead's ready queue; false when its status has no way back. */
  private async release(id: string, current: string): Promise<boolean> {
    if (current === "blocked" || current === "scheduled") {
      await this.kanban("unblock", "--", id);
      return true;
    }
    if (current === "triage") {
      await this.moveTask(id, "ready");
      return true;
    }
    return false;
  }

  /**
   * Makes a move Hermes's CLI has no command for: out of `triage` without
   * running a model, or from `scheduled` to `blocked`. The Hephaestus plugin
   * moves the task the way a drag on Hermes's dashboard does.
   */
  private async moveTask(id: string, to: "ready" | "scheduled" | "blocked"): Promise<void> {
    const output = await this.hermes.run([
      "hephaestus",
      "move-task",
      `--board=${this.slug}`,
      `--to=${to}`,
      "--",
      id,
    ]);
    const result = lastJsonLine(output) as
      { ok?: unknown; refused?: unknown; outdated?: unknown } | undefined;
    if (result?.ok === true) return;
    const reason =
      typeof result?.refused === "string"
        ? result.refused
        : typeof result?.outdated === "string"
          ? `Hermes code the plugin calls is missing (${result.outdated})`
          : output.trim().slice(-200);
    throw new Error(`Moving card ${id} to ${to} failed: ${reason}`);
  }

  async comment(id: string, text: string): Promise<void> {
    await this.kanban("comment", "--author=hephaestus", "--", id, text);
  }

  private kanban(...args: string[]): Promise<string> {
    return this.hermes.run(["kanban", "--board", this.slug, ...args]);
  }
}
