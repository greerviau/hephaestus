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

    expect(hermes.lines()).toEqual(["kanban boards create factory --name Factory"]);
  });

  it("creates a card for the lead with an idempotency key and returns its id", async () => {
    const { hermes, board: b } = board();
    hermes.answer(
      (args) => args.includes("create"),
      JSON.stringify({ id: "t_abc123", status: "ready" }),
    );

    const id = await b.createCard({ title: "Fix #42", body: "Brief", idempotencyKey: "card-7" });

    expect(id).toBe("t_abc123");
    expect(hermes.lines()).toEqual([
      "kanban --board factory create Fix #42 --body Brief --assignee lead --idempotency-key card-7 --json",
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
      "kanban --board factory block t_1 stage=Implementing",
      "kanban --board factory comment t_1 stage=Implementing thread=thread-9 --author hephaestus",
      "kanban --board factory comment t_1 stage=Reviewing thread=thread-10 --author hephaestus",
    ]);
  });

  it("completes a card for Done and archives it for Abandoned", async () => {
    const { hermes, board: b } = board();
    hermes.answer(
      (args) => args.includes("show"),
      JSON.stringify({ task: { id: "t_1", status: "blocked" } }),
    );

    await b.setStage("t_1", "Done");
    await b.setStage("t_2", "Abandoned");

    expect(hermes.lines().filter((line) => !line.includes(" show "))).toEqual([
      "kanban --board factory comment t_1 stage=Done --author hephaestus",
      "kanban --board factory complete t_1 --result Validated and merged.",
      "kanban --board factory comment t_2 stage=Abandoned --author hephaestus",
      "kanban --board factory archive t_2",
    ]);
  });
});
