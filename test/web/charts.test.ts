import { describe, expect, it } from "vitest";
import { columns, line } from "../../src/web/charts.js";

/** Each hover target's tip text, in order, as written in the attribute. */
function tips(svg: string): string[] {
  return [...svg.matchAll(/data-tip="([^"]*)"/g)].map((match) => match[1] ?? "");
}

describe("columns", () => {
  it("gives each day a hover target that names the day and every series' count", () => {
    const svg = columns({
      id: "c",
      labels: ["Nov 1", "Nov 2"],
      series: [
        { name: "Merged", values: [2, 0], color: "red" },
        { name: "Reverted", values: [1, 0], color: "blue", hatch: true },
      ],
      aria: "a",
      region: "r",
    });

    expect(tips(svg)).toEqual(["Nov 1\nMerged 2\nReverted 1", "Nov 2\nMerged 0\nReverted 0"]);
    // The target spans the whole band, so an empty day can be hovered too.
    expect(svg.match(/<g class="hit"/g)).toHaveLength(2);
  });

  it("draws no hover targets when there are no days", () => {
    const svg = columns({ id: "c", labels: [], series: [], aria: "a", region: "r" });

    expect(svg).not.toContain("data-tip");
    expect(svg).toContain("<svg");
  });

  it("escapes what it puts in the tip", () => {
    const svg = columns({
      id: "c",
      labels: ['<b>"x"'],
      series: [{ name: "A&B", values: [1], color: "red" }],
      aria: "a",
      region: "r",
    });

    expect(svg).not.toContain("<b>");
    expect(tips(svg)).toEqual(["&lt;b&gt;&quot;x&quot;\nA&amp;B 1"]);
  });
});

describe("line", () => {
  it("gives each day a hover target with the reading formatted, and says when there is none", () => {
    const svg = line({
      labels: ["Nov 1", "Nov 2", "Nov 3"],
      values: [4, null, 1.25],
      color: "red",
      aria: "a",
      name: "Median cycle time",
      format: (value) => `${value.toFixed(1)} h`,
    });

    expect(tips(svg)).toEqual([
      "Nov 1\nMedian cycle time 4.0 h",
      "Nov 2\nMedian cycle time: no reading",
      "Nov 3\nMedian cycle time 1.3 h",
    ]);
    // A day with a reading marks its point while hovered; a day without has no point to mark.
    expect(svg.match(/<circle class="pt"/g)).toHaveLength(2);
  });

  it("prints whole counts without a format", () => {
    const svg = line({
      labels: ["Nov 1", "Nov 2"],
      values: [3, 0],
      color: "red",
      aria: "a",
      name: "PRs",
      integer: true,
    });

    expect(tips(svg)).toEqual(["Nov 1\nPRs 3", "Nov 2\nPRs 0"]);
  });

  it("covers the whole plot with one target for a single day", () => {
    const svg = line({ labels: ["Nov 1"], values: [2], color: "red", aria: "a", name: "PRs" });

    expect(tips(svg)).toEqual(["Nov 1\nPRs 2"]);
    expect(svg).toMatch(/<rect x="32\.0" y="8\.0" width="240\.0" height="92\.0"/);
  });

  it("draws no hover targets when there are no days", () => {
    const svg = line({ labels: [], values: [], color: "red", aria: "a", name: "PRs" });

    expect(svg).not.toContain("data-tip");
  });
});
