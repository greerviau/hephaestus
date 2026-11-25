import type { Card, CardEvent } from "../factory/cards.js";
import type { TrackedIssue } from "../factory/intake.js";
import { STAGES } from "../hermes/board.js";
import type { StoredThread } from "../t3/events.js";
import {
  STORE_ERROR,
  cardLabel,
  cardLink,
  here,
  isRunning,
  issueUrl,
  notice,
  prUrl,
  providerName,
  read,
  shortSha,
  stagePill,
  threadHref,
  type FactoryPages,
} from "./factory.js";
import {
  selectField,
  card,
  empty,
  escapeHtml,
  externalLink,
  layout,
  pageHead,
  pill,
  table,
  when,
} from "./html.js";
import { sendHtml, type Route } from "./http.js";
import { escalationActions, issueActions, issueWhy } from "./overview.js";

const STAGE_FILTERS: [string, string][] = [
  ["", "All stages"],
  ["needs-you", "Needs you"],
  ["active", "In progress"],
  ["finished", "Finished"],
  ...STAGES.map((stage): [string, string] => [stage, stage]),
];

function matchesStage(item: Card, filter: string): boolean {
  if (filter === "") return true;
  if (filter === "needs-you") return item.stage === "Escalated" && item.escalatedTo === "owner";
  if (filter === "finished") return item.stage === "Done" || item.stage === "Abandoned";
  if (filter === "active") return item.stage !== "Done" && item.stage !== "Abandoned";
  return item.stage === filter;
}

/** Factory projects in the config, plus any repo a card or issue names. */
export function projects(factory: FactoryPages, cards: Card[], issues: TrackedIssue[]): string[] {
  const names = new Set(Object.keys(factory.store.current()?.document.projects ?? {}));
  for (const item of cards) names.add(item.repo);
  for (const issue of issues) names.add(issue.repo);
  return [...names].sort();
}

function threadPill(thread: StoredThread): string {
  if (isRunning(thread)) return pill("run", thread.status === "starting" ? "Starting" : "Running");
  if (thread.status === "completed") return pill("done", "Completed");
  if (thread.status === "unavailable") return pill("off", "Unavailable");
  return pill("bad", thread.status.replace("_", " "));
}

export function eventTitle(event: CardEvent): string {
  if (event.kind.startsWith("stage:")) return `Moved to ${event.kind.slice("stage:".length)}`;
  if (event.kind === "escalated:lead") return "Sent to the lead";
  if (event.kind === "escalated:owner") return "Escalated to you";
  if (event.kind === "admitted") return "Admitted";
  if (event.kind === "error") return "Error";
  return event.kind;
}

export function isBad(event: CardEvent): boolean {
  return (
    event.kind === "error" ||
    event.kind === "stage:Escalated" ||
    event.kind === "stage:Reverting" ||
    event.kind === "escalated:owner"
  );
}

/** The mockup's timeline of a card's events, oldest first. */
/** What an event says on a page. An error's stored text can carry upstream output, so it is not shown. */
export function eventDetail(event: CardEvent): string {
  return event.kind === "error" ? "A step failed; the service log has the error." : event.detail;
}

export function timeline(events: CardEvent[], now: number): string {
  return `<ol class="timeline">${events
    .map(
      (event, index) =>
        `<li class="${[index === events.length - 1 ? "now" : "", isBad(event) ? "bad" : ""].join(" ").trim()}"><span class="t">${when(event.at, now)}</span><span class="dot" aria-hidden="true"></span><div class="ev"><strong>${escapeHtml(eventTitle(event))}</strong>${eventDetail(event) === "" ? "" : `<p>${escapeHtml(eventDetail(event))}</p>`}</div></li>`,
    )
    .join("\n")}</ol>`;
}

