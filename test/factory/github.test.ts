import { describe, expect, it } from "vitest";
import {
  AlreadyMergedError,
  GitHub,
  INTAKE_READ_TIMEOUT_MS,
  foldChecks,
} from "../../src/factory/github.js";
import type { CommandRun } from "../../src/workers/config-repo.js";

describe("foldChecks", () => {
  it("combines check runs and commit statuses", () => {
    expect(foldChecks([])).toEqual({ state: "none", failed: [], names: [], finished: [] });
    expect(
      foldChecks([
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
      ]),
    ).toMatchObject({ state: "success", failed: [], finished: ["check:test", "check:lint"] });
    expect(
      foldChecks([
        { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null },
        { __typename: "StatusContext", context: "ci", state: "SUCCESS" },
      ]).state,
    ).toBe("pending");
    expect(
      foldChecks([
        { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null },
        { __typename: "StatusContext", context: "deploy", state: "FAILURE" },
        { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "TIMED_OUT" },
      ]),
    ).toMatchObject({ state: "failure", failed: ["status:deploy", "check:build"] });
  });
});

describe("GitHub", () => {
  it("merges only at the expected head and returns the merge commit from the merge call", async () => {
    const calls: string[][] = [];
    const exec: CommandRun = (_file, args) => {
      calls.push(args);
      return Promise.resolve(JSON.stringify({ merged: true, sha: "m" }));
    };
    expect(
      await new GitHub("gh", exec).merge("octo/app", 5, "h", "Merged by Hephaestus for card 1."),
    ).toBe("m");
    expect(calls[0]).toEqual([
      "api",
      "-X",
      "PUT",
      "repos/octo/app/pulls/5/merge",
      "-f",
      "merge_method=squash",
      "-f",
      "sha=h",
      "-f",
      "commit_message=Merged by Hephaestus for card 1.",
    ]);
  });

  it("recognizes its own merge by the marker when GitHub's reply was lost", async () => {
    const exec: CommandRun = (_file, args) => {
      if (args[1] === "-X") return Promise.reject(new Error("connection reset"));
      if (args[0] === "pr") {
        return Promise.resolve(
          JSON.stringify({
            number: 5,
            url: "u",
            state: "MERGED",
            headRefOid: "h",
            headRefName: "b",
            baseRefName: "main",
            isCrossRepository: false,
            mergeCommit: { oid: "ours" },
          }),
        );
      }
      if (args[1] === "repos/octo/app/commits/ours") {
        return Promise.resolve("Fix it (#5)\n\nMerged by Hephaestus for card 1.\n");
      }
      return Promise.resolve("");
    };
    expect(
      await new GitHub("gh", exec).merge("octo/app", 5, "h", "Merged by Hephaestus for card 1."),
    ).toBe("ours");
  });

  it("reports a PR someone else merged instead of taking the merge as its own", async () => {
    const exec: CommandRun = (_file, args) => {
      if (args[0] === "api" && args[1] === "-X")
        return Promise.reject(new Error("405 not mergeable"));
      if (args[0] === "pr") {
        return Promise.resolve(
          JSON.stringify({
            number: 5,
            url: "u",
            state: "MERGED",
            headRefOid: "h",
            headRefName: "b",
            baseRefName: "main",
            isCrossRepository: false,
            mergeCommit: { oid: "theirs" },
          }),
        );
      }
      return Promise.resolve("");
    };
    await expect(
      new GitHub("gh", exec).merge("octo/app", 5, "h", "Merged by Hephaestus for card 1."),
    ).rejects.toThrow(AlreadyMergedError);
  });

  it("reads the issue number from gh issue create", async () => {
    const exec: CommandRun = () => Promise.resolve("https://github.com/octo/app/issues/42\n");
    expect(await new GitHub("gh", exec).createIssue("octo/app", "t", "b")).toBe(42);
  });

  it("times out the intake reads, and never a write whose outcome a timeout would hide", async () => {
    const timeouts: (number | undefined)[] = [];
    const exec: CommandRun = (_file, args, _cwd, timeoutMs) => {
      timeouts.push(timeoutMs);
      if (args[1] === "view") {
        return Promise.resolve('{"number":7,"title":"t","body":"","author":null,"state":"OPEN"}');
      }
      if (args[1] === "create") return Promise.resolve("https://github.com/octo/app/issues/42\n");
      return Promise.resolve("[]");
    };
    const github = new GitHub("gh", exec);
    await github.openIssues("octo/app");
    await github.issue("octo/app", 7, INTAKE_READ_TIMEOUT_MS);
    await github.issue("octo/app", 7);
    await github.createIssue("octo/app", "t", "b");
    expect(timeouts).toEqual([
      INTAKE_READ_TIMEOUT_MS,
      INTAKE_READ_TIMEOUT_MS,
      undefined,
      undefined,
    ]);
  });
});
