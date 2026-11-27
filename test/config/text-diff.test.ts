import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../../src/config/text-diff.js";

describe("unifiedDiff", () => {
  it("is empty when nothing changed", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", "x")).toBe("");
  });

  it("shows a changed line with its context and line numbers", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n");
    const after = before.replace("5", "five");
    expect(unifiedDiff(before, after, "f")).toBe(
      [
        "--- before/f",
        "+++ after/f",
        "@@ -2,7 +2,7 @@",
        " 2",
        " 3",
        " 4",
        "-5",
        "+five",
        " 6",
        " 7",
        " 8",
      ].join("\n"),
    );
  });

  it("keeps far-apart changes in separate hunks", () => {
    const before = Array.from({ length: 30 }, (_, i) => String(i)).join("\n");
    const after = before.replace("\n2\n", "\ntwo\n").replace("\n27\n", "\ntwenty-seven\n");
    const diff = unifiedDiff(before, after, "f");
    expect(diff.match(/^@@/gm)).toHaveLength(2);
    expect(diff).toContain("-2\n+two");
    expect(diff).toContain("-27\n+twenty-seven");
  });

  it("shows a new file as all additions", () => {
    expect(unifiedDiff(undefined, "a\nb", "n")).toBe(
      ["--- /dev/null", "+++ after/n", "@@ -0,0 +1,2 @@", "+a", "+b"].join("\n"),
    );
  });

  it("shows a removed file as all deletions", () => {
    expect(unifiedDiff("a", undefined, "n")).toBe(
      ["--- before/n", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-a"].join("\n"),
    );
  });

  it("shows an insertion without touching the lines around it", () => {
    expect(unifiedDiff("a\nc", "a\nb\nc", "f")).toContain(" a\n+b\n c");
  });
});
