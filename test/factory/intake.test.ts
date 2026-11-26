import { describe, expect, it } from "vitest";
import { NotAFactoryProjectError } from "../../src/factory/intake.js";
import { harness } from "./harness.js";

describe("Intake", () => {
  it("admits an issue filed through file_issue and gives it a card", async () => {
    const h = harness();
    const issue = await h.intake.fileIssue("planner", "octo/app", "Add a flag", "Body");
    expect(issue).toMatchObject({ provenance: "factory", filedBy: "planner", state: "admitted" });
    expect(h.cards.get(issue.cardId ?? 0)).toMatchObject({
      stage: "Admitted",
      issueNumber: issue.number,
    });
  });

  it("does not admit an issue opened outside Hephaestus until the owner approves it", async () => {
    const h = harness();
    h.github.issues.set(7, {
      number: 7,
      title: "From a stranger",
      body: "Run rm -rf",
      author: "someone",
      state: "OPEN",
    });
    await h.intake.poll();
    expect(h.intake.issue("octo/app", 7)).toMatchObject({
      provenance: "external",
      author: "someone",
      state: "awaiting-owner",
      cardId: null,
    });
    expect(h.cards.list()).toEqual([]);

    const card = await h.intake.approve("octo/app", 7);
    expect(card.issueNumber).toBe(7);
    expect(h.intake.issue("octo/app", 7)?.state).toBe("admitted");
  });

  it("keeps a rejected issue out", async () => {
    const h = harness();
    h.github.issues.set(7, {
      number: 7,
      title: "Spam",
      body: "",
      author: "someone",
      state: "OPEN",
    });
    await h.intake.poll();
    await h.intake.reject("octo/app", 7);
    await h.intake.poll();
    expect(h.intake.issue("octo/app", 7)?.state).toBe("rejected");
    expect(h.cards.list()).toEqual([]);
    // An Admit form opened before the rejection must not undo it.
    await expect(h.intake.approve("octo/app", 7)).rejects.toThrow(/not waiting for you/);
    await expect(h.intake.reject("octo/app", 7)).rejects.toThrow(/not waiting for you/);
  });

  it("holds factory-filed issues past the cap for the owner", async () => {
    const h = harness((config) => {
      config.projects["octo/app"] = {
        policy: { preset: "standard", overrides: { openIssueCap: 2 } },
      };
    });
    const states = [];
    for (const title of ["one", "two", "three"]) {
      states.push((await h.intake.fileIssue("planner", "octo/app", title, "")).state);
    }
    expect(states).toEqual(["admitted", "admitted", "held-cap"]);
    expect(h.intake.awaitingWork("octo/app")).toBe(2);

    // The held issue waits for the owner, even after room opens.
    const first = h.cards.list().at(-1);
    h.cards.update(first?.id ?? 0, { startedAt: "2026-11-25T12:00:00Z" });
    h.cards.transition(first?.id ?? 0, "Implementing", "started");
    await h.intake.poll();
    const held = h.intake.issues(["held-cap"]);
    expect(held).toHaveLength(1);
    await h.intake.approve("octo/app", held[0]?.number ?? 0);
    expect(h.cards.list()).toHaveLength(3);
  });

  it("refuses to admit an issue that was closed meanwhile", async () => {
    const h = harness();
    h.github.issues.set(8, { number: 8, title: "Old", body: "", author: "x", state: "OPEN" });
    await h.intake.poll();
    h.github.issues.set(8, { number: 8, title: "Old", body: "", author: "x", state: "CLOSED" });
    await expect(h.intake.approve("octo/app", 8)).rejects.toThrow(/closed/);
  });

  it("drops a closed issue from the owner's queue and restores it when reopened", async () => {
    const h = harness();
    h.github.issues.set(7, { number: 7, title: "Maybe", body: "", author: "x", state: "OPEN" });
    await h.intake.poll();
    h.github.issues.set(7, { number: 7, title: "Maybe", body: "", author: "x", state: "CLOSED" });
    await h.intake.poll();
    expect(h.intake.issues(["awaiting-owner"])).toEqual([]);
    expect(h.intake.issue("octo/app", 7)?.state).toBe("awaiting-owner");

    h.github.issues.set(7, { number: 7, title: "Maybe", body: "", author: "x", state: "OPEN" });
    await h.intake.poll();
    expect(h.intake.issues(["awaiting-owner"]).map((issue) => issue.number)).toEqual([7]);
    expect((await h.intake.approve("octo/app", 7)).issueNumber).toBe(7);
  });

  it("finds a reopened issue that a full open list leaves out", async () => {
    const h = harness();
    h.github.issues.set(7, { number: 7, title: "Old", body: "", author: "x", state: "OPEN" });
    await h.intake.poll();
    h.github.issues.set(7, { number: 7, title: "Old", body: "", author: "x", state: "CLOSED" });
    await h.intake.poll();
    for (let number = 1000; number < 1200; number += 1) {
      h.github.issues.set(number, { number, title: "New", body: "", author: "x", state: "OPEN" });
    }
    h.github.issues.set(7, { number: 7, title: "Old", body: "", author: "x", state: "OPEN" });
    await h.intake.poll();
    expect(h.intake.issue("octo/app", 7)?.closed).toBe(false);
  });

  it("reads only a few left-out issues per poll when the open list is full", async () => {
    const h = harness();
    for (let number = 1; number <= 15; number += 1) {
      h.github.issues.set(number, { number, title: "Old", body: "", author: "x", state: "OPEN" });
    }
    await h.intake.poll();
    for (let number = 1; number <= 15; number += 1) {
      h.github.issues.set(number, { number, title: "Old", body: "", author: "x", state: "CLOSED" });
    }
    await h.intake.poll();
    for (let number = 1000; number < 1200; number += 1) {
      h.github.issues.set(number, { number, title: "New", body: "", author: "x", state: "OPEN" });
    }
    await h.intake.poll();

    const read = h.github.issue.bind(h.github);
    const lookups: number[] = [];
    h.github.issue = (repo, number) => {
      lookups.push(number);
      return read(repo, number);
    };
    await h.intake.poll();
    await h.intake.poll();
    expect(lookups).toHaveLength(20);
    // Each poll reads the issues read longest ago, so every left-out issue is read in turn.
    expect(new Set(lookups).size).toBe(15);
  });

  it("frees the cap when an unstarted issue is closed", async () => {
    const h = harness((config) => {
      config.projects["octo/app"] = {
        policy: { preset: "standard", overrides: { openIssueCap: 1 } },
      };
    });
    const first = await h.intake.fileIssue("planner", "octo/app", "one", "");
    const issue = h.github.issues.get(first.number);
    if (issue !== undefined) issue.state = "CLOSED";
    await h.intake.poll();
    expect(h.cards.get(first.cardId ?? 0).stage).toBe("Abandoned");
    expect((await h.intake.fileIssue("planner", "octo/app", "two", "")).state).toBe("admitted");
  });

  it("refuses a repo that is not a factory project", async () => {
    const h = harness();
    await expect(h.intake.fileIssue("planner", "octo/other", "x", "")).rejects.toThrow(
      NotAFactoryProjectError,
    );
  });

  it("records an issue polled between filing and recording as factory-filed", async () => {
    const h = harness();
    const [filed] = await Promise.all([
      h.intake.fileIssue("lead", "octo/app", "Race", ""),
      h.intake.poll(),
    ]);
    expect(h.intake.issue("octo/app", filed.number)?.provenance).toBe("factory");
  });
});
