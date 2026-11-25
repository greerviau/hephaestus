import { describe, expect, it } from "vitest";
import { GitHub, foldChecks } from "../../src/factory/github.js";
import type { CommandRun } from "../../src/workers/config-repo.js";

describe("foldChecks", () => {
  it("combines check runs and commit statuses", () => {
    expect(foldChecks([])).toEqual({ state: "none", failed: [] });
    expect(
      foldChecks([
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
      ]),
    ).toEqual({ state: "success", failed: [] });
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
    ).toEqual({ state: "failure", failed: ["deploy", "build"] });
  });
});

describe("GitHub", () => {
  it("merges only at the expected head and returns the merge commit", async () => {
    const calls: string[][] = [];
    const exec: CommandRun = (_file, args) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view") {
        return Promise.resolve(
          JSON.stringify({
            number: 5,
            url: "u",
            state: "MERGED",
            headRefOid: "h",
            headRefName: "b",
            baseRefName: "main",
            mergeCommit: { oid: "m" },
            files: [],
            statusCheckRollup: [],
          }),
        );
      }
      return Promise.resolve("");
    };
    expect(await new GitHub("gh", exec).merge("octo/app", 5, "h")).toBe("m");
    expect(calls[0]).toEqual([
      "pr",
      "merge",
      "5",
      "-R",
      "octo/app",
      "--squash",
      "--match-head-commit",
      "h",
    ]);
  });

  it("reads the issue number from gh issue create", async () => {
    const exec: CommandRun = () => Promise.resolve("https://github.com/octo/app/issues/42\n");
    expect(await new GitHub("gh", exec).createIssue("octo/app", "t", "b")).toBe(42);
  });
});
