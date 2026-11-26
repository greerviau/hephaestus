import { describe, expect, it } from "vitest";
import {
  AlreadyMergedError,
  MergeConflictError,
  MergeRefusedError,
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

  it("names a conflict by the PR's mergeable state, never on a merged or closed PR", async () => {
    const exec =
      (state: string, mergeable: string, mergeCommit: { oid: string } | null): CommandRun =>
      (_file, args) => {
        if (args[0] === "api" && args[1] === "-X") {
          return Promise.reject(new Error("gh: Pull Request is not mergeable (HTTP 405)"));
        }
        if (args[0] === "pr") {
          return Promise.resolve(
            JSON.stringify({
              number: 5,
              url: "u",
              state,
              headRefOid: "h",
              headRefName: "b",
              baseRefName: "main",
              isCrossRepository: false,
              mergeCommit,
              mergeable,
            }),
          );
        }
        if (args[0] === "api" && args.at(-1) === ".commit.message")
          return Promise.resolve("theirs");
        return Promise.resolve("{}");
      };
    const merge = (run: CommandRun): Promise<string> =>
      new GitHub("gh", run).merge("octo/app", 5, "h", "Merged by Hephaestus for card 1.");
    await expect(merge(exec("OPEN", "CONFLICTING", null))).rejects.toThrow(MergeConflictError);
    await expect(merge(exec("MERGED", "CONFLICTING", { oid: "m" }))).rejects.toThrow(
      AlreadyMergedError,
    );
    await expect(merge(exec("CLOSED", "CONFLICTING", null))).rejects.not.toThrow(
      MergeConflictError,
    );
    await expect(merge(exec("OPEN", "MERGEABLE", null))).rejects.not.toThrow(MergeConflictError);
    // A head that moved under the merge is not a conflict to send back.
    await expect(
      new GitHub("gh", exec("OPEN", "CONFLICTING", null)).merge("octo/app", 5, "old", "m"),
    ).rejects.not.toThrow(MergeConflictError);
  });

  it("tells a merge refused for conflicts from other failures", async () => {
    const exec =
      (error: string): CommandRun =>
      (_file, args) => {
        if (args[0] === "api" && args[1] === "-X") return Promise.reject(new Error(error));
        if (args[0] === "pr") {
          return Promise.resolve(
            JSON.stringify({
              number: 5,
              url: "u",
              state: "OPEN",
              headRefOid: "h",
              headRefName: "b",
              baseRefName: "main",
              isCrossRepository: false,
              mergeCommit: null,
            }),
          );
        }
        return Promise.resolve("{}");
      };
    await expect(
      new GitHub("gh", exec("gh: Pull Request has merge conflicts (HTTP 405)")).merge(
        "octo/app",
        5,
        "h",
        "m",
      ),
    ).rejects.toThrow(MergeConflictError);
    await expect(
      new GitHub("gh", exec("gh: Base branch was modified (HTTP 405)")).merge(
        "octo/app",
        5,
        "h",
        "m",
      ),
    ).rejects.not.toThrow(MergeConflictError);
  });

  it("raises a typed refusal for a 405 or 409 that is not a conflict, and nothing for 5xx or network errors", async () => {
    const exec =
      (error: string, headSha = "h"): CommandRun =>
      (_file, args) => {
        if (args[0] === "api" && args[1] === "-X") return Promise.reject(new Error(error));
        if (args[0] === "pr") {
          return Promise.resolve(
            JSON.stringify({
              number: 5,
              url: "u",
              state: "OPEN",
              headRefOid: headSha,
              headRefName: "b",
              baseRefName: "main",
              isCrossRepository: false,
              mergeCommit: null,
              mergeable: "MERGEABLE",
            }),
          );
        }
        return Promise.resolve("{}");
      };
    const merge = (error: string, headSha?: string): Promise<string> =>
      new GitHub("gh", exec(error, headSha)).merge("octo/app", 5, "h", "m");
    const wrapped = (message: string): string =>
      `gh api -X PUT repos/octo/app/pulls/5/merge -f commit_message=m failed: ${message}`;

    const behind = await merge(
      wrapped("gh: Head branch is not up to date with the base branch (HTTP 405)"),
    ).catch((error: unknown) => error);
    expect(behind).toBeInstanceOf(MergeRefusedError);
    expect(behind).toMatchObject({
      number: 5,
      status: 405,
      githubMessage: "Head branch is not up to date with the base branch",
    });

    const review = await merge(wrapped("gh: At least 1 approving review is required (HTTP 409)"))
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(review).toMatchObject({
      status: 409,
      githubMessage: "At least 1 approving review is required",
    });

    // A long, multi-line message is cut down to one short line.
    const long = await merge(wrapped(`gh: ${"Rule failed.\n".repeat(60)}(HTTP 405)`)).catch(
      (error: unknown) => error as MergeRefusedError,
    );
    expect((long as MergeRefusedError).githubMessage).not.toContain("\n");
    expect((long as MergeRefusedError).githubMessage.length).toBeLessThanOrEqual(200);

    // A conflict named in a 405 is still a conflict.
    await expect(merge(wrapped("gh: Pull Request has merge conflicts (HTTP 405)"))).rejects.toThrow(
      MergeConflictError,
    );
    // Server errors and lost replies are not refusals; the step retries them.
    for (const failure of [
      wrapped("gh: Server Error (HTTP 502)"),
      wrapped("gh: Service Unavailable (HTTP 503)"),
      wrapped("gh: Not Found (HTTP 404)"),
      "connection reset",
    ]) {
      await expect(merge(failure)).rejects.not.toThrow(MergeRefusedError);
    }
    // A head that moved under the merge is the gate's to handle.
    await expect(
      merge(wrapped("gh: Base branch was modified (HTTP 405)"), "newer"),
    ).rejects.not.toThrow(MergeRefusedError);
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
