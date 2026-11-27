import { describe, expect, it } from "vitest";
import { FactoryBoard, kanbanStateFor } from "../../src/hermes/board.js";
import { FakeHermes } from "./fake-hermes.js";

function board(): { hermes: FakeHermes; board: FactoryBoard } {
  const hermes = new FakeHermes();
  return { hermes, board: new FactoryBoard({ root: "/factory", run: hermes.run }) };
}

describe("kanbanStateFor", () => {
  it("maps task stages onto kanban states as the Hermes prototype proposed", () => {
    expect(kanbanStateFor("Admitted")).toBe("ready");
    for (const stage of [
      "Queued",
      "Implementing",
      "Reviewing",
      "Merging",
      "Validating",
      "Reverting",
      "Escalated",
    ] as const) {
      expect(kanbanStateFor(stage)).toBe("scheduled");
    }
    expect(kanbanStateFor("Done")).toBe("done");
    expect(kanbanStateFor("Abandoned")).toBe("archived");
  });
});

describe("FactoryBoard", () => {
  it("creates the factory board, which Hermes treats as a no-op when it exists", async () => {
    const { hermes, board: b } = board();

    await b.ensure();

    expect(hermes.lines()).toEqual(["kanban boards create --name=Factory -- factory"]);
  });

  it("creates a task for the lead with an idempotency key and returns its id", async () => {
    const { hermes, board: b } = board();
    hermes.answer(
      (args) => args.includes("create"),
      JSON.stringify({ id: "t_abc123", status: "ready" }),
    );

    const id = await b.createTask({
      title: "--urgent fix",
      body: "--draft",
      idempotencyKey: "task-7",
    });

    expect(id).toBe("t_abc123");
    expect(hermes.calls[0]?.args).toEqual([
      "kanban",
      "--board",
      "factory",
      "create",
      "--body=--draft",
      "--assignee=lead",
      "--idempotency-key=task-7",
      "--json",
      "--",
      "--urgent fix",
    ]);
  });

  it("parks a task for a tracked stage once, without a block Hermes counts, and records the stage", async () => {
    const { hermes, board: b } = board();
    let status = "ready";
    hermes.answer(
      (args) => args.includes("show"),
      () => JSON.stringify({ task: { id: "t_1", status } }),
    );
    hermes.answer(
      (args) => args.includes("schedule"),
      () => {
        status = "scheduled";
        return "";
      },
    );

    await b.setStage("t_1", "Implementing", "thread-9");
    await b.setStage("t_1", "Reviewing", "thread-10");

    expect(hermes.lines().filter((line) => !line.includes(" show "))).toEqual([
      "kanban --board factory schedule -- t_1 stage=Implementing",
      "kanban --board factory comment --author=hephaestus -- t_1 stage=Implementing thread=thread-9",
      "kanban --board factory comment --author=hephaestus -- t_1 stage=Reviewing thread=thread-10",
    ]);
  });

  it("parks a deferred task as scheduled, from ready or from triage, with the reason", async () => {
    const { hermes, board: b } = board();
    let status = "running";
    hermes.answer(
      (args) => args.includes("show"),
      () => JSON.stringify({ task: { id: "t_1", status } }),
    );
    hermes.answer(
      (args) => args.includes("schedule") || args.includes("move-task"),
      () => {
        status = "scheduled";
        return JSON.stringify({ ok: true, status });
      },
    );

    await b.park("t_1", "Deferred until a task finishes: later");
    status = "triage";
    await b.park("t_1", "Deferred until task 3 is finished: needs it");

    expect(hermes.lines().filter((line) => !line.includes(" show "))).toEqual([
      "kanban --board factory schedule -- t_1 deferred",
      "kanban --board factory comment --author=hephaestus -- t_1 Deferred until a task finishes: later",
      "hephaestus move-task --board=factory --to=scheduled -- t_1",
      "kanban --board factory comment --author=hephaestus -- t_1 Deferred until task 3 is finished: needs it",
    ]);
  });

  it("parks a deferred task though the note cannot be added", async () => {
    const { hermes, board: b } = board();
    let status = "ready";
    hermes.answer(
      (args) => args.includes("show"),
      () => JSON.stringify({ task: { id: "t_1", status } }),
    );
    hermes.answer(
      (args) => args.includes("schedule"),
      () => {
        status = "scheduled";
        return "";
      },
    );
    hermes.answer(
      (args) => args.includes("comment"),
      () => {
        throw new Error("database is locked");
      },
    );

    await b.park("t_1", "Deferred until a task finishes: later");
    expect(status).toBe("scheduled");
  });

  it("records Done only after the task completes, and archives for Abandoned", async () => {
    const { hermes, board: b } = board();
    let status = "blocked";
    hermes.answer(
      (args) => args.includes("show"),
      () => JSON.stringify({ task: { id: "t_1", status } }),
    );
    hermes.answer(
      (args) => args.includes("complete") || args.includes("archive"),
      (args) => {
        status = args.includes("complete") ? "done" : "archived";
        return "";
      },
    );

    await b.setStage("t_1", "Done");
    await b.setStage("t_2", "Abandoned");

    expect(hermes.lines().filter((line) => !line.includes(" show "))).toEqual([
      "kanban --board factory complete --result=Validated and merged. -- t_1",
      "kanban --board factory comment --author=hephaestus -- t_1 stage=Done",
      "kanban --board factory archive -- t_2",
      "kanban --board factory comment --author=hephaestus -- t_2 stage=Abandoned",
    ]);
  });

  it("fails without recording the stage when the task did not reach its state", async () => {
    const { hermes, board: b } = board();
    hermes.answer(
      (args) => args.includes("show"),
      JSON.stringify({ task: { id: "t_1", status: "blocked" } }),
    );

    await expect(b.setStage("t_1", "Done")).rejects.toThrow(/still blocked/);
    expect(hermes.lines().some((line) => line.includes("comment"))).toBe(false);
  });

  it("moves a scheduled task back to ready for Admitted, and refuses from done", async () => {
    const { hermes, board: b } = board();
    let status = "scheduled";
    hermes.answer(
      (args) => args.includes("show"),
      () => JSON.stringify({ task: { id: "t_1", status } }),
    );
    hermes.answer(
      (args) => args.includes("unblock"),
      () => {
        status = "ready";
        return "";
      },
    );

    await b.setStage("t_1", "Admitted");
    expect(hermes.lines()).toContain("kanban --board factory unblock -- t_1");

    status = "done";
    await expect(b.setStage("t_1", "Admitted")).rejects.toThrow(/done/);
  });

  it("parks a task Hermes moved to triage through the plugin, which can move it from there", async () => {
    const { hermes, board: b } = board();
    let status = "triage";
    hermes.answer(
      (args) => args.includes("show"),
      () => JSON.stringify({ task: { id: "t_1", status } }),
    );
    hermes.answer(
      (args) => args.includes("move-task"),
      () => {
        status = "scheduled";
        return `noise\n${JSON.stringify({ ok: true, status })}\n`;
      },
    );

    await b.setStage("t_1", "Reviewing", "thread-10");

    expect(hermes.lines().filter((line) => !line.includes(" show "))).toEqual([
      "hephaestus move-task --board=factory --to=scheduled -- t_1",
      "kanban --board factory comment --author=hephaestus -- t_1 stage=Reviewing thread=thread-10",
    ]);
  });

  it("hands a task in triage back to the lead's ready queue", async () => {
    const { hermes, board: b } = board();
    let status = "triage";
    hermes.answer(
      (args) => args.includes("show"),
      () => JSON.stringify({ task: { id: "t_1", status } }),
    );
    hermes.answer(
      (args) => args.includes("move-task"),
      () => {
        status = "ready";
        return JSON.stringify({ ok: true, status });
      },
    );

    await b.handBack("t_1", "Escalated to the lead: the review thread ended failed");
    status = "triage";
    await b.setStage("t_1", "Admitted");

    expect(hermes.lines().filter((line) => !line.includes(" show "))).toEqual([
      "kanban --board factory comment --author=hephaestus -- t_1 Escalated to the lead: the review thread ended failed",
      "hephaestus move-task --board=factory --to=ready -- t_1",
      "hephaestus move-task --board=factory --to=ready -- t_1",
      "kanban --board factory comment --author=hephaestus -- t_1 stage=Admitted",
    ]);
  });

  it("fails a hand-back the plugin refuses or cannot run, after leaving the note", async () => {
    const { hermes, board: b } = board();
    hermes.answer(
      (args) => args.includes("show"),
      JSON.stringify({ task: { id: "t_1", status: "triage" } }),
    );
    hermes.answer(
      (args) => args.includes("move-task"),
      JSON.stringify({ refused: "Hermes did not move task t_1 to ready." }),
    );

    await expect(b.handBack("t_1", "note")).rejects.toThrow(/did not move task t_1/);
    expect(hermes.lines()).toContain(
      "kanban --board factory comment --author=hephaestus -- t_1 note",
    );
  });

  it("leaves the note before moving a task back, and moves nothing when the note fails", async () => {
    const { hermes, board: b } = board();
    hermes.answer(
      (args) => args.includes("show"),
      JSON.stringify({ task: { id: "t_1", status: "scheduled" } }),
    );
    hermes.answer(
      (args) => args.includes("comment"),
      () => {
        throw new Error("database is locked");
      },
    );

    await expect(b.handBack("t_1", "note")).rejects.toThrow(/locked/);
    expect(hermes.lines().some((line) => line.includes("unblock"))).toBe(false);
  });

  it("fails a hand-back of a task no status change can return to the lead", async () => {
    const { hermes, board: b } = board();
    hermes.answer(
      (args) => args.includes("show"),
      JSON.stringify({ task: { id: "t_1", status: "archived" } }),
    );

    await expect(b.handBack("t_1", "note")).rejects.toThrow(/archived/);
  });

  it("fails a hand-back whose task is not in the lead's queue once it is done", async () => {
    const { hermes, board: b } = board();
    let statuses = ["triage", "archived"];
    hermes.answer(
      (args) => args.includes("show"),
      () => JSON.stringify({ task: { id: "t_1", status: statuses.shift() ?? "archived" } }),
    );
    hermes.answer(
      (args) => args.includes("move-task"),
      JSON.stringify({ ok: true, status: "archived" }),
    );

    await expect(b.handBack("t_1", "note")).rejects.toThrow(/archived/);

    // The lead blocks a ready task while the note goes on.
    statuses = ["ready", "blocked"];
    await expect(b.handBack("t_1", "note")).rejects.toThrow(/blocked/);
  });

  it("says why a task is parked from the event that parked it", async () => {
    const { hermes, board: b } = board();
    const block = (reason: string, kind = "blocked") => ({ kind, payload: { reason } });
    const tasks: Record<string, unknown> = {
      t_lead: {
        task: { id: "t_lead", status: "blocked" },
        events: [
          { kind: "unblocked", payload: null },
          block("Waiting on task 5 to merge."),
          { kind: "commented", payload: { author: "lead" } },
        ],
      },
      t_triage: {
        task: { id: "t_triage", status: "triage" },
        events: [block("Waiting on task 5.", "block_loop_detected")],
      },
      t_gave_up: {
        task: { id: "t_gave_up", status: "blocked" },
        events: [block("Old reason."), { kind: "unblocked" }, { kind: "gave_up", payload: {} }],
      },
      // Hermes reads the status and the events apart, so an unblock can land between them.
      t_unblocking: {
        task: { id: "t_unblocking", status: "blocked" },
        events: [block("Waiting on task 5."), { kind: "unblocked", payload: null }],
      },
      t_ready: {
        task: { id: "t_ready", status: "ready" },
        events: [block("Waiting on task 5.")],
      },
    };
    hermes.answer(
      (args) => args.includes("show"),
      (args) => JSON.stringify(tasks[args.at(-1) ?? ""]),
    );

    expect(await b.outsideBlock("t_lead")).toBe("Waiting on task 5 to merge.");
    expect(await b.outsideBlock("t_triage")).toBe("Waiting on task 5.");
    expect(await b.outsideBlock("t_gave_up")).toBe(
      "Hermes stopped retrying the task after repeated failures.",
    );
    expect(await b.outsideBlock("t_unblocking")).toBeUndefined();
    expect(await b.outsideBlock("t_ready")).toBeUndefined();
  });

  it("completes a parked task through blocked, which Hermes completes and no worker claims", async () => {
    const { hermes, board: b } = board();
    let status = "scheduled";
    hermes.answer(
      (args) => args.includes("show"),
      () => JSON.stringify({ task: { id: "t_1", status } }),
    );
    hermes.answer(
      (args) => args.includes("move-task"),
      () => {
        status = "blocked";
        return JSON.stringify({ ok: true, status });
      },
    );
    hermes.answer(
      (args) => args.includes("complete"),
      () => {
        status = "done";
        return "";
      },
    );

    await b.setStage("t_1", "Done");
    status = "triage";
    await b.setStage("t_1", "Done");

    expect(hermes.lines().filter((line) => !line.includes(" show "))).toEqual([
      "hephaestus move-task --board=factory --to=blocked -- t_1",
      "kanban --board factory complete --result=Validated and merged. -- t_1",
      "kanban --board factory comment --author=hephaestus -- t_1 stage=Done",
      "hephaestus move-task --board=factory --to=blocked -- t_1",
      "kanban --board factory complete --result=Validated and merged. -- t_1",
      "kanban --board factory comment --author=hephaestus -- t_1 stage=Done",
    ]);
  });
});
