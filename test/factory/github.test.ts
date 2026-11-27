import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AlreadyMergedError,
  MergeConflictError,
  MergeRefusedError,
  GitHub,
  GH_TIMEOUT_MS,
  INTAKE_READ_TIMEOUT_MS,
  foldChecks,
} from "../../src/factory/github.js";
import { blobSha } from "../../src/factory/attachments.js";
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

/**
 * A repo's attachments branch as GitHub's contents API shows it: every commit
 * is a snapshot of the files, and a path's history is the commits that
 * changed it.
 */
class FakeBranch {
  commits: { sha: string; files: Map<string, Buffer> }[] = [{ sha: "base", files: new Map() }];
  puts: { path: string; body: Record<string, string> }[] = [];
  branchExists = true;
  refs: string[][] = [];

  get head(): Map<string, Buffer> {
    return this.commits[this.commits.length - 1]?.files ?? new Map();
  }

  commit(change: (files: Map<string, Buffer>) => void): string {
    const files = new Map(this.head);
    change(files);
    const sha = `commit${String(this.commits.length)}`;
    this.commits.push({ sha, files });
    return sha;
  }

  exec: CommandRun = (_file, args, _cwd, _timeout, input) => {
    const joined = args.join(" ");
    const api = args[0] === "api" ? args.filter((arg) => arg.startsWith("repos/")) : [];
    const url = api[0] ?? "";
    if (args[0] === "repo") return Promise.resolve('{"defaultBranchRef":{"name":"main"}}');
    if (url.includes("git/ref/heads/hephaestus/attachments")) {
      return this.branchExists
        ? Promise.resolve("{}")
        : Promise.reject(new Error("gh failed: Not Found (HTTP 404)"));
    }
    if (url.includes("git/ref/heads/main")) return Promise.resolve("base\n");
    if (url.endsWith("/git/refs")) {
      this.refs.push(args);
      this.branchExists = true;
      return Promise.resolve("");
    }
    const contents = /\/contents\/([^?]+)(?:\?ref=(.+))?$/.exec(url);
    if (contents !== null && !joined.includes("PUT")) {
      const ref = contents[2] ?? "";
      const snapshot =
        ref === "hephaestus/attachments"
          ? this.head
          : this.commits.find((commit) => commit.sha === ref)?.files;
      const data = snapshot?.get(contents[1] ?? "");
      return data === undefined
        ? Promise.reject(new Error("gh failed: Not Found (HTTP 404)"))
        : Promise.resolve(`${blobSha(data)}\n`);
    }
    if (url.includes("/commits?")) {
      const path = /[?&]path=([^&]+)/.exec(url)?.[1] ?? "";
      // The newest commit that changed the path, a deletion included.
      for (let i = this.commits.length - 1; i > 0; i--) {
        const before = this.commits[i - 1]?.files.get(path);
        const after = this.commits[i]?.files.get(path);
        const same =
          before === undefined || after === undefined ? before === after : before.equals(after);
        if (!same) {
          return Promise.resolve(`${this.commits[i]?.sha ?? ""}\n`);
        }
      }
      return Promise.resolve("\n");
    }
    if (joined.includes("PUT") && contents !== null) {
      const body = JSON.parse(input ?? "{}") as Record<string, string>;
      const path = contents[1] ?? "";
      this.puts.push({ path, body });
      const present = this.head.get(path);
      // GitHub replaces a file only when told the id of the one it replaces.
      if (present !== undefined && body.sha !== blobSha(present)) {
        return Promise.reject(new Error("gh failed: path already exists (HTTP 422)"));
      }
      return Promise.resolve(
        `${this.commit((files) => files.set(path, Buffer.from(body.content ?? "", "base64")))}\n`,
      );
    }
    return Promise.reject(new Error(`unexpected call: ${joined}`));
  };
}

