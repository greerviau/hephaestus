import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { chartData, type ChartMetric } from "../../src/factory/chart.js";
import { renderBarChart } from "../../src/factory/chart-image.js";
import { TaskStore } from "../../src/factory/tasks.js";
import { openStore } from "../../src/store.js";

const NOW = new Date("2026-11-25T12:00:00Z");

function setup(): {
  db: ReturnType<typeof openStore>;
  tasks: TaskStore;
  at: (iso: string) => void;
  /** A task that reached Done at `doneAt`, with a merge recorded at `mergedAt` unless that is null. */
  finish: (o: {
    repo: string;
    doneAt: string;
    mergedAt: string | null;
    rounds?: number;
    pr: number;
  }) => number;
} {
  let clock = Date.parse("2026-11-20T10:00:00Z");
  const db = openStore(":memory:");
  const tasks = new TaskStore(db, () => new Date(clock));
  const at = (iso: string): number => (clock = Date.parse(iso));
  const finish: ReturnType<typeof setup>["finish"] = (o) => {
    at(o.doneAt);
    const id = tasks.create({ repo: o.repo, issueNumber: o.pr, title: `task ${String(o.pr)}` }).id;
    tasks.update(id, { prNumber: o.pr, rounds: o.rounds ?? 0 });
    tasks.transition(id, "Queued", "the lead queued the work");
    tasks.transition(id, "Implementing", "work started");
    if (o.mergedAt !== null) {
      at(o.mergedAt);
      tasks.recordMerge(o.repo, o.pr, "sha", id, false);
    }
    at(o.doneAt);
    tasks.transition(id, "Done", "merged");
    return id;
  };
  return { db, tasks, at, finish };
}

function chart(
  db: ReturnType<typeof openStore>,
  metric: ChartMetric,
  extra: { window?: string; repo?: string } = {},
) {
  const result = chartData(db, { metric, window: "7d", now: NOW, ...extra });
  if (result.kind !== "chart") throw new Error(`expected a chart, got: ${result.message}`);
  return result;
}

function noData(
  db: ReturnType<typeof openStore>,
  metric: ChartMetric,
  extra: { window?: string; repo?: string } = {},
): string {
  const result = chartData(db, { metric, window: "7d", now: NOW, ...extra });
  if (result.kind !== "no-data") throw new Error("expected no data, got a chart");
  return result.message;
}

describe("chartData merges_per_day", () => {
  it("counts recorded merges by day and says how many Done tasks have no merge time", () => {
    const { db, finish } = setup();
    finish({
      repo: "octo/app",
      pr: 1,
      doneAt: "2026-11-21T10:00:00Z",
      mergedAt: "2026-11-21T09:00:00Z",
    });
    finish({
      repo: "octo/app",
      pr: 2,
      doneAt: "2026-11-21T15:00:00Z",
      mergedAt: "2026-11-21T14:00:00Z",
    });
    finish({
      repo: "octo/app",
      pr: 3,
      doneAt: "2026-11-23T10:00:00Z",
      mergedAt: "2026-11-23T09:00:00Z",
    });
    // Done in the window, but no merge was ever recorded: left out and said so.
    finish({ repo: "octo/app", pr: 4, doneAt: "2026-11-22T10:00:00Z", mergedAt: null });
    finish({ repo: "octo/app", pr: 5, doneAt: "2026-11-24T10:00:00Z", mergedAt: null });
    // Merged before the window.
    finish({
      repo: "octo/app",
      pr: 6,
      doneAt: "2026-10-01T10:00:00Z",
      mergedAt: "2026-10-01T09:00:00Z",
    });

    const result = chart(db, "merges_per_day");
    const byDay = Object.fromEntries(result.bars.map((bar) => [bar.label, bar.value]));
    expect(byDay).toEqual({
      "11-18": 0,
      "11-19": 0,
      "11-20": 0,
      "11-21": 2,
      "11-22": 0,
      "11-23": 1,
      "11-24": 0,
      "11-25": 0,
    });
    expect(result.title).toBe("Merges per day, last 7d");
    expect(result.caption).toContain("3 merges");
    expect(result.caption).toContain(
      "2 Done tasks left out because they have no recorded merge time",
    );
  });

  it("filters by repo", () => {
    const { db, finish } = setup();
    finish({
      repo: "octo/app",
      pr: 1,
      doneAt: "2026-11-21T10:00:00Z",
      mergedAt: "2026-11-21T09:00:00Z",
    });
    finish({
      repo: "octo/lib",
      pr: 2,
      doneAt: "2026-11-21T10:00:00Z",
      mergedAt: "2026-11-21T09:30:00Z",
    });
    finish({ repo: "octo/lib", pr: 3, doneAt: "2026-11-22T10:00:00Z", mergedAt: null });

    const lib = chart(db, "merges_per_day", { repo: "octo/lib" });
    expect(lib.bars.reduce((sum, bar) => sum + bar.value, 0)).toBe(1);
    expect(lib.title).toContain("octo/lib");
    expect(lib.caption).toContain("1 Done task left out");
    const app = chart(db, "merges_per_day", { repo: "octo/app" });
    expect(app.bars.reduce((sum, bar) => sum + bar.value, 0)).toBe(1);
    expect(app.caption).toContain("No Done tasks were left out");
  });

  it("reports no data, not an empty chart, when nothing merged in the window", () => {
    const { db, finish } = setup();
    finish({
      repo: "octo/app",
      pr: 1,
      doneAt: "2026-10-01T10:00:00Z",
      mergedAt: "2026-10-01T09:00:00Z",
    });
    finish({ repo: "octo/app", pr: 2, doneAt: "2026-11-22T10:00:00Z", mergedAt: null });
    const message = noData(db, "merges_per_day");
    expect(message).toContain("No merges are recorded in the last 7d");
    expect(message).toContain("1 Done task has no recorded merge time");
  });
});

