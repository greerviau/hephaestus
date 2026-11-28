import {
  CHANGES_REQUESTED_DETAIL,
  MERGE_CONFLICT_DETAIL,
  type Task,
  type TaskEvent,
} from "../factory/tasks.js";
import type { TrackedIssue } from "../factory/intake.js";
import {
  DEFAULT_PARK_HOURS,
  VALIDATION_FAILED,
  checksPassedAtGate,
  MergeSettledError,
  escalationReason,
  parkRefusal,
} from "../factory/pipeline.js";
import { utcMinute } from "../time.js";
import type { Stage } from "../hermes/board.js";
import type { StoredThread } from "../t3/events.js";
import {
  STORE_ERROR,
  taskActions,
  taskLabel,
  escalationActions,
  failureNotice,
  form,
  handoffFailedText,
  formHref,
  heldIssueRow,
  here,
  isRunning,
  issueUrl,
  mergeButton,
  notice,
  prUrl,
  providerName,
  read,
  runningThreads,
  shortSha,
  stageName,
  stagePill,
  taskStage,
  threadHref,
  withNotice,
  type FactoryPages,
  NEEDS_DECISION,
  REPLANNING,
  type NoticeKey,
  type Read,
} from "./factory.js";
import { ADMITTING_RELOAD_SECONDS, admissionsFor } from "./admissions.js";
import {
  SEND_WAIT_MS,
  SENDING_RELOAD_SECONDS,
  handoffsFor,
  type HandoffState,
} from "./handoffs.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  backTo,
  buttonLink,
  callout,
  empty,
  escapeHtml,
  externalLink,
  fold,
  gridRowList,
  icon,
  input,
  keyValues,
  layout,
  lookup,
  menu,
  pageHead,
  rowList,
  rowTitle,
  saveBar,
  section,
  segmented,
  select,
  statusText,
  tabs,
  textarea,
  when,
  type Crumb,
  type Row,
  type Shell,
} from "./html.js";
import { redirect, sendHtml, type Route, type RouteContext } from "./http.js";

/** How often Work, the task page, and the transcript reload, so they follow the factory. */
const RELOAD_SECONDS = 10;
const MAX_TITLE = 256;
const MAX_DETAILS = 10_000;
/** The longest note for the lead, and the longest reason to abandon. */
const MAX_NOTE = 2000;
/**
 * A browser counts `maxlength` in UTF-16 units, and form encoding sends one
 * unit as up to 9 bytes. Each form reads that much for its fields at their
 * limits, plus room for the rest, so a field within its limit is never cut off.
 */
const WORST_BYTES_PER_UNIT = 9;
const MAX_REQUEST_BYTES = WORST_BYTES_PER_UNIT * (MAX_TITLE + MAX_DETAILS) + 8 * 1024;
const MAX_NOTE_BYTES = WORST_BYTES_PER_UNIT * MAX_NOTE + 8 * 1024;
const DOT = ' <span aria-hidden="true">&middot;</span> ';

/** The board's lanes, in the order work moves through them: the task page's steps, then the two holds. */
const LANES = [
  "Implementing",
  "Reviewing",
  "Testing",
  "Merging",
  "Verifying",
  "Reverting",
  REPLANNING,
];

/** Factory projects in the config, plus any repo a task or issue names. */
export function projects(factory: FactoryPages, tasks: Task[], issues: TrackedIssue[]): string[] {
  const names = new Set(Object.keys(factory.store.current()?.document.projects ?? {}));
  for (const item of tasks) names.add(item.repo);
  for (const issue of issues) names.add(issue.repo);
  return [...names].sort();
}

function threadStatus(thread: StoredThread): string {
  if (isRunning(thread)) {
    return statusText("run", thread.status === "starting" ? "Starting" : "Running");
  }
  if (thread.status === "completed") return statusText("done", "Completed");
  if (thread.status === "unavailable") return statusText("off", "Unavailable");
  return statusText("bad", thread.status.replace("_", " "));
}

/** The details the pipeline records when it sends a task back to Implementing as one more round. */
const SENT_BACK: Record<string, string> = {
  [CHANGES_REQUESTED_DETAIL]: "Changes requested",
  [MERGE_CONFLICT_DETAIL]: "Merge conflict",
};

function isSentBack(event: TaskEvent): boolean {
  return event.kind === "stage:Implementing" && lookup(SENT_BACK, event.detail) !== undefined;
}

const EVENT_TITLES: Record<string, string> = {
  "escalated:lead": "Sent for replanning",
  "escalated:owner": NEEDS_DECISION,
  held: "Put on hold on the Hermes board",
  admitted: "Admitted",
  deferred: "Deferred by the lead",
  undeferred: "No longer deferred",
  "queue:moved": "Moved in the queue",
  error: "Error",
  waiting: "Waiting",
  "thread:implement": "Implement thread started",
  "thread:resume": "Implement thread resumed",
  "thread:review": "Review thread started",
  "limit:resumed": "Thread resumed after the usage limit",
  "limit:continued": "Thread continued after the usage limit",
  "merge-refused": "GitHub refused the merge",
  "foreign-merge": "Merged outside Hephaestus",
};

export function eventTitle(event: TaskEvent): string {
  if (isSentBack(event)) return "Sent back to Implementing";
  if (event.kind === "stage:Escalated") {
    return event.detail.startsWith("to the owner: ") ? NEEDS_DECISION : "Sent for replanning";
  }
  if (event.kind.startsWith("stage:")) {
    return `Moved to ${stageName(event.kind.slice("stage:".length))}`;
  }
  return lookup(EVENT_TITLES, event.kind) ?? event.kind;
}

export function isBad(event: TaskEvent): boolean {
  return (
    event.kind === "error" ||
    event.kind === "stage:Escalated" ||
    event.kind === "stage:Reverting" ||
    event.kind === "escalated:owner" ||
    isSentBack(event)
  );
}

/** What an event says on a page. An error's stored text can carry upstream output, so it is not shown. */
export function eventDetail(event: TaskEvent): string {
  if (event.kind === "error") return "A step failed; the service log has the error.";
  // The title already says where the escalation went.
  return event.kind === "stage:Escalated" ? escalationReason(event.detail) : event.detail;
}

function sha(value: string): string {
  return `<code title="${escapeHtml(value)}">${shortSha(value)}</code>`;
}

/** Text the pipeline recorded, as HTML, with each full commit SHA in the short form the page uses. */
function withShortShas(text: string): string {
  return escapeHtml(text).replace(/\b[0-9a-f]{40}\b/g, sha);
}

/** A task's events, newest first. */
function history(events: TaskEvent[], now: number): string {
  return `<ol class="tl">${[...events]
    .reverse()
    .map(
      (event) =>
        `<li${isBad(event) ? ' class="bad"' : ""}><span class="t">${when(event.at, now)}</span><div><strong>${escapeHtml(eventTitle(event))}</strong>${eventDetail(event) === "" ? "" : `<span class="d">${withShortShas(eventDetail(event))}</span>`}</div></li>`,
    )
    .join("")}</ol>`;
}

function isFinished(item: Task): boolean {
  return item.stage === "Done" || item.stage === "Abandoned";
}

function needsOwner(item: Task): boolean {
  return item.stage === "Escalated" && item.escalatedTo === "owner";
}

function isParked(item: Task): boolean {
  return item.stage === "Parked";
}

