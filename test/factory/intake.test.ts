import { describe, expect, it } from "vitest";
import type { Issue } from "../../src/factory/github.js";
import { Intake, NotAFactoryProjectError } from "../../src/factory/intake.js";
import { harness } from "./harness.js";

describe("Intake", () => {
  it("admits an issue filed through file_issue and gives it a task", async () => {
    const h = harness();
    const issue = await h.intake.fileIssue("communicator", "octo/app", "Add a flag", "Body");
    expect(issue).toMatchObject({
      provenance: "factory",
      filedBy: "communicator",
      state: "admitted",
    });
    expect(h.tasks.get(issue.taskId ?? 0)).toMatchObject({
      stage: "Admitted",
      issueNumber: issue.number,
    });
  });

  it("tells the lead on the board task to queue or defer the task", async () => {
    const h = harness();
    const bodies: string[] = [];
    const intake = new Intake({
      db: h.db,
      tasks: h.tasks,
      github: h.github,
      config: () => h.config,
      board: () => ({
        createTask: (task) => {
          bodies.push(task.body);
          return Promise.resolve("t_1");
        },
      }),
    });
    const issue = await intake.fileIssue("communicator", "octo/app", "Add a flag", "Body");
    const id = String(issue.taskId);
    expect(bodies).toEqual([
      `Hephaestus task ${id} for https://github.com/octo/app/issues/${String(issue.number)}. Queue it with queue_work and task_id ${id}, or defer it with defer_work.`,
    ]);
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
      taskId: null,
    });
    expect(h.tasks.list()).toEqual([]);

    const task = await h.intake.approve("octo/app", 7);
    expect(task.issueNumber).toBe(7);
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
    expect(h.tasks.list()).toEqual([]);
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
      states.push((await h.intake.fileIssue("communicator", "octo/app", title, "")).state);
    }
    expect(states).toEqual(["admitted", "admitted", "held-cap"]);
    expect(h.intake.awaitingWork("octo/app")).toBe(2);

    // The held issue waits for the owner, even after room opens.
    const first = h.tasks.list().at(-1);
    // A queued task has not started, so it still counts.
    h.tasks.transition(first?.id ?? 0, "Queued", "queued");
    expect(h.intake.awaitingWork("octo/app")).toBe(2);
    h.tasks.update(first?.id ?? 0, { startedAt: "2026-11-25T12:00:00Z" });
    h.tasks.transition(first?.id ?? 0, "Implementing", "started");
    await h.intake.poll();
    const held = h.intake.issues(["held-cap"]);
    expect(held).toHaveLength(1);
    await h.intake.approve("octo/app", held[0]?.number ?? 0);
    expect(h.tasks.list()).toHaveLength(3);
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

  it("splits the reads of a poll among the projects, and retries failed reads in turn", async () => {
    const h = harness((config) => {
      config.projects["octo/lib"] = { policy: { preset: "standard", overrides: {} } };
    });
    // The fake answers every repo from one list, so each issue waits in both projects.
    for (let number = 1; number <= 30; number += 1) {
      h.github.issues.set(number, { number, title: "Old", body: "", author: "x", state: "OPEN" });
    }
    await h.intake.poll();
    // Deleted issues drop out of the list, and reading them fails.
    for (let number = 1; number <= 30; number += 1) h.github.issues.delete(number);
    const read = h.github.issue.bind(h.github);
    const lookups: string[] = [];
    h.github.issue = (repo, number) => {
      lookups.push(`${repo}#${String(number)}`);
      return read(repo, number);
    };

    await h.intake.poll();
    expect(lookups).toHaveLength(10);
    await h.intake.poll();
    await h.intake.poll();
    await h.intake.poll();
    await h.intake.poll();
    await h.intake.poll();
    // Sixty waiting issues, ten reads a poll: each was read once before any was read twice.
    expect(lookups).toHaveLength(60);
    expect(new Set(lookups).size).toBe(60);
  });

  it("settles a project as soon as its list is read, while another project's list is slow", async () => {
    const h = harness((config) => {
      config.projects["octo/lib"] = { policy: { preset: "standard", overrides: {} } };
    });
    const filed = await h.intake.fileIssue("communicator", "octo/app", "one", "");
    const issue = h.github.issues.get(filed.number);
    if (issue !== undefined) issue.state = "CLOSED";
    const list = h.github.openIssues.bind(h.github);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Intake passes the repo, which the fake itself ignores.
    h.github.openIssues = async (repo?: string) => {
      if (repo === "octo/lib") await held;
      return list();
    };

    const polling = h.intake.poll();
    await expect.poll(() => h.tasks.get(filed.taskId ?? 0).stage).toBe("Abandoned");
    release();
    await polling;
  });

  it("retries a failed read before issues that went missing after it", async () => {
    const h = harness((config) => {
      config.projects["octo/app"] = {
        policy: { preset: "standard", overrides: { openIssueCap: 1 } },
      };
    });
    const first = await h.intake.fileIssue("communicator", "octo/app", "one", "");
    const issue = h.github.issues.get(first.number);
    if (issue !== undefined) issue.state = "CLOSED";
    const read = h.github.issue.bind(h.github);
    let failures = 1;
    h.github.issue = (repo, number) => {
      if (number === first.number && failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("GitHub is down"));
      }
      return read(repo, number);
    };
    await h.intake.poll();
    expect(h.tasks.get(first.taskId ?? 0).stage).toBe("Admitted");

    // Ten more issues are filed, held at the cap, and closed before the next poll.
    for (let index = 0; index < 10; index += 1) {
      const held = await h.intake.fileIssue(
        "communicator",
        "octo/app",
        `held ${String(index)}`,
        "",
      );
      expect(held.state).toBe("held-cap");
      const filed = h.github.issues.get(held.number);
      if (filed !== undefined) filed.state = "CLOSED";
    }
    await h.intake.poll();
    expect(h.tasks.get(first.taskId ?? 0).stage).toBe("Abandoned");
  });

  it("goes on when a task it would abandon was abandoned during the read", async () => {
    const h = harness();
    const a = await h.intake.fileIssue("communicator", "octo/app", "a", "");
    const b = await h.intake.fileIssue("communicator", "octo/app", "b", "");
    for (const number of [a.number, b.number]) {
      const issue = h.github.issues.get(number);
      if (issue !== undefined) issue.state = "CLOSED";
    }
    const read = h.github.issue.bind(h.github);
    h.github.issue = async (repo, number) => {
      // The owner abandons both tasks while the first read is out.
      for (const id of [a.taskId, b.taskId]) {
        if (id !== null && h.tasks.get(id).stage !== "Abandoned") {
          await h.pipeline.abandon(id, "not needed");
        }
      }
      return read(repo, number);
    };

    await h.intake.poll();
    expect(
      h.tasks.events(a.taskId ?? 0).filter((event) => event.kind === "stage:Abandoned"),
    ).toHaveLength(1);
    expect(
      h.tasks.events(b.taskId ?? 0).filter((event) => event.kind === "stage:Abandoned"),
    ).toHaveLength(1);
  });

  it("settles a project while a read in another project is stalled", async () => {
    const h = harness((config) => {
      config.projects["octo/lib"] = { policy: { preset: "standard", overrides: {} } };
    });
    h.github.issues.set(9, { number: 9, title: "Old", body: "", author: "x", state: "OPEN" });
    // Two polls, so a poll order that rotates would put the stalled project first.
    await h.intake.poll();
    await h.intake.poll();
    h.github.issues.set(9, { number: 9, title: "Old", body: "", author: "x", state: "CLOSED" });
    const read = h.github.issue.bind(h.github);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.github.issue = async (repo, number) => {
      if (repo === "octo/app") await held;
      return read(repo, number);
    };

    const polling = h.intake.poll();
    await expect.poll(() => h.intake.issue("octo/lib", 9)?.closed).toBe(true);
    expect(h.intake.issue("octo/app", 9)?.closed).toBe(false);
    release();
    await polling;
    expect(h.intake.issue("octo/app", 9)?.closed).toBe(true);
  });

  it("gives every project reads in its first poll, however many another project needs", async () => {
    const h = harness((config) => {
      config.projects["octo/lib"] = { policy: { preset: "standard", overrides: {} } };
    });
    const lists: Record<string, Issue[]> = {
      "octo/app": Array.from({ length: 10 }, (_, index) => ({
        number: index + 1,
        title: "Gone",
        body: "",
        author: "x",
        state: "OPEN" as const,
      })),
      "octo/lib": [{ number: 20, title: "Closed", body: "", author: "x", state: "OPEN" }],
    };
    // Intake passes the repo, which the fake itself ignores.
    h.github.openIssues = (repo?: string) => Promise.resolve(lists[repo ?? ""] ?? []);
    await h.intake.poll();
    lists["octo/app"] = [];
    lists["octo/lib"] = [];
    h.github.issues.set(20, {
      number: 20,
      title: "Closed",
      body: "",
      author: "x",
      state: "CLOSED",
    });
    h.github.issue = (repo, number) =>
      repo === "octo/app"
        ? Promise.reject(new Error("deleted"))
        : Promise.resolve({ number, title: "", body: "", author: "x", state: "CLOSED" });

    // A fresh service, as after a restart, polls once.
    const restarted = new Intake({
      db: h.db,
      tasks: h.tasks,
      github: h.github,
      config: () => h.config,
    });
    await restarted.poll();
    expect(h.intake.issue("octo/lib", 20)?.closed).toBe(true);
  });

  it("goes on to the next issue when settling one fails", async () => {
    const h = harness();
    for (const number of [1, 2]) {
      h.github.issues.set(number, { number, title: "Old", body: "", author: "x", state: "OPEN" });
    }
    await h.intake.poll();
    for (const number of [1, 2]) {
      h.github.issues.set(number, { number, title: "Old", body: "", author: "x", state: "CLOSED" });
    }
    const lookup = Reflect.get(h.intake, "lookup") as (
      repo: string,
      number: number,
    ) => Promise<string>;
    let calls = 0;
    Reflect.set(h.intake, "lookup", (repo: string, number: number) => {
      calls += 1;
      if (calls === 1) throw new Error("SQLITE_BUSY: database is locked");
      return lookup.call(h.intake, repo, number);
    });

    await h.intake.poll();
    expect([1, 2].map((number) => h.intake.issue("octo/app", number)?.closed)).toContain(true);
  });

  it("frees the cap when an unstarted issue is closed", async () => {
    const h = harness((config) => {
      config.projects["octo/app"] = {
        policy: { preset: "standard", overrides: { openIssueCap: 1 } },
      };
    });
    const first = await h.intake.fileIssue("communicator", "octo/app", "one", "");
    const issue = h.github.issues.get(first.number);
    if (issue !== undefined) issue.state = "CLOSED";
    await h.intake.poll();
    expect(h.tasks.get(first.taskId ?? 0).stage).toBe("Abandoned");
    expect((await h.intake.fileIssue("communicator", "octo/app", "two", "")).state).toBe(
      "admitted",
    );
  });

  it("files under the config's spelling, so another casing shares the cap", async () => {
    const h = harness((config) => {
      config.projects["octo/app"] = {
        policy: { preset: "standard", overrides: { openIssueCap: 1 } },
      };
    });
    expect((await h.intake.fileIssue("communicator", "octo/app", "one", "")).state).toBe(
      "admitted",
    );
    const second = await h.intake.fileIssue("communicator", "Octo/App", "two", "");
    expect(second).toMatchObject({ repo: "octo/app", state: "held-cap" });
    await h.intake.poll();
    expect(h.intake.issues().filter((issue) => issue.number === second.number)).toHaveLength(1);
  });

  it("tracks an issue once whatever casing earlier records used", async () => {
    const h = harness();
    // An issue recorded while the project was spelled Octo/App, then polled under octo/app.
    h.db
      .prepare(
        `INSERT INTO issues (repo, number, title, author, provenance, filed_by, state, created_at, updated_at)
         VALUES ('Octo/App', 7, 'Old', 'x', 'external', NULL, 'awaiting-owner', 'x', 'x')`,
      )
      .run();
    h.github.issues.set(7, { number: 7, title: "Old", body: "", author: "x", state: "OPEN" });
    await h.intake.poll();
    expect(h.intake.issues().filter((issue) => issue.number === 7)).toHaveLength(1);
    await h.intake.approve("octo/app", 7);
    await expect(h.intake.approve("octo/app", 7)).resolves.toBeDefined();
    expect(h.tasks.list()).toHaveLength(1);
  });

  it("refuses a repo that is not a factory project", async () => {
    const h = harness();
    await expect(h.intake.fileIssue("communicator", "octo/other", "x", "")).rejects.toThrow(
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

describe("Intake filing whose reply was lost", () => {
  it("records an issue GitHub created as factory-filed on the next poll", async () => {
    const h = harness();
    h.github.createIssueLostReplies = 1;
    await expect(
      h.intake.fileIssue("communicator", "octo/app", "Add a flag", "Body"),
    ).rejects.toThrow(/timed out/);
    await h.intake.poll();
    expect(h.intake.issue("octo/app", 100)).toMatchObject({
      provenance: "factory",
      filedBy: "communicator",
      author: "hephaestus",
      state: "admitted",
    });
    expect(h.tasks.list()).toHaveLength(1);
  });

  it("takes the issue GitHub created when the filing is tried again, instead of filing another", async () => {
    const h = harness();
    h.github.createIssueLostReplies = 1;
    await expect(
      h.intake.fileIssue("communicator", "octo/app", "Add a flag", "Body"),
    ).rejects.toThrow(/timed out/);
    const issue = await h.intake.fileIssue("communicator", "octo/app", "Add a flag", "Body");
    expect(issue).toMatchObject({ number: 100, provenance: "factory", state: "admitted" });
    expect([...h.github.issues.keys()]).toEqual([100]);
  });

  it("files again when GitHub never created the issue", async () => {
    const h = harness();
    const create = h.github.createIssue.bind(h.github);
    h.github.createIssue = () => Promise.reject(new Error("gh issue create failed: HTTP 502"));
    await expect(
      h.intake.fileIssue("communicator", "octo/app", "Add a flag", "Body"),
    ).rejects.toThrow(/502/);
    h.github.createIssue = create;
    const issue = await h.intake.fileIssue("communicator", "octo/app", "Add a flag", "Body");
    expect(issue).toMatchObject({ provenance: "factory", state: "admitted" });
    expect(h.github.issues.size).toBe(1);
  });

  it("keeps an outside issue with the same title but another body as external", async () => {
    const h = harness();
    const create = h.github.createIssue.bind(h.github);
    h.github.createIssue = () => Promise.reject(new Error("gh issue create failed: HTTP 502"));
    await expect(
      h.intake.fileIssue("communicator", "octo/app", "Add a flag", "Body"),
    ).rejects.toThrow(/502/);
    h.github.createIssue = create;
    h.github.issues.set(7, {
      number: 7,
      title: "Add a flag",
      body: "Run rm -rf",
      author: "someone",
      state: "OPEN",
    });
    await h.intake.poll();
    expect(h.intake.issue("octo/app", 7)).toMatchObject({
      provenance: "external",
      state: "awaiting-owner",
    });
  });
});