describe("chartData tasks_by_stage", () => {
  it("counts the tasks that entered each stage in the window, from recorded stage changes", () => {
    const { db, tasks, at, finish } = setup();
    finish({
      repo: "octo/app",
      pr: 1,
      doneAt: "2026-11-21T10:00:00Z",
      mergedAt: "2026-11-21T09:00:00Z",
    });
    finish({ repo: "octo/app", pr: 2, doneAt: "2026-11-22T10:00:00Z", mergedAt: null });
    at("2026-11-23T10:00:00Z");
    const stuck = tasks.create({ repo: "octo/lib", issueNumber: 9, title: "s" }).id;
    tasks.transition(stuck, "Escalated", "to the owner: needs a decision");
    // Entered its stages before the window: not counted.
    finish({ repo: "octo/app", pr: 3, doneAt: "2026-10-01T10:00:00Z", mergedAt: null });

    const result = chart(db, "tasks_by_stage");
    expect(Object.fromEntries(result.bars.map((bar) => [bar.label, bar.value]))).toEqual({
      Queued: 2,
      Implementing: 2,
      Done: 2,
      Escalated: 1,
    });
    expect(result.caption).toContain("recorded stage changes");

    const lib = chart(db, "tasks_by_stage", { repo: "octo/lib" });
    expect(lib.bars).toEqual([{ label: "Escalated", value: 1 }]);
  });

  it("reports no data when no stage changed in the window", () => {
    const { db, finish } = setup();
    finish({ repo: "octo/app", pr: 1, doneAt: "2026-10-01T10:00:00Z", mergedAt: null });
    expect(noData(db, "tasks_by_stage")).toContain("No task changed stage in the last 7d");
  });
});

describe("chartData review_rounds", () => {
  it("counts the tasks done in the window by their review rounds", () => {
    const { db, finish } = setup();
    finish({ repo: "octo/app", pr: 1, doneAt: "2026-11-21T10:00:00Z", mergedAt: null, rounds: 0 });
    finish({ repo: "octo/app", pr: 2, doneAt: "2026-11-22T10:00:00Z", mergedAt: null, rounds: 2 });
    finish({ repo: "octo/lib", pr: 3, doneAt: "2026-11-23T10:00:00Z", mergedAt: null, rounds: 2 });
    // Done before the window: not counted.
    finish({ repo: "octo/app", pr: 4, doneAt: "2026-10-01T10:00:00Z", mergedAt: null, rounds: 7 });

    const result = chart(db, "review_rounds");
    expect(result.bars).toEqual([
      { label: "0", value: 1 },
      { label: "1", value: 0 },
      { label: "2", value: 2 },
    ]);
    expect(result.title).toBe("Review rounds per completed task, last 7d");
    expect(result.caption).toContain("3 completed tasks");
    expect(result.caption).toContain("average 1.3");

    const lib = chart(db, "review_rounds", { repo: "octo/lib" });
    expect(lib.bars).toEqual([
      { label: "0", value: 0 },
      { label: "1", value: 0 },
      { label: "2", value: 1 },
    ]);
  });

  it("reports no data when no task reached Done in the window", () => {
    const { db } = setup();
    expect(noData(db, "review_rounds", { window: "24h" })).toContain(
      "No task reached Done in the last 24h",
    );
  });
});

