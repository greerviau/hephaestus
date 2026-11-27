import { describe, expect, it } from "vitest";
import { VersionCheck, type GitExec } from "../src/version-check.js";

function check(answers: { fetch: boolean; behind?: string }) {
  const fetches: string[] = [];
  const exec: GitExec = (args) => {
    if (args[0] === "rev-parse") return Promise.resolve("abcdef1234567890\n");
    if (args[0] === "fetch") {
      fetches.push(args.join(" "));
      return answers.fetch ? Promise.resolve("") : Promise.reject(new Error("offline"));
    }
    if (args[0] === "rev-list") return Promise.resolve(answers.behind ?? "0\n");
    return Promise.reject(new Error(`unexpected ${args.join(" ")}`));
  };
  return { version: new VersionCheck({ exec }), fetches };
}

describe("VersionCheck", () => {
  it("knows the running commit and fetches origin/main on every check, so a new commit shows within one check", async () => {
    const t = check({ fetch: true, behind: "3\n" });
    await t.version.refresh();
    expect(t.version.state()).toEqual({ commit: "abcdef1234567890", behind: 3 });

    await t.version.refresh();
    expect(t.fetches).toHaveLength(2);
  });

  it("shows nothing about origin/main when the fetch fails", async () => {
    const t = check({ fetch: false, behind: "3\n" });
    await t.version.refresh();
    expect(t.version.state()).toEqual({ commit: "abcdef1234567890" });
  });
});
