import type { Database } from "better-sqlite3";

/** The longest window a stats call may ask for. */
const MAX_WINDOW_DAYS = 365;

export interface StatsWindow {
  /** What the owner asked for, such as `7d`. */
  label: string;
  since: string;
  until: string;
}

/**
 * A time window such as `24h`, `7d`, or `30d` ending now. Without one the
 * window is the last 7 days.
 */
export function parseWindow(window: string | undefined, now: Date): StatsWindow {
  const label = (window ?? "7d").trim().toLowerCase();
  const match = /^(\d{1,4})([hd])$/.exec(label);
  const amount = match === null ? 0 : Number(match[1]);
  const unit = match?.[2];
  const hours = unit === "d" ? amount * 24 : amount;
  if (match === null || amount < 1 || hours > MAX_WINDOW_DAYS * 24) {
    throw new Error(
      `The window "${window ?? ""}" is not valid. Use a number of hours or days, such as 24h, 7d, or 30d, up to ${String(MAX_WINDOW_DAYS)}d.`,
    );
  }
  return {
    label,
    since: new Date(now.getTime() - hours * 3_600_000).toISOString(),
    until: now.toISOString(),
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export interface FactoryStats {
  window: StatsWindow;
  repo: string | null;
  /** Cards as they stand now, not limited to the window. */
  cardsByStage: Record<string, number>;
  /** Cards that reached Done in the window. */
  completed: number;
  /** Completed cards per day over the window. */
  perDay: number;
  /** Hours from a card's first thread to Done, for cards done in the window. */
  cycleHours: { median: number | null; p90: number | null; count: number };
  /** Review rounds of the cards done in the window. */
  reviewRounds: { average: number | null; max: number | null; count: number };
  escalations: { total: number; byTarget: Record<string, number>; reasons: EscalationReason[] };
  /** Issues waiting for the owner or for room under the cap, as they stand now. */
  heldIssues: { repo: string; awaitingOwner: number; heldByCap: number }[];
}

export interface EscalationReason {
  cardId: number;
  repo: string;
  to: string;
  reason: string;
  at: string;
}

/** Cards, throughput, cycle time, review rounds, escalations, and held issues. */
export function factoryStats(
  db: Database,
  options: { repo?: string | undefined; window?: string | undefined; now?: Date } = {},
): FactoryStats {
  const now = options.now ?? new Date();
  const window = parseWindow(options.window, now);
  const repo = options.repo ?? null;

  const stages = db
    .prepare(
      `SELECT stage, COUNT(*) AS n FROM cards WHERE (@repo IS NULL OR repo = @repo) GROUP BY stage ORDER BY stage`,
    )
    .all({ repo }) as { stage: string; n: number }[];

  // A card is done once; the first Done event is when.
  const done = db
    .prepare(
      `SELECT c.id, c.rounds, c.started_at AS startedAt, MIN(e.at) AS doneAt
       FROM cards c JOIN card_events e ON e.card_id = c.id AND e.kind = 'stage:Done'
       WHERE (@repo IS NULL OR c.repo = @repo)
       GROUP BY c.id HAVING MIN(e.at) >= @since AND MIN(e.at) <= @until`,
    )
    .all({ repo, since: window.since, until: window.until }) as {
    id: number;
    rounds: number;
    startedAt: string | null;
    doneAt: string;
  }[];
  const cycles = done
    .filter((row) => row.startedAt !== null)
    .map((row) => (Date.parse(row.doneAt) - Date.parse(row.startedAt ?? "")) / 3_600_000)
    .filter((hours) => Number.isFinite(hours) && hours >= 0)
    .sort((a, b) => a - b);
  const rounds = done.map((row) => row.rounds);
  const days = (Date.parse(window.until) - Date.parse(window.since)) / 86_400_000;

  const escalationRows = db
    .prepare(
      `SELECT e.card_id AS cardId, c.repo, e.at, e.detail FROM card_events e JOIN cards c ON c.id = e.card_id
       WHERE e.kind = 'stage:Escalated' AND e.at >= @since AND e.at <= @until
         AND (@repo IS NULL OR c.repo = @repo) ORDER BY e.id`,
    )
    .all({ repo, since: window.since, until: window.until }) as {
    cardId: number;
    repo: string;
    at: string;
    detail: string;
  }[];
  const reasons = escalationRows.map((row): EscalationReason => {
    // The pipeline records an escalation as "to the <target>: <reason>".
    const match = /^to the (\S+?):\s*([\s\S]*)$/.exec(row.detail);
    return {
      cardId: row.cardId,
      repo: row.repo,
      to: match?.[1] ?? "owner",
      reason: (match?.[2] ?? row.detail).trim(),
      at: row.at,
    };
  });
  const byTarget: Record<string, number> = {};
  for (const reason of reasons) byTarget[reason.to] = (byTarget[reason.to] ?? 0) + 1;

  const held = db
    .prepare(
      `SELECT repo,
         SUM(state = 'awaiting-owner') AS awaitingOwner,
         SUM(state = 'held-cap') AS heldByCap
       FROM issues WHERE state IN ('awaiting-owner', 'held-cap') AND closed = 0
         AND (@repo IS NULL OR repo = @repo) GROUP BY repo ORDER BY repo`,
    )
    .all({ repo }) as { repo: string; awaitingOwner: number; heldByCap: number }[];

  return {
    window,
    repo,
    cardsByStage: Object.fromEntries(stages.map((row) => [row.stage, row.n])),
    completed: done.length,
    perDay: days > 0 ? round(done.length / days, 2) : 0,
    cycleHours: {
      median: roundOrNull(percentile(cycles, 0.5)),
      p90: roundOrNull(percentile(cycles, 0.9)),
      count: cycles.length,
    },
    reviewRounds: {
      average:
        rounds.length === 0 ? null : round(rounds.reduce((a, b) => a + b, 0) / rounds.length),
      max: rounds.length === 0 ? null : Math.max(...rounds),
      count: rounds.length,
    },
    escalations: { total: reasons.length, byTarget, reasons },
    heldIssues: held,
  };
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : round(value);
}

/** What one group of threads used, with each total only when it was recorded. */
export interface UsageGroup {
  threads: number;
  /** Threads with recorded token counts. */
  withTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Threads with a recorded cost. */
  withCost: number;
  costUsd: number | null;
}

export interface UsageStats {
  window: StatsWindow;
  repo: string | null;
  total: UsageGroup;
  /** Implement and review threads, as engineer and reviewer. */
  byRole: Record<string, UsageGroup>;
  byModel: Record<string, UsageGroup>;
  /** The cards with the most threads first, at most 20. */
  byCard: (UsageGroup & { cardId: number; repo: string; title: string })[];
}

const ROLE_LABELS: Record<string, string> = { implement: "engineer", review: "reviewer" };

interface UsageRow {
  kind: string;
  model: string;
  cardId: number | null;
  repo: string | null;
  title: string | null;
  input: number | null;
  output: number | null;
  cost: number | null;
}

function emptyGroup(): UsageGroup {
  return {
    threads: 0,
    withTokens: 0,
    inputTokens: null,
    outputTokens: null,
    withCost: 0,
    costUsd: null,
  };
}

function add(group: UsageGroup, row: UsageRow): void {
  group.threads += 1;
  if (row.input !== null || row.output !== null) {
    group.withTokens += 1;
    group.inputTokens = (group.inputTokens ?? 0) + (row.input ?? 0);
    group.outputTokens = (group.outputTokens ?? 0) + (row.output ?? 0);
  }
  if (row.cost !== null) {
    group.withCost += 1;
    group.costUsd = (group.costUsd ?? 0) + row.cost;
  }
}

/** The map's entry for `key`, made with `make` when there is none. */
function slot<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const made = make();
  map.set(key, made);
  return made;
}

function tidy<T extends UsageGroup>(group: T): T {
  return { ...group, costUsd: group.costUsd === null ? null : round(group.costUsd, 4) };
}

/**
 * Token usage and cost of the engineer and reviewer threads started in the
 * window, by role, model, and card. Only recorded usage is counted: a
 * thread with no report adds to the thread count and to nothing else, so a
 * total that is null means nothing was recorded, not that nothing was used.
 */
export function usageStats(
  db: Database,
  options: { repo?: string | undefined; window?: string | undefined; now?: Date } = {},
): UsageStats {
  const window = parseWindow(options.window, options.now ?? new Date());
  const repo = options.repo ?? null;
  const rows = db
    .prepare(
      `SELECT t.kind, t.model, c.id AS cardId, c.repo, c.title,
         t.input_tokens AS input, t.output_tokens AS output, t.cost_usd AS cost
       FROM factory_threads t LEFT JOIN cards c ON CAST(t.card_id AS INTEGER) = c.id AND t.card_id GLOB '[0-9]*'
       WHERE t.kind IN ('implement', 'review') AND t.created_at >= @since AND t.created_at <= @until
         AND (@repo IS NULL OR c.repo = @repo) ORDER BY t.created_at`,
    )
    .all({ repo, since: window.since, until: window.until }) as UsageRow[];

  const total = emptyGroup();
  const byRole = new Map<string, UsageGroup>();
  const byModel = new Map<string, UsageGroup>();
  const byCard = new Map<number, UsageGroup & { cardId: number; repo: string; title: string }>();
  for (const row of rows) {
    add(total, row);
    const role = ROLE_LABELS[row.kind] ?? row.kind;
    add(slot(byRole, role, emptyGroup), row);
    add(slot(byModel, row.model, emptyGroup), row);
    if (row.cardId !== null) {
      const { cardId } = row;
      add(
        slot(byCard, cardId, () => ({
          ...emptyGroup(),
          cardId,
          repo: row.repo ?? "",
          title: row.title ?? "",
        })),
        row,
      );
    }
  }
  const finish = (map: Map<string, UsageGroup>): Record<string, UsageGroup> =>
    Object.fromEntries([...map].map(([key, group]) => [key, tidy(group)]));
  return {
    window,
    repo,
    total: tidy(total),
    byRole: finish(byRole),
    byModel: finish(byModel),
    byCard: [...byCard.values()]
      .sort((a, b) => b.threads - a.threads || a.cardId - b.cardId)
      .slice(0, 20)
      .map(tidy),
  };
}

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;

function hours(value: number | null): string {
  return value === null ? "not available" : `${String(value)} h`;
}

/** The factory stats as bullet lines for a chat, with no table. */
export function formatFactoryStats(stats: FactoryStats): string {
  const scope = stats.repo === null ? "all projects" : stats.repo;
  const lines = [`Factory stats for ${scope}, last ${stats.window.label}:`];
  const stages = Object.entries(stats.cardsByStage);
  lines.push(
    stages.length === 0
      ? "- Cards by stage: there are no cards yet."
      : `- Cards by stage: ${stages.map(([stage, n]) => `${stage} ${String(n)}`).join(", ")}.`,
  );
  lines.push(
    `- Completed: ${plural(stats.completed, "card")} reached Done (${String(stats.perDay)} per day).`,
  );
  lines.push(
    stats.cycleHours.count === 0
      ? "- Cycle time: not available, no card with a recorded start reached Done in this window."
      : `- Cycle time (first thread to Done, ${plural(stats.cycleHours.count, "card")}): median ${hours(stats.cycleHours.median)}, 90th percentile ${hours(stats.cycleHours.p90)}.`,
  );
  lines.push(
    stats.reviewRounds.count === 0
      ? "- Review rounds: not available, no card reached Done in this window."
      : `- Review rounds per completed card: average ${String(stats.reviewRounds.average)}, most ${String(stats.reviewRounds.max)}.`,
  );
  if (stats.escalations.total === 0) lines.push("- Escalations: none in this window.");
  else {
    const targets = Object.entries(stats.escalations.byTarget)
      .map(([to, n]) => `${String(n)} to the ${to}`)
      .join(", ");
    lines.push(`- Escalations: ${String(stats.escalations.total)} (${targets}).`);
    for (const reason of stats.escalations.reasons.slice(0, 10)) {
      lines.push(`  - Card ${String(reason.cardId)} (${reason.repo}): ${reason.reason}`);
    }
  }
  if (stats.heldIssues.length === 0) lines.push("- Held issues: none.");
  else {
    lines.push("- Held issues:");
    for (const held of stats.heldIssues) {
      lines.push(
        `  - ${held.repo}: ${String(held.awaitingOwner)} waiting for the owner, ${String(held.heldByCap)} held by the cap.`,
      );
    }
  }
  return lines.join("\n");
}

function group(label: string, g: UsageGroup): string {
  const tokens =
    g.withTokens === 0
      ? "tokens not recorded"
      : `${String(g.inputTokens)} input and ${String(g.outputTokens)} output tokens` +
        (g.withTokens < g.threads
          ? ` (recorded for ${String(g.withTokens)} of ${String(g.threads)})`
          : "");
  const cost =
    g.withCost === 0
      ? "cost not recorded"
      : `$${(g.costUsd ?? 0).toFixed(2)}` +
        (g.withCost < g.threads
          ? ` (recorded for ${String(g.withCost)} of ${String(g.threads)})`
          : "");
  return `${label}: ${plural(g.threads, "thread")}, ${tokens}, ${cost}`;
}

/** The usage stats as bullet lines for a chat, with no table. */
export function formatUsageStats(stats: UsageStats): string {
  const scope = stats.repo === null ? "all projects" : stats.repo;
  const lines = [`Token usage and cost for ${scope}, last ${stats.window.label}:`];
  if (stats.total.threads === 0) {
    lines.push("- No engineer or reviewer threads started in this window.");
    return lines.join("\n");
  }
  lines.push(`- ${group("Total", stats.total)}.`);
  if (stats.total.withTokens === 0 && stats.total.withCost === 0) {
    lines.push(
      "- No token counts or cost are recorded for these threads. Thread counts are real; any token or dollar figure would be a guess.",
    );
  }
  lines.push("- By role:");
  for (const [role, g] of Object.entries(stats.byRole)) lines.push(`  - ${group(role, g)}.`);
  lines.push("- By model:");
  for (const [model, g] of Object.entries(stats.byModel)) lines.push(`  - ${group(model, g)}.`);
  if (stats.byCard.length > 0) {
    lines.push("- By card (most threads first):");
    for (const card of stats.byCard.slice(0, 10)) {
      lines.push(`  - ${group(`Card ${String(card.cardId)} ${card.title}`, card)}.`);
    }
  }
  return lines.join("\n");
}
