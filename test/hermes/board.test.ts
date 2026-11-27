import { describe, expect, it } from "vitest";
import { FactoryBoard, kanbanStateFor } from "../../src/hermes/board.js";
import { FakeHermes } from "./fake-hermes.js";

function board(): { hermes: FakeHermes; board: FactoryBoard } {
  const hermes = new FakeHermes();
  return { hermes, board: new FactoryBoard({ root: "/factory", run: hermes.run }) };
}

describe("kanbanStateFor", () => {
  it("maps card stages onto kanban states as the Hermes prototype proposed", () => {
    expect(kanbanStateFor("Admitted")).toBe("ready");
    for (const stage of [
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

  it("creates a card for the lead with an idempotency key and returns its id", async () => {
    const { hermes, board: b } = board();
    hermes.answer(
      (args) => args.includes("create"),
      JSON.stringify({ id: "t_abc123", status: "ready" }),
    );

    const id = await b.createCard({
      title: "--urgent fix",
      body: "--draft",
      idempotencyKey: "card-7",
    });

    expect(id).toBe("t_abc123");
    expect(hermes.calls[0]?.args).toEqual([
      "kanban",
      "--board",
      "factory",
      "create",
      "--body=--draft",
      "--assignee=lead",
      "--idempotency-key=card-7",
      "--json",
      "--",
      "--urgent fix",
    ]);
  });

  it("parks a card for a tracked stage once, without a block Hermes counts, and records the stage", async () => {
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

  it("records Done only after the card completes, and archives for Abandoned", async () => {
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

  it("fails without recording the stage when the card did not reach its state", async () => {
    const { hermes, board: b } = board();
    hermes.answer(
      (args) => args.includes("show"),
      JSON.stringify({ task: { id: "t_1", status: "blocked" } }),
    );

    await expect(b.setStage("t_1", "Done")).rejects.toThrow(/still blocked/);
    expect(hermes.lines().some((line) => line.includes("comment"))).toBe(false);
  });

  it("moves a scheduled card back to ready for Admitted, and refuses from done", async () => {
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

  it("parks a card Hermes moved to triage through the plugin, which can move it from there", async () => {
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

  it("hands a card in triage back to the lead's ready queue", async () => {
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
      "hephaestus move-task --board=factory --to=ready -- t_1",
      "kanban --board factory comment --author=hephaestus -- t_1 Escalated to the lead: the review thread ended failed",
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

  it("completes a parked card through blocked, which Hermes completes and no worker claims", async () => {
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