/** When a parked task comes back to the owner, and why it waits on them. */
function parkText(item: Task): string {
  const until =
    item.deferUntil === null
      ? "Comes back to you on the next pass"
      : `Comes back to you at ${utcMinute(Date.parse(item.deferUntil))}`;
  return item.reason === null ? until : `${until}: ${item.reason}`;
}

/** The re-alert times the park form offers, in hours, with a day first chosen. */
const PARK_HOURS: readonly (readonly [string, string])[] = [
  ["1", "In 1 hour"],
  ["4", "In 4 hours"],
  [String(DEFAULT_PARK_HOURS), "In 1 day"],
  ["72", "In 3 days"],
  ["168", "In 1 week"],
];

/** Admitted or queued: no thread has started for it yet. */
function waitingToStart(item: Task): boolean {
  return item.stage === "Admitted" || item.stage === "Queued";
}

/** 1st, 2nd, 3rd, 4th, ..., 11th, 12th, 13th, 21st. */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th");
  return `${String(n)}${suffix}`;
}

/** Why a deferred task waits, as the lead gave it. */
function deferText(item: Task): string {
  const until =
    item.deferAfter === null
      ? "Until a task finishes"
      : `Until task ${String(item.deferAfter)} is finished`;
  return `${until}: ${item.deferReason ?? ""}`;
}

/** Each queued task's place in the queue, 1 first. */
function queuePlaces(factory: FactoryPages): Map<number, number> {
  return new Map(factory.tasks.queue().map((item, index) => [item.id, index + 1]));
}

function times(count: number): string {
  return `${String(count)} ${count === 1 ? "time" : "times"}`;
}

type TabName = "needs" | "parked" | "queue" | "active" | "finished" | "all";

function tabHref(tab: TabName): string {
  return tab === "active" ? "/work" : `/work?tab=${tab}`;
}

/** The task list as rows in columns, each row a link to its task. */
function taskRows(items: Task[], lines: Map<number, string>, now: number, none: string): string {
  if (items.length === 0) return empty(none);
  return gridRows(items, (item) => item.waiting ?? lines.get(item.id) ?? "", now);
}

/**
 * The tasks waiting to start: the queue in the lead's order, then the
 * admitted tasks the lead has not queued or deferred, then the deferred ones.
 */
function queueSections(items: Task[], places: Map<number, number>, now: number): string {
  const queued = items
    .filter((item) => item.stage === "Queued")
    .sort((a, b) => (places.get(a.id) ?? 0) - (places.get(b.id) ?? 0));
  const admitted = items.filter((item) => item.stage === "Admitted").sort((a, b) => a.id - b.id);
  const untriaged = admitted.filter((item) => item.deferReason === null);
  const deferred = admitted.filter((item) => item.deferReason !== null);
  if (queued.length + admitted.length === 0) return empty("No task is waiting to start.");
  const part = (title: string, list: Task[], why: (item: Task) => string): string =>
    list.length === 0 ? "" : section({ title, count: list.length, body: gridRows(list, why, now) });
  return (
    part("Queued", queued, (item) => {
      const place = places.get(item.id);
      const where = place === undefined ? "" : `${ordinal(place)} in the queue`;
      return [where, item.waiting ?? ""].filter((text) => text !== "").join(". ");
    }) +
    part("Planning", untriaged, () => "Not queued or deferred yet") +
    part("Deferred", deferred, deferText)
  );
}

function gridRows(items: Task[], why: (item: Task) => string, now: number): string {
  return gridRowList(
    [
      { label: "Task" },
      { label: "Stage" },
      { label: "PR", className: "c-pr muted" },
      { label: "Updated", right: true, className: "muted" },
    ],
    items.map((item) => {
      const reason = why(item);
      return {
        href: `/work/${String(item.id)}`,
        cells: [
          rowTitle(
            taskLabel(item),
            `${escapeHtml(item.repo)}${reason === "" ? "" : `${DOT}${escapeHtml(reason)}`}`,
          ),
          stagePill(item),
          item.prNumber === null ? "-" : `#${String(item.prNumber)}`,
          when(item.updatedAt, now),
        ],
      };
    }),
  );
}

/**
 * The tasks in progress, in a lane for every stage. Empty lanes stay so the
 * board keeps one layout as tasks move through the pipeline.
 */
function board(items: Task[], lines: Map<number, string>): string {
  const laneOf = (item: Task): string =>
    item.stage === "Escalated" ? REPLANNING : taskStage(item);
  const lanes = LANES.map((lane) => {
    const inLane = items.filter((item) => laneOf(item) === lane);
    const tiles = inLane
      .map((item) => {
        const sub =
          item.waiting ??
          (lines.get(item.id) ||
            (item.stage === "Escalated" ? (item.reason ?? item.repo) : item.repo));
        return `<li><a class="tile" href="/work/${String(item.id)}"><span class="title">${escapeHtml(taskLabel(item))}</span><span class="subline">${escapeHtml(sub)}</span>${stagePill(item)}</a></li>`;
      })
      .join("");
    const content = tiles === "" ? '<p class="empty muted">No tasks</p>' : `<ul>${tiles}</ul>`;
    return `<section class="lane" aria-label="${lane}"><h2>${lane}<span class="n">${String(inLane.length)}</span></h2>${content}</section>`;
  });
  return `<div class="board" tabindex="0" role="region" aria-label="Tasks by stage">${lanes.join("")}</div>`;
}

/** The steps the task page shows. Testing and Merging are both the internal Merging stage. */
const STEPS = [
  "Admitted",
  "Queued",
  "Implementing",
  "Reviewing",
  "Testing",
  "Merging",
  "Verifying",
  "Done",
] as const;

/** Stages that hold a task where it left off, which the tracker shows at the stage before. */
const HOLDS: readonly Stage[] = ["Escalated", "Parked", "Abandoned"];

/**
 * The internal stage the task is at for the tracker. An escalated or
 * abandoned task is shown at the stage it left, which only its events record.
 */
function heldStage(item: Task, events: TaskEvent[] | undefined): Stage | undefined {
  if (!HOLDS.includes(item.stage)) return item.stage;
  if (events === undefined) return undefined;
  for (const event of [...events].reverse()) {
    if (!event.kind.startsWith("stage:")) continue;
    const stage = event.kind.slice("stage:".length) as Stage;
    if (!HOLDS.includes(stage)) return stage;
  }
  return "Admitted";
}

/**
 * Whether a task held at the merge gate got past its head commit's checks. An
 * abandoned task keeps the gate's last wait, and its reason says only why it
 * was abandoned; a task that escalated from the gate recorded why in that
 * event, which a note to the lead does not replace.
 */
function pastChecks(item: Task, events: TaskEvent[]): boolean {
  if (item.stage === "Merging") return checksPassedAtGate(item.waiting);
  const left = events.findLast(
    (event) => event.kind.startsWith("stage:") && event.kind !== "stage:Abandoned",
  );
  return left?.kind === "stage:Escalated"
    ? checksPassedAtGate(escalationReason(left.detail))
    : checksPassedAtGate(item.waiting);
}

function stepIndex(item: Task, held: Stage, events: TaskEvent[]): number {
  switch (held) {
    case "Admitted":
      return 0;
    case "Queued":
      return 1;
    case "Implementing":
      return 2;
    case "Reviewing":
      return 3;
    case "Merging":
      return pastChecks(item, events) ? 5 : 4;
    case "Done":
      return 7;
    default:
      // Validating, and Reverting, which undoes a merge that failed validation.
      return 6;
  }
}

