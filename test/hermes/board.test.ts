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
      expect(kanbanStateFor(stage)).toBe("blocked");
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

  it("blocks a card for a tracked stage once and records the stage as a comment", async () => {
    const { hermes, board: b } = board();
    let status = "ready";
    hermes.answer(
      (args) => args.includes("show"),
      () => JSON.stringify({ task: { id: "t_1", status } }),
    );
    hermes.answer(
      (args) => args.includes("block"),
      () => {
        status = "blocked";
        return "";
      },
    );

    await b.setStage("t_1", "Implementing", "thread-9");
    await b.setStage("t_1", "Reviewing", "thread-10");

    expect(hermes.lines().filter((line) => !line.includes(" show "))).toEqual([
      "kanban --board factory block -- t_1 stage=Implementing",
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
});
