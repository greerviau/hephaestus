import type { Analytics } from "../factory/analytics.js";
import { columns, legend, line, tableFold, type Series } from "./charts.js";
import { STORE_ERROR, read, type FactoryPages } from "./factory.js";
import { dayLabel, empty, escapeHtml, layout, pageHead, section, segmented } from "./html.js";
import { sendHtml, type Route } from "./http.js";

/** The periods on offer, in the order shown. The first is the default. */
const SPANS = ["30", "7", "90"] as const;

function hours(value: number): string {
  return `${value.toFixed(1)} h`;
}

function total(value: string, label: string, sub?: string): string {
  return `<li><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span>${sub === undefined ? "" : `<span>${escapeHtml(sub)}</span>`}</li>`;
}

function totals(data: Analytics): string {
  const { totals: sums, cycleHours } = data;
  return `<ul class="totals">${[
    total(String(sums.prs), "PRs"),
    total(String(sums.merges), "Merged"),
    total(String(sums.reverts), "Reverted"),
    total(String(sums.abandoned), "Abandoned"),
    total(String(sums.escalations), "Escalations"),
    total(
      cycleHours.median === null ? "-" : hours(cycleHours.median),
      "Median cycle time",
      cycleHours.p90 === null
        ? undefined
        : `p90 ${hours(cycleHours.p90)}, ${String(cycleHours.count)} ${cycleHours.count === 1 ? "task" : "tasks"}`,
    ),
  ].join("")}</ul>`;
}

function charts(data: Analytics): string {
  const labels = data.days.map((day) => dayLabel(day.day));
  const finished: (Series & { total: number })[] = [
    {
      name: "Merged",
      values: data.days.map((day) => day.merges),
      color: "var(--series-1)",
      total: data.totals.merges,
    },
    {
      name: "Reverted",
      values: data.days.map((day) => day.reverts),
      color: "var(--series-2)",
      hatch: true,
      total: data.totals.reverts,
    },
    {
      name: "Abandoned",
      values: data.days.map((day) => day.abandoned),
      color: "var(--series-muted)",
      total: data.totals.abandoned,
    },
  ];
  const mini = (title: string, chart: string): string =>
    `<div><h3>${escapeHtml(title)}</h3>${chart}</div>`;
  const table = tableFold(
    "Show as a table",
    "Daily numbers",
    ["Day", "Merged", "Reverted", "Abandoned", "PRs", "Escalations", "Cycle"],
    data.days
      .map((day, index) => [
        labels[index] ?? day.day,
        String(day.merges),
        String(day.reverts),
        String(day.abandoned),
        String(day.prs),
        String(day.escalations),
        day.cycleHours === null ? "No reading" : hours(day.cycleHours),
      ])
      .reverse(),
  );
  return [
    section({
      title: "Finished tasks per day",
      body: `${legend(finished)}${columns({
        id: "finished",
        labels,
        series: finished,
        region: "Finished tasks per day chart",
        aria: `Merged, reverted, and abandoned tasks per day: ${String(data.totals.merges)} merged, ${String(data.totals.reverts)} reverted, ${String(data.totals.abandoned)} abandoned.`,
      })}`,
    }),
    section({
      title: "Trends",
      body: `<div class="minis">${[
        mini(
          "PRs at the merge gate",
          line({
            labels,
            values: data.days.map((day) => day.prs),
            color: "var(--series-1)",
            integer: true,
            aria: `PRs that reached the merge gate per day, ${String(data.totals.prs)} in all.`,
          }),
        ),
        mini(
          "Escalations",
          line({
            labels,
            values: data.days.map((day) => day.escalations),
            color: "var(--series-2)",
            integer: true,
            aria: `Escalations per day, ${String(data.totals.escalations)} in all.`,
          }),
        ),
        mini(
          "Median cycle time, hours",
          line({
            labels,
            values: data.days.map((day) => day.cycleHours),
            color: "var(--series-3)",
            aria: "Median hours from a task's first thread to done, per day.",
          }),
        ),
      ].join("")}</div>${table}`,
    }),
  ].join("");
}

/** The Analytics page: totals, finished tasks per day, and trends, for the sidebar's project. */
export function analyticsRoutes(factory: FactoryPages): Route[] {
  return [
    {
      method: "GET",
      path: /^\/analytics$/,
      handle: ({ response, url, shell }) => {
        const span = SPANS.find((value) => value === url.searchParams.get("days")) ?? SPANS[0];
        const days = Number(span);
        const repo = shell?.project;
        const data = read("analytics", () =>
          factory.analytics(repo === undefined ? { days } : { repo, days }),
        );
        const filters = `<div class="bar"><div class="grp">${segmented(
          "Period",
          SPANS.map((value) => ({
            href: value === SPANS[0] ? "/analytics" : `/analytics?days=${value}`,
            label: `${value} days`,
            current: value === span,
          })),
        )}</div><span class="muted">Days are UTC</span></div>`;

        let body: string;
        if (!data.ok) body = empty("The numbers could not be read.");
        else {
          const { totals: sums, cycleHours } = data.value;
          const nothing =
            sums.prs + sums.merges + sums.reverts + sums.escalations + sums.abandoned === 0 &&
            cycleHours.count === 0;
          body = nothing
            ? empty("Nothing to chart yet. Charts fill in as tasks open PRs, merge, and finish.")
            : `${totals(data.value)}${charts(data.value)}`;
        }
        sendHtml(
          response,
          200,
          layout(
            "Analytics",
            `${pageHead({ title: "Analytics" })}${data.ok ? "" : STORE_ERROR}${filters}${body}`,
            { section: "/analytics", shell },
          ),
        );
      },
    },
  ];
}
