import type { Analytics } from "../factory/analytics.js";
import { columns, legend, lines, tableView, type Series } from "./charts.js";
import { STORE_ERROR, read, type FactoryPages } from "./factory.js";
import { card, dayLabel, empty, escapeHtml, layout, pageHead, selectField } from "./html.js";
import { sendHtml, type Route } from "./http.js";
import { projects } from "./work.js";

const SPANS = [
  ["7", "Last 7 days"],
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
] as const;

function hours(value: number): string {
  return `${value.toFixed(1)} h`;
}

function kpi(value: string, label: string, sub?: string): string {
  return `<div><span class="num">${escapeHtml(value)}</span><span class="meta">${escapeHtml(label)}</span>${sub === undefined ? "" : `<span class="meta">${escapeHtml(sub)}</span>`}</div>`;
}

function charts(data: Analytics): string {
  const labels = data.days.map((day) => dayLabel(day.day));
  const throughput: Series[] = [
    { name: "Merged", values: data.days.map((day) => day.merges), color: "var(--series-1)" },
    {
      name: "Reverted",
      values: data.days.map((day) => day.reverts),
      color: "var(--series-2)",
      hatch: true,
    },
    {
      name: "Abandoned",
      values: data.days.map((day) => day.abandoned),
      color: "var(--series-muted)",
    },
  ];
  const prs: Series[] = [
    { name: "PRs", values: data.days.map((day) => day.prs), color: "var(--series-1)" },
  ];
  const escalations: Series[] = [
    {
      name: "Escalations",
      values: data.days.map((day) => day.escalations),
      color: "var(--series-2)",
    },
  ];
  const cycle: Series[] = [
    {
      name: "Median cycle time",
      values: data.days.map((day) => day.cycleHours),
      color: "var(--series-3)",
    },
  ];
  const throughputTotals = [data.totals.merges, data.totals.reverts, data.totals.abandoned];
  const trend = (
    title: string,
    series: Series[],
    body: string,
    format?: (v: number) => string,
  ): string =>
    `<div class="mini span-6"><h3>${escapeHtml(title)}</h3>${body}${tableView(labels, series, "Day", format)}</div>`;
  return [
    card({
      title: "Throughput",
      meta: '<span class="meta">Finished cards per day</span>',
      body: `${legend(throughput.map((series, index) => ({ ...series, total: String(throughputTotals[index] ?? 0) })))}${columns(
        {
          id: "throughput",
          width: 1100,
          integer: true,
          labels,
          series: throughput,
          aria: `Merged, reverted, and abandoned cards per day: ${String(data.totals.merges)} merged, ${String(data.totals.reverts)} reverted, ${String(data.totals.abandoned)} abandoned.`,
        },
      )}${tableView(labels, throughput, "Day")}`,
    }),
    `<section class="card span-12" aria-labelledby="h-trends"><div class="card-head"><h2 id="h-trends">Trends</h2></div><div class="grid mini-grid">${[
      trend(
        "PRs that reached the merge gate",
        prs,
        lines({
          id: "prs",
          width: 520,
          integer: true,
          labels,
          series: prs,
          aria: `PRs per day, ${String(data.totals.prs)} in all.`,
        }),
      ),
      trend(
        "Escalations",
        escalations,
        lines({
          id: "escalations",
          width: 520,
          integer: true,
          labels,
          series: escalations,
          aria: `Escalations per day, ${String(data.totals.escalations)} in all.`,
        }),
      ),
      trend(
        "Median cycle time, first thread to done",
        cycle,
        lines({
          id: "cycle",
          width: 520,
          labels,
          series: cycle,
          aria: "Median hours from a card's first thread to done, per day.",
          format: hours,
        }),
        hours,
      ),
    ].join("")}</div></section>`,
  ].join("\n");
}

/** The Analytics page: throughput, merges, reverts, cycle time, and escalations over time. */
export function analyticsRoutes(factory: FactoryPages): Route[] {
  return [
    {
      method: "GET",
      path: /^\/analytics$/,
      handle: ({ response, url }) => {
        const project = url.searchParams.get("project") ?? "";
        const span = SPANS.find(([value]) => value === url.searchParams.get("days"))?.[0] ?? "30";
        const days = Number(span);
        const names = read("projects", () => projects(factory, factory.cards.list(), []));
        const data = read("analytics", () =>
          factory.analytics(project === "" ? { days } : { repo: project, days }),
        );
        const filters = `<form class="filterbar" method="get" action="/analytics">${selectField(
          "project",
          "Project",
          [
            ["", "All projects"],
            ...(names.ok ? names.value : []).map((name): [string, string] => [name, name]),
          ],
          project,
        )}${selectField("days", "Period", SPANS, span)}<button type="submit" class="btn-secondary">Show</button></form>`;

        let body: string;
        if (!data.ok)
          body = card({ title: "Charts", body: empty("The numbers could not be read.") });
        else {
          const { totals, cycleHours } = data.value;
          const kpis = `<div class="kpis">${[
            kpi(String(totals.prs), "PRs"),
            kpi(String(totals.merges), "Merges"),
            kpi(String(totals.reverts), "Reverts"),
            kpi(String(totals.escalations), "Escalations"),
            kpi(String(totals.abandoned), "Abandoned"),
            kpi(
              cycleHours.median === null ? "-" : hours(cycleHours.median),
              "Median cycle time",
              cycleHours.p90 === null
                ? undefined
                : `p90 ${hours(cycleHours.p90)}, ${String(cycleHours.count)} cards`,
            ),
          ].join("")}</div>`;
          const nothing =
            totals.prs + totals.merges + totals.reverts + totals.escalations + totals.abandoned ===
              0 && cycleHours.count === 0;
          body = nothing
            ? card({
                title: "Charts",
                body: empty(
                  "Nothing to chart yet. Charts fill in as cards open PRs, merge, and finish.",
                ),
              })
            : `${card({ title: "Totals", body: kpis })}${charts(data.value)}`;
        }
        const scope = project === "" ? "all projects" : project;
        sendHtml(
          response,
          200,
          layout(
            "Analytics",
            `${pageHead({
              title: "Analytics",
              lede: `${escapeHtml(SPANS.find(([value]) => value === span)?.[1] ?? "")}, ${escapeHtml(scope)}. Days are UTC.`,
            })}${data.ok && names.ok ? "" : STORE_ERROR}${filters}<div class="grid">${body}</div>`,
            { section: "/analytics" },
          ),
        );
      },
    },
  ];
}
