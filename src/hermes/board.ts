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
 * Where each task stage sits on the board. `running` belongs to a live Hermes
 * worker, so the long stages, whose work runs in T3 threads, park the task as
 * `scheduled`, which no worker claims. Hephaestus's store holds the stage
 * itself, mirrored in a comment.
 *
 * Parking a task with `block` instead would feed Hermes's unblock-loop
 * breaker: a task blocked again for the same kind after an unblock goes to
 * `triage`, and the count resets only when the task completes. Every task the
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

/**
 * The newest of these events is what Hermes itself reads to tell why a task last changed state.
 * Of them, these park a task where the lead's queue never reaches it.
 */
const LIFECYCLE_EVENTS = new Set([
  "blocked",
  "block_loop_detected",
  "dependency_wait",
  "gave_up",
  "unblocked",
  "changes_requested",
  "review_reopened",
  "status",
  "reclaimed",
  "stale",
  "timed_out",
  "crashed",
  "spawn_failed",
  "rate_limited",
]);
const PARKING_EVENTS = new Set(["blocked", "block_loop_detected", "gave_up"]);
/** Statuses in which the lead's queue has the task, or the lead is running on it. */
const IN_LEAD_QUEUE = new Set(["ready", "todo", "running"]);

interface KanbanEvent {
  kind: string;
  reason: string | undefined;
}

/** Why a task is parked where the lead's queue never reaches it, as `show` gave it. */
function heldBy(shown: { status: unknown; events: KanbanEvent[] }): string | undefined {
  if (shown.status !== "blocked" && shown.status !== "triage") return undefined;
  const cause = shown.events.findLast((event) => LIFECYCLE_EVENTS.has(event.kind));
  return cause !== undefined && PARKING_EVENTS.has(cause.kind) ? holdReason(cause) : undefined;
}

/** The reason a parking event gives, or what it means when it gives none. */
function holdReason(event: KanbanEvent): string {
  if (event.reason !== undefined && event.reason.trim() !== "") return event.reason;
  return event.kind === "gave_up"
    ? "Hermes stopped retrying the task after repeated failures."
    : "No reason was given.";
}

export interface NewTask {
  title: string;
  body: string;
  /** Retrying with the same key returns the existing task. */
  idempotencyKey: string;
  /** The lead picks up admitted tasks. */
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

  async createTask(task: NewTask): Promise<string> {
    const output = await this.kanban(
      "create",
      `--body=${task.body}`,
      `--assignee=${task.assignee ?? "lead"}`,
      `--idempotency-key=${task.idempotencyKey}`,
      "--json",
      "--",
      task.title,
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
   * Why the task is parked where the lead's queue never reaches it: `blocked` or in `triage`,
   * which Hephaestus never parks its own tasks as, so the lead's own block tool or Hermes did.
   * Nothing when it is not parked. Hermes reads a task's status and its events apart, so an
   * unblock can land between them; a newest lifecycle event that parks nothing counts as not
   * parked. `show` changes nothing, unlike `list`, which first promotes tasks.
   */
  async outsideBlock(id: string): Promise<string | undefined> {
    return heldBy(await this.show(id));
  }

  /**
   * Takes the task off the lead's queue for `stage` unless the lead or Hermes parked it first,
   * and says why when they did. Hermes takes no condition on a move, so a block that lands
   * while Hephaestus parks the task is found in the events that came after the first read.
   */
  async claim(id: string, stage: Stage): Promise<string | undefined> {
    const before = await this.show(id);
    const held = heldBy(before);
    if (held !== undefined) return held;
    const seen = before.events.length;
    await this.setStage(id, stage);
    const late = (await this.show(id)).events
      .slice(seen)
      .findLast((event) => PARKING_EVENTS.has(event.kind));
    return late === undefined ? undefined : holdReason(late);
  }

  private async show(id: string): Promise<{ status: unknown; events: KanbanEvent[] }> {
    const shown = parseJson(await this.kanban("show", "--json", "--", id)) as { events?: unknown };
    const events = Array.isArray(shown.events) ? (shown.events as unknown[]) : [];
    return {
      status: taskOf(shown).status,
      events: events.map((event) => {
        const record = event as { kind?: unknown; payload?: { reason?: unknown } | null };
        return {
          kind: typeof record.kind === "string" ? record.kind : "",
          reason: typeof record.payload?.reason === "string" ? record.payload.reason : undefined,
        };
      }),
    };
  }

  /**
   * Moves a task to the kanban state for `stage`, checks that it got there,
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
      throw new Error(`Task ${id} is ${current}; it cannot move back to ready.`);
    }
    const reached = await this.status(id);
    if (reached !== target) {
      throw new Error(`Task ${id} is still ${reached}; expected ${target} for ${stage}.`);
    }
    await this.comment(id, note);
  }

  /**
   * Puts an escalated task back in the lead's ready queue with a note saying why.
   * A task whose parent the lead linked is still unfinished waits in `todo`,
   * and Hermes readies it when the parent is done.
   */
  async handBack(id: string, note: string): Promise<void> {
    const current = await this.status(id);
    // The note first: it is there whenever the lead looks, and a task whose note failed has not
    // moved, so it never reaches the lead's queue while Hephaestus still holds it for the owner.
    await this.comment(id, note);
    if (!IN_LEAD_QUEUE.has(current)) await this.release(id, current);
    // Read back, since a move can report success for a task changed meanwhile, such as archived.
    const reached = await this.status(id);
    if (!IN_LEAD_QUEUE.has(reached)) {
      throw new Error(
        `Task ${id} is ${reached} on the Hermes board; it did not go back to the lead.`,
      );
    }
  }

  /** Moves a parked task toward the lead's ready queue; false when its status has no way back. */
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
    throw new Error(`Moving task ${id} to ${to} failed: ${reason}`);
  }

  async comment(id: string, text: string): Promise<void> {
    await this.kanban("comment", "--author=hephaestus", "--", id, text);
  }

  private kanban(...args: string[]): Promise<string> {
    return this.hermes.run(["kanban", "--board", this.slug, ...args]);
  }
}