describe("GitHub attachments through the real command runner", () => {
  it("delivers the exact upload payload to the gh process on stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hephaestus-gh-"));
    try {
      // A stand-in for gh that answers the calls storeAttachments makes and keeps what it was sent to write.
      const gh = join(dir, "gh");
      writeFileSync(
        gh,
        `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("PUT")) {
  fs.writeFileSync(${JSON.stringify(join(dir, "received.json"))}, fs.readFileSync(0));
  console.log("commit1");
} else if (args.some((arg) => arg.includes("/contents/"))) {
  console.error("gh: Not Found (HTTP 404)");
  process.exit(1);
} else {
  console.log("{}");
}
`,
        { mode: 0o755 },
      );
      const bytes = Buffer.alloc(2 * 1024 * 1024);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 3) % 256;
      const file = {
        name: "b.png",
        path: "attachments/0123456789abcdef/b.png",
        data: bytes,
        sha256: "x",
      };
      expect(await new GitHub(gh).storeAttachments("octo/app", [file])).toEqual(["commit1"]);
      const received = readFileSync(join(dir, "received.json"));
      expect(received.toString()).toBe(
        JSON.stringify({
          message: "Attach b.png",
          content: bytes.toString("base64"),
          branch: "hephaestus/attachments",
        }),
      );
      const sent = JSON.parse(received.toString()) as { content: string };
      expect(Buffer.from(sent.content, "base64").equals(bytes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GitHub attachments", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
  const file = {
    name: "b.png",
    path: "attachments/0123456789abcdef/b.png",
    data: png,
    sha256: "x",
  };
  const store = (branch: FakeBranch): Promise<string[]> =>
    new GitHub("gh", branch.exec).storeAttachments("octo/app", [file]);

  it("creates the branch from the default branch and commits the exact bytes through stdin", async () => {
    const branch = new FakeBranch();
    branch.branchExists = false;
    const [commit] = await store(branch);
    expect(branch.refs[0]).toEqual(
      expect.arrayContaining(["ref=refs/heads/hephaestus/attachments", "sha=base"]),
    );
    expect(branch.head.get(file.path)?.equals(png)).toBe(true);
    expect(commit).toBe("commit1");
    const sent = branch.puts[0]?.body ?? {};
    expect(sent.branch).toBe("hephaestus/attachments");
    expect(sent.sha).toBeUndefined();
  });

  it("keeps the bytes off the command line", async () => {
    const seen: string[][] = [];
    const branch = new FakeBranch();
    await new GitHub("gh", (...call) => {
      seen.push(call[1]);
      return branch.exec(...call);
    }).storeAttachments("octo/app", [file]);
    const put = seen.find((args) => args.includes("PUT"));
    expect(put?.join(" ")).not.toContain(png.toString("base64"));
    expect(put).toEqual(expect.arrayContaining(["--input", "-"]));
  });

  it("reuses a file that is on the branch with those bytes, at the commit that holds it", async () => {
    const branch = new FakeBranch();
    const first = branch.commit((files) => files.set(file.path, png));
    branch.commit((files) => files.set("attachments/other/x.txt", Buffer.from("x")));
    expect(await store(branch)).toEqual([first]);
    expect(branch.puts).toEqual([]);
  });

  it("commits again a file that was deleted from the branch", async () => {
    const branch = new FakeBranch();
    branch.commit((files) => files.set(file.path, png));
    const deleted = branch.commit((files) => files.delete(file.path));
    // The newest commit that touched the path is the deletion; linking it would link nothing.
    const [commit] = await store(branch);
    expect(commit).not.toBe(deleted);
    expect(branch.puts).toHaveLength(1);
    expect(
      branch.commits
        .find((c) => c.sha === commit)
        ?.files.get(file.path)
        ?.equals(png),
    ).toBe(true);
  });

  it("commits again a file that was replaced by other bytes, naming the one it replaces", async () => {
    const branch = new FakeBranch();
    branch.commit((files) => files.set(file.path, png));
    const other = Buffer.from("something else");
    branch.commit((files) => files.set(file.path, other));
    const [commit] = await store(branch);
    expect(branch.puts[0]?.body.sha).toBe(blobSha(other));
    expect(
      branch.commits
        .find((c) => c.sha === commit)
        ?.files.get(file.path)
        ?.equals(png),
    ).toBe(true);
    expect(branch.head.get(file.path)?.equals(png)).toBe(true);
  });

  it("does not take another failure for a missing branch or a missing file", async () => {
    const exec: CommandRun = () =>
      Promise.reject(new Error("gh failed: Bad credentials (HTTP 401)"));
    await expect(new GitHub("gh", exec).storeAttachments("octo/app", [file])).rejects.toThrow(
      "Bad credentials",
    );
    const down: CommandRun = (...call) =>
      call[1].join(" ").includes("contents")
        ? Promise.reject(new Error("gh failed: Server Error (HTTP 500)"))
        : new FakeBranch().exec(...call);
    await expect(new GitHub("gh", down).storeAttachments("octo/app", [file])).rejects.toThrow(
      "Server Error",
    );
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
      await new GitHub("gh", exec).merge("octo/app", 5, "h", "Merged by Hephaestus for task 1."),
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
      "commit_message=Merged by Hephaestus for task 1.",
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
        return Promise.resolve("Fix it (#5)\n\nMerged by Hephaestus for task 1.\n");
      }
      if (args[1] === "repos/octo/app/pulls/5") return Promise.resolve("owner\n");
      if (args[1] === "user") return Promise.resolve("owner\n");
      return Promise.resolve("");
    };
    expect(
      await new GitHub("gh", exec).merge("octo/app", 5, "h", "Merged by Hephaestus for task 1."),
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
      new GitHub("gh", exec).merge("octo/app", 5, "h", "Merged by Hephaestus for task 1."),
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
      new GitHub("gh", run).merge("octo/app", 5, "h", "Merged by Hephaestus for task 1.");
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

  it("times out the intake reads, and bounds every other call, writes included", async () => {
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
    await github.reopenIssue("octo/app", 7, "again");
    expect(timeouts).toEqual([
      INTAKE_READ_TIMEOUT_MS,
      INTAKE_READ_TIMEOUT_MS,
      GH_TIMEOUT_MS,
      GH_TIMEOUT_MS,
      GH_TIMEOUT_MS,
    ]);
  });

  it("bounds the merge, the revert, and the comment calls", async () => {
    const timeouts: (number | undefined)[] = [];
    const exec: CommandRun = (_file, args, _cwd, timeoutMs) => {
      timeouts.push(timeoutMs);
      if (args.includes("PUT")) return Promise.resolve('{"merged":true,"sha":"m"}');
      if (args[0] === "pr" && args[1] === "list") return Promise.resolve("[]");
      if (args[0] === "pr") return Promise.resolve('{"id":"PR_1"}');
      if (args[1] === "graphql") {
        return Promise.resolve('{"data":{"revertPullRequest":{"revertPullRequest":{"number":9}}}}');
      }
      if (args.includes("POST")) return Promise.resolve("https://github.com/octo/app/issues/7#c\n");
      return Promise.resolve('{"number":7}');
    };
    const github = new GitHub("gh", exec);
    await github.merge("octo/app", 5, "h", "m");
    await github.revertPullRequest("octo/app", 5);
    await github.commentOnIssue("octo/app", 7, "hi");
    expect(timeouts.every((t) => t !== undefined && t > 0)).toBe(true);
  });
});

describe("GitHub.commentOnIssue", () => {
  /** A gh that answers the issue read with `issue`, or a 404, and records every call. */
  function fake(issue: object | undefined): {
    exec: CommandRun;
    calls: string[][];
    inputs: string[];
  } {
    const calls: string[][] = [];
    const inputs: string[] = [];
    const exec: CommandRun = (_file, args, _cwd, _timeout, input) => {
      calls.push(args);
      if (args.includes("POST")) {
        inputs.push(input ?? "");
        return Promise.resolve("https://github.com/octo/app/issues/7#issuecomment-1\n");
      }
      return issue === undefined
        ? Promise.reject(new Error("gh api failed: gh: Not Found (HTTP 404)"))
        : Promise.resolve(JSON.stringify(issue));
    };
    return { exec, calls, inputs };
  }

  it("posts the body on stdin and returns the comment's URL", async () => {
    const gh = fake({ number: 7 });
    const url = await new GitHub("gh", gh.exec).commentOnIssue("octo/app", 7, "Hello $(rm -rf /)");
    expect(url).toBe("https://github.com/octo/app/issues/7#issuecomment-1");
    expect(gh.inputs).toEqual([JSON.stringify({ body: "Hello $(rm -rf /)" })]);
    expect(gh.calls.flat().join(" ")).not.toContain("Hello");
  });

  it("posts nothing for an issue that does not exist", async () => {
    const gh = fake(undefined);
    await expect(new GitHub("gh", gh.exec).commentOnIssue("octo/app", 9, "Hi")).rejects.toThrow(
      "octo/app#9 does not exist",
    );
    expect(gh.inputs).toEqual([]);
  });

  it("posts nothing for a pull request's number", async () => {
    const gh = fake({ number: 7, pull_request: { url: "x" } });
    await expect(new GitHub("gh", gh.exec).commentOnIssue("octo/app", 7, "Hi")).rejects.toThrow(
      "is a pull request",
    );
    expect(gh.inputs).toEqual([]);
  });
});

/** A PR view as `gh pr view --json` answers it. */
function prView(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 5,
    url: "u",
    state: "MERGED",
    headRefOid: "h",
    headRefName: "b",
    baseRefName: "main",
    isCrossRepository: false,
    mergeCommit: { oid: "m" },
    ...fields,
  });
}