export function workRoutes(factory: FactoryPages): Route[] {
  const now = factory.now ?? Date.now;
  return [
    {
      method: "GET",
      path: /^\/work$/,
      handle: ({ response, url }) => {
        const project = url.searchParams.get("project") ?? "";
        const stage = url.searchParams.get("stage") ?? "";
        const cards = read("cards", () => factory.cards.list());
        const issues = read("issues", () => factory.intake.issues());
        const names = read("projects", () =>
          projects(factory, cards.ok ? cards.value : [], issues.ok ? issues.value : []),
        );
        const back = here(url);
        const filters = `<form class="filterbar" method="get" action="/work">${selectField(
          "project",
          "Project",
          [
            ["", "All projects"],
            ...(names.ok ? names.value : []).map((name): [string, string] => [name, name]),
          ],
          project,
        )}${selectField("stage", "Stage", STAGE_FILTERS, stage)}<button type="submit" class="btn-secondary">Filter</button></form>`;

        let issuesBody = empty("Tracked issues could not be read.");
        if (issues.ok) {
          const inProject = issues.value.filter(
            (issue) => project === "" || issue.repo === project,
          );
          const waiting = inProject.filter(
            (issue) => issue.state === "awaiting-owner" || issue.state === "held-cap",
          );
          const rejected = inProject.filter((issue) => issue.state === "rejected");
          issuesBody =
            waiting.length === 0
              ? empty("No issue is waiting for you.")
              : table(
                  [
                    { label: "Issue", className: "title-cell" },
                    { label: "Why it waits" },
                    { label: "Seen", right: true },
                    { label: "Actions" },
                  ],
                  waiting.map((issue) => [
                    externalLink(
                      issueUrl(issue.repo, issue.number),
                      `${issue.repo}#${String(issue.number)} ${issue.title}`,
                    ),
                    issueWhy(issue),
                    when(issue.createdAt, now()),
                    `<div class="btn-row">${issueActions(issue, back)}</div>`,
                  ]),
                );
          if (rejected.length > 0) {
            issuesBody += `<details class="more"><summary>Rejected issues <span class="num">${String(rejected.length)}</span></summary><ul class="mini-list">${rejected
              .map(
                (issue) =>
                  `<li>${externalLink(issueUrl(issue.repo, issue.number), `${issue.repo}#${String(issue.number)} ${issue.title}`)}${pill("off", "Rejected")}</li>`,
              )
              .join("")}</ul></details>`;
          }
        }

        let cardsBody = empty("Cards could not be read.");
        if (cards.ok) {
          const shown = cards.value.filter(
            (item) => (project === "" || item.repo === project) && matchesStage(item, stage),
          );
          cardsBody =
            shown.length === 0
              ? empty(
                  cards.value.length === 0
                    ? "No cards yet. An issue gets a card when it is admitted."
                    : "No cards match these filters.",
                )
              : table(
                  [
                    { label: "Card", className: "title-cell" },
                    { label: "Project" },
                    { label: "Stage" },
                    { label: "PR" },
                    { label: "Worker" },
                    { label: "Updated", right: true },
                  ],
                  shown.map((item) => [
                    cardLink(item),
                    `<code>${escapeHtml(item.repo)}</code>`,
                    `${stagePill(item)}${item.waiting === null ? "" : `<span class="sub">${escapeHtml(item.waiting)}</span>`}`,
                    item.prNumber === null
                      ? '<span class="s-muted">None</span>'
                      : externalLink(prUrl(item.repo, item.prNumber), `#${String(item.prNumber)}`),
                    escapeHtml(item.workerEnv ?? "-"),
                    when(item.updatedAt, now()),
                  ]),
                );
        }

        const failed = !cards.ok || !issues.ok;
        sendHtml(
          response,
          200,
          layout(
            "Work items",
            `${pageHead({ title: "Work items", lede: "Admitted cards and the GitHub issues Hephaestus tracks. The factory works only on admitted issues." })}${notice(url)}${failed ? STORE_ERROR : ""}${filters}<div class="grid">${card(
              { title: "Issues waiting for you", body: issuesBody },
            )}${card({ title: "Cards", body: cardsBody })}</div>`,
            { section: "/work" },
          ),
        );
      },
    },
    {
      method: "GET",
      path: /^\/work\/(\d+)$/,
      handle: ({ response, url, params }) => {
        const id = Number(params[0]);
        const found = read("the card", () => factory.cards.find(id));
        if (!found.ok) {
          sendHtml(
            response,
            503,
            layout(
              "Work item",
              `${pageHead({ title: "Work item", crumbs: '<a href="/work">Work items</a>' })}${STORE_ERROR}`,
              {
                section: "/work",
              },
            ),
          );
          return;
        }
        const item = found.value;
        if (item === undefined) {
          sendHtml(
            response,
            404,
            layout(
              "Not found",
              `${pageHead({ title: "No such card", crumbs: '<a href="/work">Work items</a>' })}${empty("This card does not exist.")}`,
              { section: "/work" },
            ),
          );
          return;
        }
        const events = read("card events", () => factory.cards.events(id));
        const threads = read("card threads", () => factory.events.forCard(id));
        const back = `/work/${String(id)}`;
        const actions = escalationActions(item, back);

        const reverting = item.stage === "Reverting" || item.ownerAction === "revert-merge";
        const kv: [string, string][] = [
          ["Stage", stagePill(item)],
          [
            "Project",
            `<code>${escapeHtml(item.repo)}</code>${item.issueNumber === null ? "" : ` ${externalLink(issueUrl(item.repo, item.issueNumber), `issue #${String(item.issueNumber)}`)}`}`,
          ],
          [
            "Pull request",
            item.prNumber === null
              ? '<span class="s-muted">None yet</span>'
              : `${externalLink(prUrl(item.repo, item.prNumber), `#${String(item.prNumber)}`)}${item.headSha === null || reverting ? "" : ` at <code title="${escapeHtml(item.headSha)}">${shortSha(item.headSha)}</code>`}`,
          ],
          // While a card reverts, its head is the revert PR's.
          ...(reverting && item.revertPr !== null
            ? ([
                [
                  "Revert PR",
                  `${externalLink(prUrl(item.repo, item.revertPr), `#${String(item.revertPr)}`)}${item.headSha === null ? "" : ` at <code title="${escapeHtml(item.headSha)}">${shortSha(item.headSha)}</code>`}`,
                ],
              ] as [string, string][])
            : []),
          ["Branch", item.branch === null ? "-" : `<code>${escapeHtml(item.branch)}</code>`],
          ["Worker", escapeHtml(item.workerEnv ?? "Not chosen")],
          [
            "Implementer",
            item.implementer === null
              ? "-"
              : escapeHtml(providerName(`hephaestus-${item.implementer}`)),
          ],
          ["Review rounds", String(item.rounds)],
        ];
        if (item.stage === "Escalated" || item.reason !== null) {
          kv.push([
            item.stage === "Abandoned" ? "Why abandoned" : "Escalation",
            `${item.escalatedTo === null ? "" : `${item.escalatedTo === "owner" ? "With you" : "With the lead"}: `}${escapeHtml(item.reason ?? "")}`,
          ]);
        }
        if (item.waiting !== null) kv.push(["Waiting", escapeHtml(item.waiting)]);
        if (item.mergeSha !== null)
          kv.push(["Merge commit", `<code>${shortSha(item.mergeSha)}</code>`]);
        if (item.revertPr !== null)
          kv.push([
            "Revert PR",
            externalLink(prUrl(item.repo, item.revertPr), `#${String(item.revertPr)}`),
          ]);
        if (item.foreignMerge)
          kv.push(["Flag", '<span class="s-crit">Merged outside Hephaestus</span>']);
        if (item.startedAt !== null) kv.push(["Started", when(item.startedAt, now())]);
        kv.push(["Updated", when(item.updatedAt, now())]);
        const summary = `<dl class="kv">${kv.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`).join("")}</dl>${
          item.brief === null
            ? ""
            : `<details class="more"><summary>The lead's brief</summary><pre class="block">${escapeHtml(item.brief)}</pre></details>`
        }`;

        const threadsBody = !threads.ok
          ? empty("Threads could not be read.")
          : threads.value.length === 0
            ? empty("No thread has started for this card.")
            : `<ul class="mini-list">${threads.value
                .map(
                  (thread) =>
                    `<li><span><a href="${threadHref(thread)}">${thread.kind === "review" ? "Review" : "Implement"}</a><span class="sub">${escapeHtml(`${thread.environmentId}, ${providerName(thread.providerInstanceId)}, ${thread.model}`)}</span></span>${threadPill(thread)}</li>`,
                )
                .join("")}</ul>`;

        const history = !events.ok
          ? empty("The card's history could not be read.")
          : events.value.length === 0
            ? empty("Nothing has happened yet.")
            : timeline(events.value, now());

        const lede = `${stagePill(item)} <code>${escapeHtml(item.repo)}</code>${item.prNumber === null ? "" : ` ${externalLink(prUrl(item.repo, item.prNumber), `${item.repo}#${String(item.prNumber)}`)}`}`;
        sendHtml(
          response,
          200,
          layout(
            cardLabel(item),
            `${pageHead({
              title: cardLabel(item),
              crumbs: `<a href="/work">Work items</a><span aria-hidden="true">/</span><span>Card ${String(id)}</span>`,
              lede,
              ...(actions === "" ? {} : { actions }),
            })}${notice(url)}${events.ok && threads.ok ? "" : STORE_ERROR}<div class="grid">${card({
              title: "Summary",
              span: 7,
              body: summary,
            })}${card({ title: "Threads", span: 5, body: threadsBody })}${card({
              title: "History",
              body: history,
            })}</div>`,
            { section: "/work" },
          ),
        );
      },
    },
    {
      method: "GET",
      path: /^\/threads\/([^/]+)\/([^/]+)$/,
      handle: ({ response, params }) => {
        let environmentId: string;
        let threadId: string;
        try {
          environmentId = decodeURIComponent(params[0] ?? "");
          threadId = decodeURIComponent(params[1] ?? "");
        } catch {
          environmentId = "";
          threadId = "";
        }
        const thread = read("the thread", () => factory.events.thread(environmentId, threadId));
        const items = read("thread items", () => factory.events.items(environmentId, threadId));
        if (!thread.ok || !items.ok) {
          sendHtml(
            response,
            503,
            layout("Thread", `${pageHead({ title: "Thread" })}${STORE_ERROR}`, {
              section: "/work",
            }),
          );
          return;
        }
        if (thread.value === undefined) {
          sendHtml(
            response,
            404,
            layout(
              "Not found",
              `${pageHead({ title: "No such thread" })}${empty("Hephaestus has no record of this thread.")}`,
              {
                section: "/work",
              },
            ),
          );
          return;
        }
        const record = thread.value;
        const crumbs = [
          '<a href="/work">Work items</a>',
          ...(record.cardId === null
            ? []
            : [
                `<a href="/work/${encodeURIComponent(record.cardId)}">Card ${escapeHtml(record.cardId)}</a>`,
              ]),
        ].join('<span aria-hidden="true">/</span>');
        const lede = `${threadPill(record)} ${escapeHtml(
          `${record.kind} thread on ${record.environmentId}, ${providerName(record.providerInstanceId)}, ${record.model}, config v${String(record.configVersion)}`,
        )}`;
        const activity =
          items.value.length === 0
            ? empty("No activity recorded yet.")
            : `<div class="thread-box"><ol class="thread">${items.value
                .map(
                  (item) =>
                    `<li class="${item.type.includes("assistant") ? "th-agent" : item.type.includes("command") || item.type.includes("tool") ? "th-tool" : ""}"><span class="t num">${String(item.position)}</span><span class="who">${escapeHtml(item.type.replaceAll("_", " "))}${item.status === "completed" ? "" : `<br>${escapeHtml(item.status.replaceAll("_", " "))}`}</span><span class="what">${escapeHtml(item.text)}</span></li>`,
                )
                .join("\n")}</ol></div>`;
        sendHtml(
          response,
          200,
          layout(
            record.title,
            `${pageHead({ title: record.title, crumbs, lede })}<div class="grid">${card({
              title: "Activity",
              meta: `<span class="meta">Started ${when(record.createdAt, now())}, as Hephaestus recorded it</span>`,
              body: activity,
            })}</div>`,
            { section: "/work" },
          ),
        );
      },
    },
  ];
}
