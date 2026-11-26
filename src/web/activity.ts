import { ROLE_NAMES } from "../config/document.js";
import { STORE_ERROR, read, type FactoryPages } from "./factory.js";
import { card, empty, escapeHtml, layout, pageHead, selectField, status, when } from "./html.js";
import { sendHtml, type Route } from "./http.js";
import { eventDetail, eventTitle, isBad } from "./work.js";

const LIMIT = 200;
const SHOW = [
  ["", "Everything"],
  ["events", "Card events"],
  ["mcp", "MCP calls"],
  ["notifications", "Notifications"],
] as const;

interface Entry {
  at: string;
  /** Safe HTML. */
  text: string;
  /** Safe HTML. */
  sub: string;
  /** Safe HTML. */
  outcome: string;
}

/** The Activity page: card events, the factory profiles' MCP calls, and notifications, newest first. */
export function activityRoutes(factory: FactoryPages): Route[] {
  const now = factory.now ?? Date.now;
  return [
    {
      method: "GET",
      path: /^\/activity$/,
      handle: ({ response, url }) => {
        const show = url.searchParams.get("show") ?? "";
        const role = url.searchParams.get("role") ?? "";
        const entries: Entry[] = [];
        let failed = false;

        if (show === "" || show === "events") {
          const events = read("card events", () => factory.cards.recentEvents(LIMIT));
          if (events.ok) {
            for (const event of events.value) {
              entries.push({
                at: event.at,
                text: `<a href="/work/${String(event.cardId)}">${escapeHtml(event.title)}</a>: ${escapeHtml(eventTitle(event))}`,
                sub: eventDetail(event) === "" ? "" : escapeHtml(eventDetail(event)),
                outcome: isBad(event) ? status("warn", "q", "Needs a look") : "",
              });
            }
          } else failed = true;
        }
        if (show === "" || show === "mcp") {
          const calls = read("MCP calls", () => factory.mcp.calls(LIMIT));
          if (calls.ok) {
            for (const call of calls.value) {
              if (role !== "" && call.role !== role) continue;
              entries.push({
                at: call.at,
                text: escapeHtml(`${call.role} called ${call.tool}`),
                sub: `<code>${escapeHtml(call.arguments.slice(0, 240))}</code>`,
                outcome: call.ok ? status("good", "ok", "OK") : status("crit", "x", "Failed"),
              });
            }
          } else failed = true;
        }
        if (show === "" || show === "notifications") {
          const notifications = read("notifications", () =>
            factory.cards.recentNotifications(LIMIT),
          );
          if (notifications.ok) {
            for (const item of notifications.value) {
              entries.push({
                at: item.at,
                text:
                  item.cardId === null
                    ? escapeHtml(item.text)
                    : `<a href="/work/${String(item.cardId)}">${escapeHtml(item.text)}</a>`,
                sub: "",
                outcome: item.dismissed
                  ? status("muted", "ok", "Dismissed")
                  : status("warn", "q", "Notified you"),
              });
            }
          } else failed = true;
        }

        entries.sort((a, b) => b.at.localeCompare(a.at));
        const shown = entries.slice(0, LIMIT);
        const filters = `<form class="filterbar" method="get" action="/activity">${selectField("show", "Show", SHOW, show)}${selectField(
          "role",
          "MCP calls by role",
          [["", "All roles"], ...ROLE_NAMES.map((name): [string, string] => [name, name])],
          role,
        )}<button type="submit" class="btn-secondary">Filter</button></form>`;
        const body =
          shown.length === 0
            ? empty(
                failed
                  ? "The log could not be read."
                  : "Nothing has happened yet. Card events, MCP calls from the factory profiles, and notifications appear here.",
              )
            : `<ul class="log">${shown
                .map(
                  (entry) =>
                    `<li><span class="t">${when(entry.at, now())}</span><div>${entry.text}${entry.sub === "" ? "" : `<p class="meta">${entry.sub}</p>`}</div><div>${entry.outcome}</div></li>`,
                )
                .join("\n")}</ul>`;

        sendHtml(
          response,
          200,
          layout(
            "Activity",
            `${pageHead({ title: "Activity", lede: "What the factory did, what the planner, lead, and improver asked of Hephaestus, and what it told you." })}${failed ? STORE_ERROR : ""}${filters}<div class="grid">${card(
              {
                title: "Event log",
                meta: `<span class="meta">${String(shown.length)} shown, newest first</span>`,
                body,
              },
            )}</div>`,
            { section: "/activity" },
          ),
        );
      },
    },
  ];
}