/** The one-line stage tracker, and the name of the step the task is at. */
function tracker(item: Task, held: Stage, events: TaskEvent[]): { html: string; step: string } {
  const current = stepIndex(item, held, events);
  const finished = item.stage === "Done";
  const stopped = item.stage === "Abandoned";
  const holding =
    item.stage === "Escalated" ||
    item.stage === "Parked" ||
    item.stage === "Reverting" ||
    item.waiting !== null ||
    (item.stage === "Admitted" && item.deferReason !== null);
  const steps = STEPS.map((name, index) => {
    const done = finished && index === current;
    const state = done
      ? "done"
      : index < current
        ? "past"
        : index === current
          ? `now${stopped ? " stop" : holding ? " hold" : ""}`
          : "";
    const link =
      index === 0
        ? ""
        : index === 3 && item.rounds > 0
          ? `<span class="link loop" title="Sent back to Implementing ${times(item.rounds)}"><i></i>${icon("loop")}${String(item.rounds)}x<span class="sr-only"> sent back</span><i></i></span>`
          : '<span class="link"><i></i></span>';
    const mark =
      done || index < current
        ? `${icon("tick")}<span class="sr-only">Complete: </span>`
        : index === current
          ? stopped
            ? icon("x")
            : ""
          : '<span class="pip"></span>';
    return `<li class="${state}"${index === current && !done ? ' aria-current="step"' : ""}>${link}<span class="lbl">${mark}<span class="name">${name}</span></span></li>`;
  }).join("");
  return {
    html: `<ol class="track" aria-label="Stage">${steps}</ol>`,
    step: STEPS[current] ?? "",
  };
}

function elapsed(from: string, to: string): string {
  const minutes = Math.floor((Date.parse(to) - Date.parse(from)) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${String(minutes)}m` : `${String(hours)}h ${String(minutes % 60)}m`;
}

/** The line under the tracker: how the task ended, or that it has not started. */
function trackNote(item: Task, step: string, events: TaskEvent[], now: number): string {
  const sentBack = item.rounds > 0 ? `, sent back ${times(item.rounds)}` : "";
  if (item.stage === "Done") {
    const done = events.findLast((event) => event.kind === "stage:Done");
    const took =
      done === undefined || item.startedAt === null ? "" : elapsed(item.startedAt, done.at);
    const merged = item.foreignMerge
      ? "Merged outside Hephaestus"
      : item.mergeSha === null
        ? "Finished"
        : `Merged as ${sha(item.mergeSha)}`;
    return `<strong>Complete.</strong> ${merged}${done === undefined ? "" : ` ${when(done.at, now)}`}${took === "" ? "" : `, ${took} after it started`}${sentBack}.`;
  }
  if (item.stage === "Abandoned") {
    return `<strong>Stopped at ${step}.</strong>${item.mergeSha === null ? " Nothing was merged." : ""}`;
  }
  // A task under way gets no line: its review comments and Attempts already show any send-back.
  return step === "Admitted" || step === "Queued" ? "Not started." : "";
}

function noteLine(note: string): string {
  return note === "" ? "" : `<p class="track-note">${note}</p>`;
}

/**
 * The attempts of the current run: one for each time the task was sent back,
 * read from its events, and the one in progress. The count restarts where the
 * pipeline restarts it, when the lead restarts the work or a revert merges.
 */
function attempts(item: Task, events: TaskEvent[], now: number): string {
  if (item.rounds === 0) return "";
  const sentBack = events.filter(isSentBack).slice(-item.rounds);
  const rows = sentBack.map((event, index) => ({
    title: `Attempt ${String(index + 1)}`,
    sub: `${when(event.at, now)}${DOT}${withShortShas(event.detail)}`,
    aside: statusText("back", lookup(SENT_BACK, event.detail) ?? "Sent back"),
  }));
  const max = item.policy?.maxReviewRounds;
  return section({
    title: "Attempts",
    count: sentBack.length + 1,
    right:
      max === undefined
        ? undefined
        : `<span class="muted">sent back ${String(item.rounds)} of ${String(max)} allowed</span>`,
    body: rowList([
      ...rows,
      { title: `Attempt ${String(sentBack.length + 1)}`, aside: stagePill(item) },
    ]),
  });
}

function other(provider: "claude" | "codex"): "claude" | "codex" {
  return provider === "claude" ? "codex" : "claude";
}

function checkName(id: string): string {
  return id.replace(/^(?:check|status):/, "");
}

/**
/**
 * How the checks on the current merge commit ended. A task keeps its revert
 * PR after the work merges again, so an earlier rollback says nothing about
 * this merge: only what was recorded since the task last began validating does.
 */
function checksAfterMerge(item: Task, events: TaskEvent[]): string {
  if (item.foreignMerge) return statusText("off", "Not checked");
  if (item.mergeSha === null) return statusText("off", "Not started");
  if (item.stage === "Done") return statusText("done", "Passed");
  if (item.stage === "Validating") return statusText("run", "Running");
  const since = events.slice(events.findLastIndex((event) => event.kind === "stage:Validating"));
  const failed =
    item.reverting ||
    since.some(
      (event) =>
        event.kind === "stage:Reverting" ||
        (event.kind === "stage:Escalated" &&
          escalationReason(event.detail).startsWith(VALIDATION_FAILED)),
    );
  return failed ? statusText("bad", "Failed") : statusText("off", "Not finished");
}

/**
 * What Hephaestus holds as proof for the head commit: whether the other
 * provider approved it, and how the merge commit's checks ended. It stores no
 * result for single checks and no list of the implementer's evidence files,
 * so the page shows neither.
 */
function proof(item: Task, approved: Read<boolean>, events: TaskEvent[]): string {
  if (item.prNumber === null || item.headSha === null) return "";
  const reviewNote =
    item.policy?.requireReview === false
      ? "This project's policy merges without a review."
      : item.implementer === null
        ? ""
        : `${providerName(`hephaestus-${other(item.implementer)}`)} reviews what ${providerName(`hephaestus-${item.implementer}`)} wrote.`;
  const review = !approved.ok
    ? undefined
    : approved.value
      ? statusText("done", "Approved")
      : item.stage === "Reviewing" && item.reviewThread !== null
        ? statusText("run", "In review")
        : statusText("off", "No approval at this commit");
  const names = (item.expectedChecks ?? []).map(checkName);
  const after = checksAfterMerge(item, events);
  const afterNote = item.foreignMerge
    ? "The PR was merged outside Hephaestus, which does not check such a merge."
    : item.mergeSha === null
      ? ""
      : `On merge commit ${sha(item.mergeSha)}${names.length === 0 ? "" : `: ${escapeHtml(names.join(", "))}`}.`;
  return section({
    title: "Proof",
    right: `<span class="muted">for head ${sha(item.headSha)}</span>`,
    body: rowList([
      { title: "Review by the other provider", sub: escapeHtml(reviewNote), aside: review },
      { title: "Checks after the merge", sub: afterNote, aside: after },
    ]),
  });
}

/** The callout under the tracker: what the task waits on, and the owner's actions when it waits on them. */
function taskCallout(
  item: Task,
  back: string,
  place: number | undefined,
  handoff: HandoffState | undefined,
): string {
  const id = String(item.id);
  const reason = withShortShas(item.reason ?? "");
  if (needsOwner(item)) {
    const actions = taskActions(item);
    const failed = handoffFailedText(handoff);
    return callout(
      "warn",
      NEEDS_DECISION,
      failed === "" ? reason : `${reason}<br>${failed}`,
      handoff === "sending"
        ? statusText("run", "Sending to lead")
        : `${mergeButton(item, back)}${actions.sendToLead ? buttonLink(formHref(`/work/${id}/lead`, back), "Send to lead") : ""}${actions.park ? buttonLink(formHref(`/work/${id}/park`, back), "Park") : ""}${actions.abandon ? buttonLink(formHref(`/work/${id}/abandon`, back), "Abandon", { variant: "danger" }) : ""}`,
    );
  }
  if (isParked(item)) {
    return callout(
      "info",
      "Parked",
      withShortShas(parkText(item)),
      `${buttonLink(formHref(`/work/${id}/unpark`, back), "Resume", { variant: "primary" })}${buttonLink(formHref(`/work/${id}/abandon`, back), "Abandon", { variant: "danger" })}`,
    );
  }
  if (item.stage === "Escalated") return callout("info", REPLANNING, reason);
  if (item.stage === "Abandoned") return callout("info", "Abandoned", reason);
  if (item.stage === "Admitted" && item.deferReason !== null) {
    return callout("info", "Deferred", escapeHtml(deferText(item)));
  }
  if (item.stage === "Queued") {
    const where = place === undefined ? "In the queue." : `${ordinal(place)} in the queue.`;
    return callout(
      "info",
      "Queued",
      `${where}${item.waiting === null ? "" : ` ${withShortShas(item.waiting)}`}`,
    );
  }
  if (item.waiting !== null) return callout("info", "Waiting", withShortShas(item.waiting));
  return "";
}

/** Each worker's label by its environment ID. A worker with no label on record keeps its ID. */
function workerLabels(factory: FactoryPages): Map<string, string> {
  const workers = read("workers", () => factory.workers?.views() ?? []);
  return new Map((workers.ok ? workers.value : []).map((view) => [view.environmentId, view.label]));
}

function details(item: Task, labels: Map<string, string>, now: number): string {
  const head = item.headSha === null ? "" : ` at ${sha(item.headSha)}`;
  const main: [string, string][] = [
    [
      "Pull request",
      item.prNumber === null
        ? '<span class="muted">None yet</span>'
        : // While a task reverts, its head is the revert PR's.
          `${externalLink(prUrl(item.repo, item.prNumber), `#${String(item.prNumber)}`)}${item.reverting ? "" : head}`,
    ],
  ];
  if (item.revertPr !== null) {
    main.push([
      "Revert PR",
      `${externalLink(prUrl(item.repo, item.revertPr), `#${String(item.revertPr)}`)}${item.reverting ? head : ""}`,
    ]);
  }
  if (item.issueNumber !== null) {
    main.push([
      "Issue",
      externalLink(issueUrl(item.repo, item.issueNumber), `#${String(item.issueNumber)}`),
    ]);
  }
  main.push([
    "Worker",
    escapeHtml(
      item.workerEnv === null ? "Not chosen" : (labels.get(item.workerEnv) ?? item.workerEnv),
    ),
  ]);
  if (item.mergeSha !== null) {
    main.push([
      "Merge commit",
      `${sha(item.mergeSha)}${item.foreignMerge ? ", merged outside Hephaestus" : ""}`,
    ]);
  }
  const more: [string, string][] = [
    ["Branch", item.branch === null ? "-" : `<code>${escapeHtml(item.branch)}</code>`],
    [
      "Implementer",
      item.implementer === null ? "-" : escapeHtml(providerName(`hephaestus-${item.implementer}`)),
    ],
    ["Started", item.startedAt === null ? "-" : when(item.startedAt, now)],
    ["Updated", when(item.updatedAt, now)],
  ];
  return `<div style="padding:16px 8px 0">${keyValues(main)}${fold("More details", keyValues(more))}${
    item.brief === null
      ? ""
      : fold("The lead's brief", `<pre class="block">${escapeHtml(item.brief)}</pre>`)
  }</div>`;
}