describe("GitHub merges it did not make", () => {
  /** A gh whose merge reply is lost after the PR merged as `mergeCommit`, by `mergedBy`. */
  function merged(mergedBy: string, fields: Record<string, unknown> = {}): CommandRun {
    return (_file, args) => {
      if (args.includes("PUT")) return Promise.reject(new Error("gh: connection reset"));
      if (args[0] === "pr") return Promise.resolve(prView(fields));
      if (args[1] === "repos/octo/app/commits/m") {
        return Promise.resolve("Fix it (#5)\n\nMerged by Hephaestus for task 1.\n");
      }
      if (args[1] === "repos/octo/app/pulls/5") return Promise.resolve(`${mergedBy}\n`);
      if (args[1] === "user") return Promise.resolve("owner\n");
      return Promise.resolve("");
    };
  }

  it("takes a merge with its marker as someone else's when another account merged it", async () => {
    const github = new GitHub("gh", merged("stranger"));
    await expect(
      github.merge("octo/app", 5, "h", "Merged by Hephaestus for task 1."),
    ).rejects.toThrow(AlreadyMergedError);
    expect(await github.mergedWith("octo/app", "m", "Merged by Hephaestus for task 1.", 5)).toBe(
      false,
    );
  });

  it("takes a merge with its marker as its own when the gh account merged it", async () => {
    const github = new GitHub("gh", merged("owner"));
    expect(await github.mergedWith("octo/app", "m", "Merged by Hephaestus for task 1.", 5)).toBe(
      true,
    );
  });

  it("names the head that merged when someone else merged a newer one", async () => {
    const github = new GitHub("gh", merged("stranger", { headRefOid: "newer" }));
    const error = await github
      .merge("octo/app", 5, "h", "Merged by Hephaestus for task 1.")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AlreadyMergedError);
    expect(error).toMatchObject({ mergeSha: "m", headSha: "newer" });
  });
});

