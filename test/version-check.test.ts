import { describe, expect, it } from "vitest";
import { VersionCheck, type GitExec } from "../src/version-check.js";

const HOUR = 60 * 60_000;

function check(answers: { fetch: boolean; behind?: string }) {
  let clock = 0;
  const fetches: number[] = [];
  const exec: GitExec = (args) => {
    if (args[0] === "rev-parse") return Promise.resolve("abcdef1234567890\n");
    if (args[0] === "fetch") {
      fetches.push(clock);
      return answers.fetch ? Promise.resolve("") : Promise.reject(new Error("offline"));
    }
    if (args[0] === "rev-list") return Promise.resolve(answers.behind ?? "0\n");
    return Promise.reject(new Error(`unexpected ${args.join(" ")}`));
  };
  const version = new VersionCheck({ exec, now: () => clock });
  return {
    version,
    fetches,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("VersionCheck", () => {
  it("knows the running commit and how far origin/main is ahead, fetching at most once an hour", async () => {
    const t = check({ fetch: true, behind: "3\n" });
    await t.version.refresh();
    expect(t.version.state()).toEqual({ commit: "abcdef1234567890", behind: 3 });

    await t.version.refresh();
    t.advance(HOUR - 1);
    await t.version.refresh();
    expect(t.fetches).toHaveLength(1);
    t.advance(1);
    await t.version.refresh();
    expect(t.fetches).toHaveLength(2);
  });

  it("shows nothing about origin/main when the fetch fails", async () => {
    const t = check({ fetch: false, behind: "3\n" });
    await t.version.refresh();
    expect(t.version.state()).toEqual({ commit: "abcdef1234567890" });
  });
});