function taskCrumbs(id: number, last?: string): Crumb[] {
  return last === undefined
    ? [["Work", "/work"], [`Task ${String(id)}`]]
    : [["Work", "/work"], [`Task ${String(id)}`, `/work/${String(id)}`], [last]];
}

interface FormPage {
  title: string;
  crumbs: readonly Crumb[];
  /** Safe HTML at the top of the form. */
  intro: string;
  action: string;
  fields: Record<string, string>;
  /** Safe HTML: the form's fields. */
  body: string;
  submit: string;
  danger?: boolean;
  back: string;
  /** Safe HTML: why the form was not accepted, when it is not one field's fault. */
  problem?: string;
}

/** A form on a page of its own, which does not reload, so typed text is kept until it is sent. */
function formPage(shell: Shell | undefined, options: FormPage): string {
  const hidden = Object.entries({ ...options.fields, back: options.back })
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("");
  return layout(
    options.title,
    `${pageHead({ title: options.title })}${options.problem ?? ""}<form class="form" method="post" action="${escapeHtml(options.action)}">${hidden}${options.intro}${options.body}${saveBar(
      `<button type="submit" class="${options.danger === true ? "danger solid" : "primary"}">${escapeHtml(options.submit)}</button><a href="${escapeHtml(options.back)}">Cancel</a>`,
    )}</form>`,
    { section: "/work", shell, crumbs: options.crumbs },
  );
}

/** A page that says a form cannot be used, with the way back. */
function noFormPage(
  shell: Shell | undefined,
  title: string,
  crumbs: readonly Crumb[],
  html: string,
): string {
  return layout(title, `${pageHead({ title })}${html}`, { section: "/work", shell, crumbs });
}

/**
 * What was typed in a text field, trimmed, with a browser's line ends turned
 * back into newlines: it counts a line break as one character against
 * `maxlength` and sends two.
 */
function typedText(value: string | null): string {
  return (value ?? "").replace(/\r\n?/g, "\n").trim();
}

interface RequestValues {
  repo: string;
  title: string;
  body: string;
}

/** The task a form page acts on, or nothing after the page for a missing or unreadable one was sent. */
function taskFor(factory: FactoryPages, context: RouteContext, title: string): Task | undefined {
  const id = Number(context.params[0]);
  const found = read("the task", () => factory.tasks.find(id));
  if (found.ok && found.value !== undefined) return found.value;
  sendHtml(
    context.response,
    found.ok ? 404 : 503,
    noFormPage(
      context.shell,
      found.ok ? "No such task" : title,
      [["Work", "/work"], [found.ok ? "Not found" : title]],
      found.ok ? empty('This task does not exist. <a href="/work">Back to Work</a>') : STORE_ERROR,
    ),
  );
  return undefined;
}