describe("GitHub revert PRs", () => {
  /** GitHub's open PRs, and a revert mutation that opens one and may lose its reply. */
  function fake(loseReply: boolean): { exec: CommandRun; mutations: number } {
    const open: object[] = [
      { number: 3, headRefName: "feature", body: "Reverts octo/app#5", isCrossRepository: false },
      {
        number: 4,
        headRefName: "revert-5-factory/x",
        body: "Reverts octo/app#5",
        isCrossRepository: true,
      },
    ];
    const state = { mutations: 0, exec: undefined as unknown as CommandRun };
    state.exec = (_file, args) => {
      if (args[0] === "pr" && args[1] === "list") return Promise.resolve(JSON.stringify(open));
      if (args[0] === "pr") return Promise.resolve('{"id":"PR_5"}');
      if (args[1] === "graphql") {
        state.mutations += 1;
        open.push({
          number: 12,
          headRefName: "revert-5-factory/x",
          body: "Reverts octo/app#5",
          isCrossRepository: false,
        });
        return loseReply
          ? Promise.reject(new Error("gh api graphql failed: timed out"))
          : Promise.resolve('{"data":{"revertPullRequest":{"revertPullRequest":{"number":12}}}}');
      }
      return Promise.resolve("");
    };
    return state;
  }

  it("opens a revert PR and returns its number", async () => {
    const gh = fake(false);
    expect(await new GitHub("gh", gh.exec).revertPullRequest("octo/app", 5)).toBe(12);
    expect(gh.mutations).toBe(1);
  });

  it("finds the revert PR GitHub opened when the reply was lost, and opens no second one", async () => {
    const gh = fake(true);
    const github = new GitHub("gh", gh.exec);
    expect(await github.revertPullRequest("octo/app", 5)).toBe(12);
    expect(await github.revertPullRequest("octo/app", 5)).toBe(12);
    expect(gh.mutations).toBe(1);
  });
});

describe("GitHub comments whose reply was lost", () => {
  it("says the comment may have been posted", async () => {
    const exec: CommandRun = (_file, args) =>
      args.includes("POST")
        ? Promise.reject(new Error("gh api failed: timed out"))
        : Promise.resolve('{"number":7}');
    await expect(new GitHub("gh", exec).commentOnIssue("octo/app", 7, "Hi")).rejects.toThrow(
      /may have posted/,
    );
  });
});