describe("chartData window", () => {
  it("reads 24h, 7d, and 30d and rejects anything else", () => {
    const { db, finish } = setup();
    finish({
      repo: "octo/app",
      pr: 1,
      doneAt: "2026-11-25T08:00:00Z",
      mergedAt: "2026-11-25T07:00:00Z",
    });
    finish({
      repo: "octo/app",
      pr: 2,
      doneAt: "2026-11-05T08:00:00Z",
      mergedAt: "2026-11-05T07:00:00Z",
    });
    const total = (window: string): number =>
      chart(db, "merges_per_day", { window }).bars.reduce((sum, bar) => sum + bar.value, 0);
    expect(total("24h")).toBe(1);
    expect(total("7d")).toBe(1);
    expect(total("30d")).toBe(2);
    for (const bad of ["soon", "0d", "9999d", ""]) {
      expect(() => chartData(db, { metric: "merges_per_day", window: bad, now: NOW })).toThrow(
        /not valid/,
      );
    }
  });
});

/** The pixels of a PNG, read back with only zlib, as rows of [r, g, b]. */
function decode(png: Buffer): { width: number; height: number; pixels: number[][][] } {
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(png[24]).toBe(8);
  expect(png[25]).toBe(2);
  const data: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") {
      data.push(png.subarray(at + 8, at + 8 + length));
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const pixels: number[][][] = [];
  for (let y = 0; y < height; y++) {
    expect(raw[y * (1 + width * 3)]).toBe(0);
    const row: number[][] = [];
    for (let x = 0; x < width; x++) {
      const at = y * (1 + width * 3) + 1 + x * 3;
      row.push([raw[at] ?? -1, raw[at + 1] ?? -1, raw[at + 2] ?? -1]);
    }
    pixels.push(row);
  }
  return { width, height, pixels };
}

function distinct(image: ReturnType<typeof decode>): Set<string> {
  return new Set(image.pixels.flat().map((pixel) => pixel.join(",")));
}

describe("renderBarChart", () => {
  it("draws a valid PNG with the bars in it", () => {
    const png = renderBarChart({
      title: "Merges per day, last 7d",
      caption: "3 merges. 2 Done tasks left out because they have no recorded merge time.",
      bars: [
        { label: "11-21", value: 2 },
        { label: "11-22", value: 0 },
        { label: "11-23", value: 1 },
      ],
    });
    const image = decode(png);
    expect(image.width).toBeGreaterThanOrEqual(600);
    expect(image.height).toBeGreaterThanOrEqual(300);
    // A white surface, ink for text, grid, and a bar color: more than one color and not one flat fill.
    expect(distinct(image).size).toBeGreaterThanOrEqual(4);
    expect(image.pixels[0]?.[0]).toEqual([255, 255, 255]);
  });

  it("draws taller bars for bigger values", () => {
    const heights = (values: number[]): number => {
      const image = decode(
        renderBarChart({
          title: "t",
          caption: "c",
          bars: values.map((value, i) => ({ label: String(i), value })),
        }),
      );
      // Count the rows where the first bar's color shows in the plot.
      const counts = new Map<string, number>();
      for (const pixel of image.pixels.flat()) {
        const key = pixel.join(",");
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return Math.max(
        ...[...counts].filter(([key]) => key !== "255,255,255").map(([, count]) => count),
      );
    };
    // The bar color is the most common non-white color; two equal bars cover about twice one.
    expect(heights([4, 4])).toBeGreaterThan(heights([4, 0]) * 1.5);
  });

  it("grows taller when the caption wraps onto more lines", () => {
    const short = decode(
      renderBarChart({ title: "t", caption: "short", bars: [{ label: "a", value: 1 }] }),
    );
    const long = decode(
      renderBarChart({
        title: "t",
        caption: "a long caption that goes on and on ".repeat(12),
        bars: [{ label: "a", value: 1 }],
      }),
    );
    expect(long.height).toBeGreaterThan(short.height);
  });
});
