import { ROLE_NAMES } from "../config/document.js";
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
        const role = show === "calls" ? (url.searchParams.get("role") ?? "") : "";
        const project = shell?.project;
        const back = here(url);
        const entries: Entry[] = [];
        let failed = false;

        const listed = read("tasks", () => factory.tasks.list());
        if (!listed.ok) failed = true;
        const tasks = new Map((listed.ok ? listed.value : []).map((task) => [task.id, task]));

        if (show === "" || show === "tasks") {
          // The store narrows each list to the project, so a quiet project still fills the page.
          const events = read("task events", () => factory.tasks.recentEvents(LIMIT, project));
          if (events.ok) {
            for (const event of events.value) {
              const issue = tasks.get(event.taskId)?.issueNumber;
              const name = `${issue === undefined || issue === null ? "" : `#${String(issue)} `}${event.title}`;
              const what = eventTitle(event);
              const detail = eventDetail(event);
              entries.push({
                at: event.at,
                text: `<a href="/work/${String(event.taskId)}">${escapeHtml(name)}</a>: ${escapeHtml(what.charAt(0).toLowerCase() + what.slice(1))}`,
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
            factory.tasks.recentNotifications(LIMIT, project),
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
            href: value === "" ? "/activity" : `/activity?show=${value}`,
            label,
            current: value === show,
          })),
        );
        const roles =
          show === "calls"
            ? `<form class="grp" method="get" action="/activity"><input type="hidden" name="show" value="calls"><label class="inline-field">Role ${selectControl(
                "role",
                [["", "All roles"], ...ROLE_NAMES.map((name): [string, string] => [name, name])],
                role,
              )}</label><button type="submit">Apply</button></form>`
            : "";
        const list =
          shown.length === 0
            ? empty(
                failed
                  ? "The log could not be read."
                  : "Nothing has happened yet. Task events, agent calls, and notifications appear here.",
              )
            : `<ul class="rows">${shown
                .map(
                  (entry) =>
                    `<li class="row kinded act-row"><span class="kind">${when(entry.at, now())}</span><div class="main"><span>${entry.text}</span>${entry.sub}</div><div class="aside">${entry.outcome}</div></li>`,
                )
                .join(
                  "\n",
                )}</ul><p class="empty muted">${String(shown.length)} shown, newest first. The page lists at most ${String(LIMIT)}.</p>`;

        sendHtml(
          response,
          200,
          layout(
            "Activity",
            `${pageHead({ title: "Activity", lede: "What the factory did and what it told you, newest first." })}${notice(url)}${failed ? STORE_ERROR : ""}<div class="bar"><div class="grp">${kinds}</div>${roles}</div>${list}`,
            { section: "/activity", shell, refreshSeconds: 10 },
          ),
        );
      },
    },
  ];
}
