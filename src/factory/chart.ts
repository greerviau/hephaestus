import type { Database } from "better-sqlite3";
import { parseWindow, type StatsWindow } from "./stats.js";

export const CHART_METRICS = ["merges_per_day", "tasks_by_stage", "review_rounds"] as const;
export type ChartMetric = (typeof CHART_METRICS)[number];

export interface ChartBar {
  label: string;
  value: number;
}

export type ChartResult =
  | { kind: "chart"; metric: ChartMetric; title: string; caption: string; bars: ChartBar[] }
  /** The window holds nothing recorded for the metric, so there is nothing to draw. */
  | { kind: "no-data"; metric: ChartMetric; message: string };

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** Review-round counts above this share the last bar, so one outlier does not stretch the chart. */
const MAX_ROUND_BARS = 10;

interface Scope {
  window: StatsWindow;
  repo: string | null;
  /** `, octo/app` or nothing, for a title. */
  suffix: string;
  /** `all projects` or the repo, for a sentence. */
  where: string;
}

/** The first Done event of each task, which is when it was done. */
function doneInWindow(
  db: Database,
  scope: Scope,
): { id: number; rounds: number; prNumber: number | null; repo: string }[] {
  return db
    .prepare(
      `SELECT c.id, c.rounds, c.pr_number AS prNumber, c.repo
       FROM tasks c JOIN task_events e ON e.task_id = c.id AND e.kind = 'stage:Done'
       WHERE (@repo IS NULL OR c.repo = @repo)
       GROUP BY c.id HAVING MIN(e.at) >= @since AND MIN(e.at) <= @until ORDER BY c.id`,
    )
    .all({ repo: scope.repo, since: scope.window.since, until: scope.window.until }) as {
    id: number;
    rounds: number;
    prNumber: number | null;
    repo: string;
  }[];
}

/** The days from the window's start to its end as UTC `MM-DD` labels, with their ISO dates. */
function days(window: StatsWindow): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const end = window.until.slice(0, 10);
  for (let t = Date.parse(window.since.slice(0, 10)); ; t += 86_400_000) {
    const key = new Date(t).toISOString().slice(0, 10);
    out.push({ key, label: key.slice(5) });
    if (key >= end) break;
  }
  return out;
}

function mergesPerDay(db: Database, scope: Scope): ChartResult {
  const merges = db
    .prepare(
      `SELECT SUBSTR(m.at, 1, 10) AS day FROM tasks c
       JOIN merges m ON m.repo = c.repo AND m.pr_number = c.pr_number
       WHERE (@repo IS NULL OR c.repo = @repo) AND m.at >= @since AND m.at <= @until`,
    )
    .all({ repo: scope.repo, since: scope.window.since, until: scope.window.until }) as {
    day: string;
  }[];
  // A Done task with no merge record cannot be placed on a day, so it is counted, not drawn.
  const merged = db.prepare("SELECT 1 FROM merges WHERE repo = ? AND pr_number = ?");
  const leftOut = doneInWindow(db, scope).filter(
    (task) => task.prNumber === null || merged.get(task.repo, task.prNumber) === undefined,
  ).length;
  const label = scope.window.label;
  if (merges.length === 0) {
    return {
      kind: "no-data",
      metric: "merges_per_day",
      message:
        `No merges are recorded in the last ${label} for ${scope.where}.` +
        (leftOut > 0
          ? ` ${plural(leftOut, "Done task")} ${leftOut === 1 ? "has" : "have"} no recorded merge time, so ${leftOut === 1 ? "it is" : "they are"} not counted.`
          : ""),
    };
  }
  const perDay = new Map<string, number>();
  for (const { day } of merges) perDay.set(day, (perDay.get(day) ?? 0) + 1);
  const left =
    leftOut === 0
      ? "No Done tasks were left out."
      : `${plural(leftOut, "Done task")} left out because ${leftOut === 1 ? "it has" : "they have"} no recorded merge time.`;
  return {
    kind: "chart",
    metric: "merges_per_day",
    title: `Merges per day, last ${label}${scope.suffix}`,
    caption: `${plural(merges.length, "merge")} recorded for ${scope.where}, by UTC day. ${left}`,
    bars: days(scope.window).map((day) => ({ label: day.label, value: perDay.get(day.key) ?? 0 })),
  };
}

function tasksByStage(db: Database, scope: Scope): ChartResult {
  // The log holds every stage change with its time, so this is history, not today's stage.
  const rows = db
    .prepare(
      `SELECT SUBSTR(e.kind, 7) AS stage, COUNT(DISTINCT e.task_id) AS n
       FROM task_events e JOIN tasks c ON c.id = e.task_id
       WHERE e.kind LIKE 'stage:%' AND e.at >= @since AND e.at <= @until
         AND (@repo IS NULL OR c.repo = @repo)
       GROUP BY e.kind ORDER BY MIN(e.id)`,
    )
    .all({ repo: scope.repo, since: scope.window.since, until: scope.window.until }) as {
    stage: string;
    n: number;
  }[];
  if (rows.length === 0) {
    return {
      kind: "no-data",
      metric: "tasks_by_stage",
      message: `No task changed stage in the last ${scope.window.label} for ${scope.where}.`,
    };
  }
  return {
    kind: "chart",
    metric: "tasks_by_stage",
    title: `Tasks by stage, last ${scope.window.label}${scope.suffix}`,
    caption: `Tasks that entered each stage in the window for ${scope.where}, from recorded stage changes. A task that passed through several stages counts once in each.`,
    bars: rows.map((row) => ({ label: row.stage, value: row.n })),
  };
}

function reviewRounds(db: Database, scope: Scope): ChartResult {
  const done = doneInWindow(db, scope);
  if (done.length === 0) {
    return {
      kind: "no-data",
      metric: "review_rounds",
      message: `No task reached Done in the last ${scope.window.label} for ${scope.where}.`,
    };
  }
  const top = Math.min(MAX_ROUND_BARS, Math.max(...done.map((task) => task.rounds)));
  const bars: ChartBar[] = [];
  for (let rounds = 0; rounds <= top; rounds++) {
    const capped = rounds === MAX_ROUND_BARS;
    bars.push({
      label: capped ? `${String(rounds)}+` : String(rounds),
      value: done.filter((task) => (capped ? task.rounds >= rounds : task.rounds === rounds))
        .length,
    });
  }
  const sum = done.reduce((total, task) => total + task.rounds, 0);
  const average = Math.round((sum / done.length) * 10) / 10;
  return {
    kind: "chart",
    metric: "review_rounds",
    title: `Review rounds per completed task, last ${scope.window.label}${scope.suffix}`,
    caption: `${plural(done.length, "completed task")} for ${scope.where}, by review rounds: average ${String(average)}, most ${String(Math.max(...done.map((task) => task.rounds)))}.`,
    bars,
  };
}

/**
 * The bars for a factory chart, drawn only from recorded data. A window with
 * nothing recorded gives `no-data` and no bars, never an empty chart.
 */
export function chartData(
  db: Database,
  options: {
    metric: ChartMetric;
    repo?: string | undefined;
    window?: string | undefined;
    now?: Date;
  },
): ChartResult {
  const window = parseWindow(options.window, options.now ?? new Date());
  const repo = options.repo ?? null;
  const scope: Scope = {
    window,
    repo,
    suffix: repo === null ? "" : `, ${repo}`,
    where: repo ?? "all projects",
  };
  switch (options.metric) {
    case "merges_per_day":
      return mergesPerDay(db, scope);
    case "tasks_by_stage":
      return tasksByStage(db, scope);
    case "review_rounds":
      return reviewRounds(db, scope);
  }
}
