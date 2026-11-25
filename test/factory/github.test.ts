import { describe, expect, it } from "vitest";
import { AlreadyMergedError, GitHub, foldChecks } from "../../src/factory/github.js";
import type { CommandRun } from "../../src/workers/config-repo.js";

describe("foldChecks", () => {
  it("combines check runs and commit statuses", () => {
    expect(foldChecks([])).toEqual({ state: "none", failed: [], names: [], finished: [] });
    expect(
      foldChecks([
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
      ]),
    ).toMatchObject({ state: "success", failed: [], finished: ["test", "lint"] });
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
    ).toMatchObject({ state: "failure", failed: ["deploy", "build"] });
  });
});

describe("GitHub", () => {
  it("merges only at the expected head and returns the merge commit from the merge call", async () => {
    const calls: string[][] = [];
    const exec: CommandRun = (_file, args) => {
      calls.push(args);
      return Promise.resolve(JSON.stringify({ merged: true, sha: "m" }));
    };
    expect(await new GitHub("gh", exec).merge("octo/app", 5, "h")).toBe("m");
    expect(calls[0]).toEqual([
      "api",
      "-X",
      "PUT",
      "repos/octo/app/pulls/5/merge",
      "-f",
      "merge_method=squash",
      "-f",
      "sha=h",
    ]);
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
    await expect(new GitHub("gh", exec).merge("octo/app", 5, "h")).rejects.toThrow(
      AlreadyMergedError,
    );
  });

  it("reads the issue number from gh issue create", async () => {
    const exec: CommandRun = () => Promise.resolve("https://github.com/octo/app/issues/42\n");
    expect(await new GitHub("gh", exec).createIssue("octo/app", "t", "b")).toBe(42);
  });
});
