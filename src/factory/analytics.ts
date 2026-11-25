import type { Database } from "better-sqlite3";

export interface DailyCounts {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  /** PRs factory threads opened that reached the merge gate. */
  prs: number;
  merges: number;
  reverts: number;
  escalations: number;
  abandoned: number;
  /** Median hours from first thread to Done for cards done that day, or null when none were. */
  cycleHours: number | null;
}

export interface Analytics {
  days: DailyCounts[];
  totals: { prs: number; merges: number; reverts: number; escalations: number; abandoned: number };
  /** Hours from a card's first thread to Done, for cards done in the window. */
  cycleHours: { median: number | null; p90: number | null; count: number };
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

/**
 * Throughput, merges, reverts, cycle time, and escalations over the last
 * `days` UTC days, for one factory project or all of them, read from the
 * card log and the merge record.
 */
export function analytics(
  db: Database,
  options: { repo?: string; days?: number; now?: Date } = {},
): Analytics {
  const span = options.days ?? 30;
  const now = options.now ?? new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (span - 1)),
  );
  const since = start.toISOString();
  const repoFilter = options.repo === undefined ? "" : " AND c.repo = ?";
  const repoArgs = options.repo === undefined ? [] : [options.repo];

  const days: DailyCounts[] = [];
  const byDay = new Map<string, DailyCounts>();
  for (let i = 0; i < span; i++) {
    const day = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const counts: DailyCounts = {
      day,
      prs: 0,
      merges: 0,
      reverts: 0,
      escalations: 0,
      abandoned: 0,
      cycleHours: null,
    };
    days.push(counts);
    byDay.set(day, counts);
  }

  const events = db
    .prepare(
      `SELECT e.kind, e.at, e.detail FROM card_events e JOIN cards c ON c.id = e.card_id
       WHERE e.at >= ? AND e.kind IN ('stage:Reviewing', 'stage:Merging', 'stage:Escalated', 'stage:Reverting', 'stage:Abandoned')${repoFilter}`,
    )
    .all(since, ...repoArgs) as { kind: string; at: string; detail: string }[];
  for (const event of events) {
    const counts = byDay.get(dayOf(event.at));
    if (counts === undefined) continue;
    // A PR reaches the gate through review, or straight to Merging when the policy needs none.
    if (
      event.kind === "stage:Reviewing" ||
      (event.kind === "stage:Merging" && event.detail.includes("needs no review"))
    ) {
      if (event.detail.startsWith("PR #")) counts.prs += 1;
    } else if (event.kind === "stage:Escalated") counts.escalations += 1;
    else if (event.kind === "stage:Reverting") counts.reverts += 1;
    else if (event.kind === "stage:Abandoned") counts.abandoned += 1;
  }

  const merges = db
    .prepare(
      `SELECT m.at FROM merges m JOIN cards c ON c.id = m.card_id
       WHERE m.revert = 0 AND m.at >= ?${repoFilter}`,
    )
    .all(since, ...repoArgs) as { at: string }[];
  for (const merge of merges) {
    const counts = byDay.get(dayOf(merge.at));
    if (counts !== undefined) counts.merges += 1;
  }

  const done = db
    .prepare(
      `SELECT c.started_at AS startedAt, e.at AS doneAt FROM cards c
       JOIN card_events e ON e.card_id = c.id AND e.kind = 'stage:Done'
       WHERE e.at >= ? AND c.started_at IS NOT NULL${repoFilter}`,
    )
    .all(since, ...repoArgs) as { startedAt: string; doneAt: string }[];
  const cycles = done
    .map((row) => ({
      day: dayOf(row.doneAt),
      hours: (Date.parse(row.doneAt) - Date.parse(row.startedAt)) / 3_600_000,
    }))
    .filter(({ hours }) => Number.isFinite(hours) && hours >= 0);
  const hours = cycles.map((cycle) => cycle.hours).sort((a, b) => a - b);
  for (const counts of days) {
    const that = cycles
      .filter((cycle) => cycle.day === counts.day)
      .map((cycle) => cycle.hours)
      .sort((a, b) => a - b);
    counts.cycleHours = percentile(that, 0.5);
  }

  const sum = (key: "prs" | "merges" | "reverts" | "escalations" | "abandoned"): number =>
    days.reduce((total, counts) => total + counts[key], 0);
  return {
    days,
    totals: {
      prs: sum("prs"),
      merges: sum("merges"),
      reverts: sum("reverts"),
      escalations: sum("escalations"),
      abandoned: sum("abandoned"),
    },
    cycleHours: {
      median: percentile(hours, 0.5),
      p90: percentile(hours, 0.9),
      count: hours.length,
    },
  };
}