export function workRoutes(factory: FactoryPages): Route[] {
  const now = factory.now ?? Date.now;

  // Intake works from the deployed version, so only its projects can take a request.
  const requestRepos = (): Read<{ repos: string[]; deployed: boolean }> =>
    read("config", () => {
      const version = factory.store.list().find((item) => item.state === "deployed");
      return {
        repos: Object.keys(version?.document.projects ?? {}).sort(),
        deployed: version !== undefined,
      };
    });

  const requestPage = (
    shell: Shell | undefined,
    back: string,
    values: RequestValues,
    errors: { repo?: string; title?: string; body?: string; problem?: string } = {},
  ): string => {
    const crumbs: Crumb[] = [["Work", "/work"], ["Request work"]];
    const config = requestRepos();
    if (!config.ok) return noFormPage(shell, "Request work", crumbs, STORE_ERROR);
    const { repos, deployed } = config.value;
    if (repos.length === 0) {
      return noFormPage(
        shell,
        "Request work",
        crumbs,
        empty(
          deployed
            ? 'No project can take a request yet. Add one on <a href="/projects">Projects</a> first.'
            : 'No config version is deployed yet. Deploy one on <a href="/config">Config</a> first.',
        ),
      );
    }
    return formPage(shell, {
      title: "Request work",
      crumbs,
      intro: "",
      action: "/work/issues/file",
      fields: {},
      body: `${select(
        "repo",
        "Project",
        repos.map((repo): [string, string] => [repo, repo]),
        repos.includes(values.repo) ? values.repo : (repos[0] ?? ""),
        { error: errors.repo },
      )}${input("title", "What to do", {
        value: values.title,
        maxlength: MAX_TITLE,
        autofocus: true,
        hint: "The issue title.",
        error: errors.title,
      })}${textarea("body", "Details (optional)", {
        value: values.body,
        rows: 6,
        maxlength: MAX_DETAILS,
        required: false,
        error: errors.body,
        hint: "What done looks like.",
      })}`,
      submit: "File the issue",
      back,
      ...(errors.problem === undefined ? {} : { problem: errors.problem }),
    });
  };

  /**
   * Hands an escalated task back to the lead for the owner. The handoff waits
   * for the task's turn and for the Hermes board, so the request waits only a
   * moment for it: one that ends by then says how, and a slower one goes on in
   * the background while the pages show the task as sending. A form for a task
   * that no longer waits for the owner, or from before the task changed, is
   * refused at once, without waiting behind another step on the task.
   */
  const sendToLead = async (id: number, note: string, version: string): Promise<NoticeKey> => {
    const task = read("the task", () => factory.tasks.find(id));
    if (
      !task.ok ||
      task.value === undefined ||
      !taskActions(task.value).sendToLead ||
      version !== String(task.value.version)
    ) {
      return "send-failed";
    }
    const handoffs = handoffsFor(factory.pipeline);
    const ended = await Promise.race([
      handoffs.start(id, note, version),
      delay(factory.sendWaitMs ?? SEND_WAIT_MS),
    ]);
    if (ended === undefined) return "sending-to-lead";
    if (ended.ok) return "sent-to-lead";
    // A failure the notice reports needs no second word on the task.
    handoffs.forget(id);
    return ended.error instanceof MergeSettledError
      ? failureNotice(ended.error, "send-failed")
      : "send-failed";
  };

  const leadPage = (
    shell: Shell | undefined,
    item: Task,
    back: string,
    error?: string,
    typed = "",
  ): string => {
    const id = String(item.id);
    const crumbs = taskCrumbs(item.id, "Send to lead");
    if (handoffsFor(factory.pipeline).state(item) === "sending") {
      return noFormPage(
        shell,
        "Send to lead",
        crumbs,
        callout(
          "info",
          "Sending to the lead",
          `Your note is on its way to the lead. <a href="/work/${id}">Back to the task</a>`,
        ),
      );
    }
    if (!taskActions(item).sendToLead) {
      return noFormPage(
        shell,
        "Send to lead",
        crumbs,
        callout(
          "info",
          "This task is not waiting for you",
          `Only a task that waits for you can go to the lead, and one that reverts a merge stays with you. <a href="/work/${id}">Back to the task</a>`,
        ),
      );
    }
    return formPage(shell, {
      title: "Send to lead",
      crumbs,
      intro: `<p class="muted">${escapeHtml(taskLabel(item))}</p>`,
      action: `/work/${id}/send-to-lead`,
      fields: { version: String(item.version) },
      body: textarea("note", "Note for the lead", {
        value: typed,
        rows: 4,
        maxlength: MAX_NOTE,
        autofocus: true,
        error,
      }),
      submit: "Send to lead",
      back,
    });
  };

  const parkPage = (
    shell: Shell | undefined,
    item: Task,
    back: string,
    typed: { hours?: string; note?: string } = {},
    errors: { hours?: string; note?: string } = {},
  ): string => {
    const id = String(item.id);
    const crumbs = taskCrumbs(item.id, "Park");
    const refused = parkRefusal(item);
    if (refused !== undefined) {
      return noFormPage(
        shell,
        "Park task",
        crumbs,
        callout(
          "info",
          "This task cannot be parked",
          `${escapeHtml(refused)} <a href="/work/${id}">Back to the task</a>`,
        ),
      );
    }
    return formPage(shell, {
      title: "Park task",
      crumbs,
      intro: `<p class="muted">${escapeHtml(taskLabel(item))}</p><p>It waits under Parked and frees its worker. Its branch and PR stay. When its time is up, it comes back to you with the same reason: ${escapeHtml(item.reason ?? "")}</p>`,
      action: `/work/${id}/park`,
      fields: { version: String(item.version) },
      body: `${select("hours", "Alert me again", PARK_HOURS, typed.hours ?? String(DEFAULT_PARK_HOURS), { error: errors.hours })}${textarea(
        "note",
        "Note (optional)",
        {
          value: typed.note ?? "",
          rows: 3,
          maxlength: MAX_NOTE,
          required: false,
          error: errors.note,
        },
      )}`,
      submit: "Park task",
      back,
    });
  };

  const unparkPage = (
    shell: Shell | undefined,
    item: Task,
    back: string,
    error?: string,
    typed = "",
  ): string => {
    const id = String(item.id);
    const crumbs = taskCrumbs(item.id, "Resume");
    if (!taskActions(item).unpark) {
      return noFormPage(
        shell,
        "Resume task",
        crumbs,
        callout("info", "This task is not parked", `<a href="/work/${id}">Back to the task</a>`),
      );
    }
    return formPage(shell, {
      title: "Resume task",
      crumbs,
      intro: `<p class="muted">${escapeHtml(taskLabel(item))}</p><p>${escapeHtml(item.reason ?? "")}</p>`,
      action: `/work/${id}/unpark`,
      fields: { version: String(item.version) },
      body: textarea("answer", "Your answer", {
        value: typed,
        rows: 4,
        maxlength: MAX_NOTE,
        autofocus: true,
        hint: "Started work resumes on its branch. Otherwise the task is queued again.",
        error,
      }),
      submit: "Resume task",
      back,
    });
  };

  const abandonPage = (
    shell: Shell | undefined,
    item: Task,
    back: string,
    error?: string,
    typed = "",
  ): string => {
    const id = String(item.id);
    const crumbs = taskCrumbs(item.id, "Abandon");
    if (!taskActions(item).abandon) {
      return noFormPage(
        shell,
        "Abandon task",
        crumbs,
        callout(
          "info",
          "This task can no longer be abandoned",
          `Its stage does not allow it. <a href="/work/${id}">Back to the task</a>`,
        ),
      );
    }
    return formPage(shell, {
      title: "Abandon task",
      crumbs,
      intro: `<p class="muted">${escapeHtml(taskLabel(item))}</p><p>No more threads start for it. The PR and the issue stay as they are.</p>`,
      action: `/work/${id}/abandon`,
      fields: { version: String(item.version) },
      body: input("reason", "Why abandon it", {
        value: typed,
        maxlength: MAX_NOTE,
        autofocus: true,
        error,
      }),
      submit: "Abandon task",
      danger: true,
      back,
    });
  };

  return [
    {
      method: "GET",
      path: /^\/work$/,
      handle: ({ response, url, shell }) => {
        const project = shell?.project;
        const requested = url.searchParams.get("tab");
        const tab: TabName =
          requested === "needs" ||
          requested === "parked" ||
          requested === "queue" ||
          requested === "finished" ||
          requested === "all"
            ? requested
            : "active";
        const boardView = tab === "active" && url.searchParams.get("view") === "board";
        const back = here(url);
        const inProject = (item: { repo: string }): boolean =>
          project === undefined || item.repo === project;

        const tasks = read("tasks", () => factory.tasks.list().filter(inProject));
        const issues = read("issues", () => factory.intake.issues().filter(inProject));
        const all = tasks.ok ? tasks.value : [];
        const mine = all.filter(needsOwner);
        const upcoming = all.filter(waitingToStart);
        const parked = all.filter(isParked);
        const active = all.filter(
          (item) =>
            !isFinished(item) && !needsOwner(item) && !waitingToStart(item) && !isParked(item),
        );
        const finished = all.filter(isFinished);
        const waiting = (issues.ok ? issues.value : []).filter(
          (issue) =>
            !issue.closed && (issue.state === "awaiting-owner" || issue.state === "held-cap"),
        );
        const rejected = (issues.ok ? issues.value : []).filter(
          (issue) => issue.state === "rejected",
        );
        let failed = !tasks.ok || !issues.ok;

        // Only a task in progress can have a running thread, so only those are looked up.
        const lines = new Map<number, string>();
        if (tab === "active" || tab === "all") {
          const workers = read("workers", () => factory.workers?.views() ?? []);
          const labels = new Map(
            (workers.ok ? workers.value : []).map((view) => [view.environmentId, view.label]),
          );
          const threads = read("threads", () => {
            for (const item of active) {
              const line = runningThreads(factory.events.forTask(item.id), labels).join("; ");
              if (line !== "") lines.set(item.id, line);
            }
          });
          failed ||= !workers.ok || !threads.ok;
        }

        let body: string;
        if (tab === "needs") {
          const handoffs = handoffsFor(factory.pipeline);
          const owned = mine.map((item): Row => {
            const handoff = handoffs.state(item);
            const failed = handoffFailedText(handoff);
            return {
              kind: item.ownerAction === null ? "task" : "merge",
              title: taskLabel(item),
              href: `/work/${String(item.id)}`,
              sub: `${escapeHtml(item.reason ?? "")}${failed === "" ? "" : `<br>${failed}`}`,
              aside: escalationActions(item, back, handoff),
            };
          });
          const admissions = admissionsFor(factory.intake);
          const held = waiting.map((issue) =>
            heldIssueRow(issue, back, admissions.state(issue.repo, issue.number)),
          );
          const rows = [...owned, ...held];
          body =
            (rows.length === 0
              ? failed
                ? empty("What needs you could not be read.")
                : `<p class="calm">${icon("ok", "t-done")}No task or issue is waiting for you.</p>`
              : rowList(rows)) +
            (rejected.length === 0
              ? ""
              : fold(
                  `Rejected issues (${String(rejected.length)})`,
                  `<ul class="rows">${rejected
                    .map(
                      (issue) =>
                        `<li class="row"><div class="main"><span class="title">${externalLink(issueUrl(issue.repo, issue.number), `#${String(issue.number)} ${issue.title}`)}</span><span class="subline">${escapeHtml(issue.repo)}</span></div><div class="aside">${statusText("off", "Rejected")}</div></li>`,
                    )
                    .join("")}</ul>`,
                ));
        } else if (!tasks.ok) {
          body = empty("Tasks could not be read.");
        } else if (tab === "parked") {
          body =
            parked.length === 0
              ? empty("No parked tasks.")
              : gridRows(
                  [...parked].sort((a, b) =>
                    (a.deferUntil ?? "").localeCompare(b.deferUntil ?? ""),
                  ),
                  parkText,
                  now(),
                );
        } else if (tab === "queue") {
          const places = read("the queue", () => queuePlaces(factory));
          failed ||= !places.ok;
          body = queueSections(
            upcoming,
            places.ok ? places.value : new Map<number, number>(),
            now(),
          );
        } else if (tab === "active") {
          const running = read("running threads", () => factory.pipeline.runningThreads());
          const blocked = read("the thread caps", () => factory.pipeline.blockedBecause(undefined));
          const limits = read(
            "the deployed config",
            () =>
              factory.store.list().find((version) => version.state === "deployed")?.document.factory
                .limits,
          );
          failed ||= !running.ok || !blocked.ok || !limits.ok;
          const capacity: string[] = [];
          if (running.ok) {
            capacity.push(
              limits.ok && limits.value !== undefined
                ? `${String(running.value)} of ${String(limits.value.threads)} threads running`
                : `${String(running.value)} ${running.value === 1 ? "thread" : "threads"} running`,
            );
          }
          const why =
            blocked.ok && blocked.value !== undefined
              ? callout("warn", "No thread starts now", escapeHtml(blocked.value))
              : "";
          body = `<div class="bar"><p class="muted">${capacity.join(DOT)}</p>${segmented("Layout", [
            { href: "/work", label: "List", current: !boardView },
            { href: "/work?view=board", label: "Board", current: boardView },
          ])}</div>${why}${
            boardView
              ? board(active, lines)
              : taskRows(
                  active,
                  lines,
                  now(),
                  all.length === 0
                    ? "No tasks yet. Request work to file the first one."
                    : "No task is in progress.",
                )
          }`;
        } else {
          body = taskRows(
            tab === "finished" ? finished : all,
            lines,
            now(),
            all.length === 0
              ? "No tasks yet. Request work to file the first one."
              : "No task has finished yet.",
          );
        }

        sendHtml(
          response,
          200,
          layout(
            "Work",
            `${pageHead({
              title: "Work",
              actions: buttonLink(formHref("/work/new", back), "Request work", {
                variant: "primary",
              }),
            })}${notice(url)}${failed ? STORE_ERROR : ""}${tabs([
              {
                href: tabHref("needs"),
                label: "Needs you",
                count: mine.length + waiting.length,
                current: tab === "needs",
              },
              {
                href: tabHref("parked"),
                label: "Parked",
                count: parked.length,
                current: tab === "parked",
              },
              {
                href: tabHref("queue"),
                label: "Queue",
                count: upcoming.length,
                current: tab === "queue",
              },
              {
                href: tabHref("active"),
                label: "In progress",
                count: active.length,
                current: tab === "active",
              },
              {
                href: tabHref("finished"),
                label: "Finished",
                count: finished.length,
                current: tab === "finished",
              },
              { href: tabHref("all"), label: "All", current: tab === "all" },
            ])}${body}`,
            {
              section: "/work",
              shell,
              refreshSeconds: admissionsFor(factory.intake).busy()
                ? ADMITTING_RELOAD_SECONDS
                : handoffsFor(factory.pipeline).busy()
                  ? SENDING_RELOAD_SECONDS
                  : RELOAD_SECONDS,
            },
          ),
        );
      },
    },
    {
      method: "GET",
      path: /^\/work\/new$/,
      handle: ({ response, url, shell }) => {
        sendHtml(
          response,
          200,
          requestPage(shell, backTo(url.searchParams.get("back"), "/work"), {
            repo: shell?.project ?? "",
            title: "",
            body: "",
          }),
        );
      },
    },
    {
      method: "POST",
      path: /^\/work\/issues\/file$/,
      handle: async (context) => {
        const fields = await form(context, MAX_REQUEST_BYTES);
        if (fields === undefined) {
          // Nothing of an unread body can be shown again, so the form comes back empty and says why.
          sendHtml(
            context.response,
            413,
            requestPage(
              context.shell,
              "/work",
              { repo: context.shell?.project ?? "", title: "", body: "" },
              {
                problem: callout(
                  "err",
                  "The request is too long",
                  `Nothing was filed. The title takes ${String(MAX_TITLE)} characters and the details ${String(MAX_DETAILS)}. Go back in your browser to shorten what you typed.`,
                ),
              },
            ),
          );
          return;
        }
        const back = backTo(fields.get("back"), "/work");
        const values: RequestValues = {
          repo: fields.get("repo") ?? "",
          title: (fields.get("title") ?? "").trim(),
          body: typedText(fields.get("body")),
        };
        const config = requestRepos();
        const errors: { repo?: string; title?: string; body?: string } = {};
        if (config.ok && !config.value.repos.includes(values.repo)) {
          errors.repo = "Choose one of the factory's projects.";
        }
        if (values.title === "") errors.title = "Say what to do.";
        else if (values.title.length > MAX_TITLE) {
          errors.title = `The title has ${String(values.title.length)} characters. GitHub allows ${String(MAX_TITLE)} characters.`;
        }
        if (values.body.length > MAX_DETAILS) {
          errors.body = `The details have ${String(values.body.length)} characters. The form takes ${String(MAX_DETAILS)}.`;
        }
        if (!config.ok || Object.keys(errors).length > 0) {
          sendHtml(
            context.response,
            config.ok ? 422 : 503,
            requestPage(context.shell, back, values, errors),
          );
          return;
        }
        let key: NoticeKey;
        try {
          // Filed as the owner's request: factory-filed, so it is admitted unless the cap is reached.
          const issue = await factory.intake.fileIssue(
            "owner",
            values.repo,
            values.title,
            values.body,
          );
          key =
            issue.state === "admitted"
              ? "issue-filed"
              : issue.state === "held-cap"
                ? "issue-held"
                : "issue-waiting";
        } catch (error) {
          console.error("Filing an issue from the dashboard failed", error);
          sendHtml(
            context.response,
            502,
            requestPage(context.shell, back, values, {
              problem: callout(
                "err",
                "The issue was not filed",
                "GitHub refused the issue, or the project was removed meanwhile. The service log has the error. What you typed is still here.",
              ),
            }),
          );
          return;
        }
        redirect(context.response, withNotice(back, key));
      },
    },
    {
      method: "GET",
      path: /^\/work\/(\d+)\/(lead|abandon)$/,
      handle: (context) => {
        const lead = context.params[1] === "lead";
        const item = taskFor(factory, context, lead ? "Send to lead" : "Abandon task");
        if (item === undefined) return;
        const back = backTo(context.url.searchParams.get("back"), `/work/${String(item.id)}`);
        sendHtml(
          context.response,
          200,
          lead ? leadPage(context.shell, item, back) : abandonPage(context.shell, item, back),
        );
      },
    },
    {
      method: "GET",
      path: /^\/work\/(\d+)\/(park|unpark)$/,
      handle: (context) => {
        const park = context.params[1] === "park";
        const item = taskFor(factory, context, park ? "Park task" : "Resume task");
        if (item === undefined) return;
        const back = backTo(context.url.searchParams.get("back"), `/work/${String(item.id)}`);
        sendHtml(
          context.response,
          200,
          park ? parkPage(context.shell, item, back) : unparkPage(context.shell, item, back),
        );
      },
    },
    {
      method: "POST",
      path: /^\/work\/(\d+)\/park$/,
      handle: async (context) => {
        const id = Number(context.params[0]);
        const fields = await form(context, MAX_NOTE_BYTES);
        const back = backTo(fields?.get("back") ?? null, `/work/${String(id)}`);
        const hours = (fields?.get("hours") ?? "").trim();
        const note = typedText(fields?.get("note") ?? null);
        const version = (fields?.get("version") ?? "").trim();
        const errors: { hours?: string; note?: string } = {};
        if (fields === undefined || note.length > MAX_NOTE) {
          errors.note = `The note is too long. It takes ${String(MAX_NOTE)} characters.`;
        }
        if (!PARK_HOURS.some(([value]) => value === hours)) {
          errors.hours = "Choose when to be alerted again.";
        }
        if (Object.keys(errors).length > 0) {
          const item = taskFor(factory, context, "Park task");
          if (item === undefined) return;
          sendHtml(
            context.response,
            fields === undefined ? 413 : 422,
            parkPage(context.shell, item, back, { hours, note }, errors),
          );
          return;
        }
        let key: NoticeKey = "parked";
        try {
          if (version === "") throw new Error("The version is empty.");
          await factory.pipeline.park(id, { hours: Number(hours), note, version });
        } catch (error) {
          console.error(`Parking task ${String(id)} from the dashboard failed`, error);
          key = "park-failed";
        }
        redirect(context.response, withNotice(back, key));
      },
    },
    {
      method: "POST",
      path: /^\/work\/(\d+)\/unpark$/,
      handle: async (context) => {
        const id = Number(context.params[0]);
        const fields = await form(context, MAX_NOTE_BYTES);
        const back = backTo(fields?.get("back") ?? null, `/work/${String(id)}`);
        const typed = typedText(fields?.get("answer") ?? null);
        const version = (fields?.get("version") ?? "").trim();
        const problem =
          fields === undefined || typed.length > MAX_NOTE
            ? `The answer is too long. It takes ${String(MAX_NOTE)} characters.`
            : typed === ""
              ? "Give your answer, so the work can go on with it."
              : undefined;
        if (problem !== undefined) {
          const item = taskFor(factory, context, "Resume task");
          if (item === undefined) return;
          sendHtml(
            context.response,
            fields === undefined ? 413 : 422,
            unparkPage(context.shell, item, back, problem, typed),
          );
          return;
        }
        let key: NoticeKey = "unparked";
        try {
          if (version === "") throw new Error("The version is empty.");
          await factory.pipeline.unpark(id, typed, version);
        } catch (error) {
          key = failureNotice(error, "unpark-failed");
        }
        redirect(context.response, withNotice(back, key));
      },
    },
    {
      method: "POST",
      path: /^\/work\/(\d+)\/(send-to-lead|abandon)$/,
      handle: async (context) => {
        const id = Number(context.params[0]);
        const lead = context.params[1] === "send-to-lead";
        const fields = await form(context, MAX_NOTE_BYTES);
        const back = backTo(fields?.get("back") ?? null, `/work/${String(id)}`);
        const typed = typedText(fields?.get(lead ? "note" : "reason") ?? null);
        const version = (fields?.get("version") ?? "").trim();
        const limit = `It takes ${String(MAX_NOTE)} characters.`;
        const problem =
          fields === undefined || typed.length > MAX_NOTE
            ? lead
              ? `The note is too long. ${limit}`
              : `The reason is too long. ${limit}`
            : typed !== ""
              ? undefined
              : lead
                ? "Write a note for the lead."
                : "Say why you abandon it.";
        if (problem !== undefined) {
          const item = taskFor(factory, context, lead ? "Send to lead" : "Abandon task");
          if (item === undefined) return;
          sendHtml(
            context.response,
            fields === undefined ? 413 : 422,
            lead
              ? leadPage(context.shell, item, back, problem, typed)
              : abandonPage(context.shell, item, back, problem, typed),
          );
          return;
        }
        if (lead) {
          redirect(context.response, withNotice(back, await sendToLead(id, typed, version)));
          return;
        }
        let key: NoticeKey = "abandoned";
        try {
          if (version === "") throw new Error("The version is empty.");
          await factory.pipeline.abandon(id, `The owner abandoned it: ${typed}`, version);
        } catch (error) {
          key = failureNotice(error, "abandon-failed");
        }
        redirect(context.response, withNotice(back, key));
      },
    },
    {
      method: "GET",
      path: /^\/work\/(\d+)$/,
      handle: ({ response, url, params, shell }) => {
        const id = Number(params[0]);
        const found = read("the task", () => factory.tasks.find(id));
        if (!found.ok) {
          sendHtml(
            response,
            503,
            layout("Task", `${pageHead({ title: "Task" })}${STORE_ERROR}`, {
              section: "/work",
              shell,
              crumbs: taskCrumbs(id),
            }),
          );
          return;
        }
        const item = found.value;
        if (item === undefined) {
          sendHtml(
            response,
            404,
            layout(
              "No such task",
              `${pageHead({ title: "No such task" })}${empty('This task does not exist. <a href="/work">Back to Work</a>')}`,
              { section: "/work", shell, crumbs: [["Work", "/work"], ["Not found"]] },
            ),
          );
          return;
        }
        const events = read("task events", () => factory.tasks.events(id));
        const threads = read("task threads", () => factory.events.forTask(id));
        const approved = read("the review", () =>
          item.headSha === null ? false : factory.tasks.approvedAt(id, item.headSha),
        );
        const labels = workerLabels(factory);
        const back = `/work/${String(id)}`;
        const places =
          item.stage === "Queued" ? read("the queue", () => queuePlaces(factory)) : undefined;
        const place = places?.ok === true ? places.value.get(id) : undefined;
        const held = heldStage(item, events.ok ? events.value : undefined);
        const track =
          held === undefined ? undefined : tracker(item, held, events.ok ? events.value : []);
        const actions = taskActions(item);
        const handoffs = handoffsFor(factory.pipeline);

        const threadRows = !threads.ok
          ? empty("Threads could not be read.")
          : threads.value.length === 0
            ? empty("No thread has started for this task.")
            : rowList(
                threads.value.map((thread) => ({
                  title: thread.kind === "review" ? "Review" : "Implement",
                  href: threadHref(thread),
                  wholeRow: true,
                  sub: escapeHtml(
                    `${labels.get(thread.environmentId) ?? thread.environmentId}, ${providerName(thread.providerInstanceId)}, ${thread.model}${effortText(thread.effort)}`,
                  ),
                  aside: threadStatus(thread),
                })),
              );

        sendHtml(
          response,
          200,
          layout(
            taskLabel(item),
            `${pageHead({
              title: taskLabel(item),
              lede: `${stagePill(item)}${DOT}<code>${escapeHtml(item.repo)}</code>`,
              // A task that waits for you has Abandon in its callout instead.
              ...(actions.abandon && !needsOwner(item) && !isParked(item)
                ? {
                    actions: menu([
                      { label: "Abandon", href: formHref(`/work/${String(id)}/abandon`, back) },
                    ]),
                  }
                : {}),
            })}${notice(url)}${events.ok && threads.ok && approved.ok ? "" : STORE_ERROR}${
              track === undefined
                ? ""
                : `<div class="tracker">${track.html}${noteLine(trackNote(item, track.step, events.ok ? events.value : [], now()))}</div>`
            }${taskCallout(item, back, place, handoffs.state(item))}<div class="cols">${section({
              title: "Details",
              body: details(item, labels, now()),
            })}${section({
              title: "Threads",
              count: threads.ok ? threads.value.length : undefined,
              body: threadRows,
            })}</div>${proof(item, approved, events.ok ? events.value : [])}${events.ok ? attempts(item, events.value, now()) : ""}${section(
              {
                title: "History",
                body: !events.ok
                  ? empty("The task's history could not be read.")
                  : events.value.length === 0
                    ? empty("Nothing has happened yet.")
                    : history(events.value, now()),
              },
            )}`,
            {
              section: "/work",
              shell,
              crumbs: taskCrumbs(id),
              refreshSeconds:
                handoffs.state(item) === "sending" ? SENDING_RELOAD_SECONDS : RELOAD_SECONDS,
            },
          ),
        );
      },
    },
    {
      method: "GET",
      path: /^\/threads\/([^/]+)\/([^/]+)$/,
      handle: ({ response, params, shell }) => {
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
              shell,
              crumbs: [["Work", "/work"], ["Thread"]],
            }),
          );
          return;
        }
        if (thread.value === undefined) {
          sendHtml(
            response,
            404,
            layout(
              "No such thread",
              `${pageHead({ title: "No such thread" })}${empty("Hephaestus has no record of this thread.")}`,
              { section: "/work", shell, crumbs: [["Work", "/work"], ["Not found"]] },
            ),
          );
          return;
        }
        const record = thread.value;
        const crumbs: Crumb[] = [
          ["Work", "/work"],
          ...(record.taskId === null
            ? []
            : [[`Task ${record.taskId}`, `/work/${encodeURIComponent(record.taskId)}`] as const]),
          ["Thread"],
        ];
        const transcript =
          items.value.length === 0
            ? empty("No activity recorded yet.")
            : `<div class="term" tabindex="0" role="region" aria-label="Transcript"><ol class="log">${items.value
                .map((item) => {
                  const kind = item.type.includes("assistant")
                    ? "agent"
                    : item.type.includes("command") || item.type.includes("tool")
                      ? "tool"
                      : "";
                  return `<li${kind === "" ? "" : ` class="${kind}"`}><span class="n">${String(item.position)}</span><span class="who">${escapeHtml(item.type.replaceAll("_", " "))}${item.status === "completed" ? "" : `<br>${escapeHtml(item.status.replaceAll("_", " "))}`}</span><span class="what">${escapeHtml(item.text)}</span></li>`;
                })
                .join("")}</ol></div>`;
        sendHtml(
          response,
          200,
          layout(
            record.title,
            `${pageHead({
              title: record.title,
              lede: `${threadStatus(record)}${DOT}${escapeHtml(
                `${workerLabels(factory).get(record.environmentId) ?? record.environmentId}, ${providerName(record.providerInstanceId)}, ${record.model}${effortText(record.effort)}`,
              )}${DOT}config v${String(record.configVersion)}`,
            })}${section({
              title: "Transcript",
              count: items.value.length,
              right: `<span class="muted">Started ${when(record.createdAt, now())}</span>`,
              body: transcript,
            })}`,
            {
              section: "/work",
              shell,
              crumbs,
              // An ended transcript changes no more, and a reload would lose the reader's place in it.
              ...(isRunning(record) ? { refreshSeconds: RELOAD_SECONDS } : {}),
            },
          ),
        );
      },
    },
  ];
}

/** How a thread's effort reads after its model: nothing when none was set, as the model's default ran. */
function effortText(effort: string | null | undefined): string {
  return effort === null || effort === undefined ? "" : `, ${effort} effort`;
}
