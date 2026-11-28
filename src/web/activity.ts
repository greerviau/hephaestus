import { ROLE_NAMES } from "../config/document.js";
import type { RecentEvent } from "../factory/tasks.js";
import { currentRoleName } from "../legacy-planner.js";
import { STORE_ERROR, here, notice, read, type FactoryPages } from "./factory.js";
import {
  empty,
  escapeHtml,
  layout,
  pageHead,
  postButton,
  segmented,
  selectControl,
  statusText,
  when,
} from "./html.js";
import { sendHtml, type Route } from "./http.js";
import { eventDetail, eventTitle, isBad } from "./work.js";

const LIMIT = 200;
const ARGUMENT_CHARS = 240;
const KINDS = [
  ["", "Everything"],
  ["tasks", "Tasks"],
  ["calls", "Agent calls"],
  ["notifications", "Notifications"],
] as const;

interface Entry {
  at: string;
  /** Safe HTML. */
  text: string;
  /** Safe HTML under the text. */
  sub: string;
  /** Safe HTML at the right. */
  outcome: string;
}

/** The Activity page: task events, the factory profiles' tool calls, and notifications, newest first. */
export function activityRoutes(factory: FactoryPages): Route[] {
  const now = factory.now ?? Date.now;
  return [
    {
      method: "GET",
      path: /^\/activity$/,
      handle: ({ response, url, shell }) => {
        const show = KINDS.find(([value]) => value === url.searchParams.get("show"))?.[0] ?? "";
        // The role filter belongs to the Agent calls view, the only one that shows its form.
        const role = show === "calls" ? currentRoleName(url.searchParams.get("role") ?? "") : "";
        // Blank text is no search, so a cleared field shows everything again.
        const q = (url.searchParams.get("q") ?? "").trim();
        const needle = q.toLowerCase();
        const project = shell?.project;
        const back = here(url);
        const entries: Entry[] = [];
        let failed = false;

        if (show === "" || show === "tasks") {
          // The store narrows each list to the project, so a quiet project still fills the page.
          const events = read("task events", () =>
            factory.tasks.recentEvents(
              LIMIT,
              project,
              q === ""
                ? undefined
                : (event) => {
                    const { name, what, detail } = describe(event);
                    return `${name}\n${what}\n${detail}`.toLowerCase().includes(needle);
                  },
            ),
          );
          if (events.ok) {
            for (const event of events.value) {
              const { name, what, detail } = describe(event);
              entries.push({
                at: event.at,
                text: `<a href="/work/${String(event.taskId)}">${escapeHtml(name)}</a>: ${escapeHtml(what)}`,
                sub: detail === "" ? "" : `<span class="subline">${escapeHtml(detail)}</span>`,
                outcome: isBad(event) ? statusText("you", "Needs a look") : "",
              });
            }
          } else failed = true;
        }
        if (show === "" || show === "calls") {
          const calls = read("MCP calls", () =>
            factory.mcp.calls(LIMIT, {
              ...(role === "" ? {} : { role }),
              ...(project === undefined ? {} : { repo: project }),
              ...(q === "" ? {} : { text: q }),
            }),
          );
          if (calls.ok) {
            for (const call of calls.value) {
              const args =
                call.arguments.length > ARGUMENT_CHARS
                  ? `${call.arguments.slice(0, ARGUMENT_CHARS)}...`
                  : call.arguments;
              entries.push({
                at: call.at,
                text: escapeHtml(`${call.role} called ${call.tool}`),
                sub: `<details class="fold"><summary>Arguments</summary><div class="fold-body"><pre class="block">${escapeHtml(args)}</pre></div></details>`,
                outcome: call.ok ? statusText("done", "OK") : statusText("bad", "Failed"),
              });
            }
          } else failed = true;
        }
        if (show === "" || show === "notifications") {
          const notifications = read("notifications", () =>
            factory.tasks.recentNotifications(LIMIT, project, q === "" ? undefined : q),
          );
          if (notifications.ok) {
            for (const item of notifications.value) {
              entries.push({
                at: item.at,
                text:
                  item.taskId === null
                    ? escapeHtml(item.text)
                    : `<a href="/work/${String(item.taskId)}">${escapeHtml(item.text)}</a>`,
                sub: "",
                outcome: item.dismissed
                  ? statusText("off", "Dismissed")
                  : `${statusText("you", "Notified you")}${postButton(
                      `/notifications/${String(item.id)}/dismiss`,
                      "Dismiss",
                      { fields: { back } },
                    )}`,
              });
            }
          } else failed = true;
        }

        entries.sort((a, b) => b.at.localeCompare(a.at));
        const shown = entries.slice(0, LIMIT);
        const kinds = segmented(
          "Kind",
          KINDS.map(([value, label]) => ({
            href: activityHref({ show: value, q }),
            label,
            current: value === show,
          })),
        );
        const roles =
          show === "calls"
            ? `<form class="grp" method="get" action="/activity"><input type="hidden" name="show" value="calls">${hidden("q", q)}<label class="inline-field">Role ${selectControl(
                "role",
                [["", "All roles"], ...ROLE_NAMES.map((name): [string, string] => [name, name])],
                role,
              )}</label><button type="submit">Apply</button></form>`
            : "";
        const search = `<form class="grp" method="get" action="/activity" role="search">${hidden("show", show)}${hidden("role", role)}<label class="inline-field">Search <input type="search" name="q" value="${escapeHtml(q)}"></label><button type="submit">Search</button></form>`;
        const list =
          shown.length === 0
            ? empty(
                failed
                  ? "The log could not be read."
                  : q !== ""
                    ? escapeHtml(`Nothing matches "${q}".`)
                    : "Nothing has happened yet. Task events, agent calls, and notifications appear here.",
              )
            : `<ul class="rows">${shown
                .map(
                  (entry) =>
                    `<li class="row kinded act-row"><span class="kind">${when(entry.at, now())}</span><div class="main"><span>${entry.text}</span>${entry.sub}</div><div class="aside">${entry.outcome}</div></li>`,
                )
                .join(
                  "\n",
                )}</ul><p class="empty muted">${String(shown.length)} shown, up to ${String(LIMIT)}.</p>`;

        sendHtml(
          response,
          200,
          layout(
            "Activity",
            `${pageHead({ title: "Activity" })}${notice(url)}${failed ? STORE_ERROR : ""}<div class="bar"><div class="grp">${kinds}</div>${roles}${search}</div>${list}`,
            { section: "/activity", shell, refreshSeconds: 10 },
          ),
        );
      },
    },
  ];
}

/** A task event's parts as the page shows them, which are also what a search matches. */
function describe(event: RecentEvent): { name: string; what: string; detail: string } {
  const issue = event.issueNumber;
  const what = eventTitle(event);
  return {
    name: `${issue === null ? "" : `#${String(issue)} `}${event.title}`,
    what: what.charAt(0).toLowerCase() + what.slice(1),
    detail: eventDetail(event),
  };
}

function activityHref(query: { show: string; q: string }): string {
  const params = new URLSearchParams();
  if (query.show !== "") params.set("show", query.show);
  if (query.q !== "") params.set("q", query.q);
  const rest = params.toString();
  return rest === "" ? "/activity" : `/activity?${rest}`;
}

/** A hidden field that carries a filter, or nothing when the filter is off. */
function hidden(name: string, value: string): string {
  return value === "" ? "" : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}
