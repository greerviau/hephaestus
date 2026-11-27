import type { FactoryModel } from "../hermes/factory-model.js";
import type { Messaging } from "../messaging.js";
import type { ConfigStore } from "../config/store.js";
import type { Analytics } from "../factory/analytics.js";
import type { Card, CardStore } from "../factory/cards.js";
import type { FactoryMcp } from "../factory/mcp.js";
import type { Intake, TrackedIssue } from "../factory/intake.js";
import { MergeSettledError, checksPassedAtGate, type Pipeline } from "../factory/pipeline.js";
import type { Stage } from "../hermes/board.js";
import { ENDED_STATUSES, type StoredThread, type ThreadEvents } from "../t3/events.js";
import type { WorkerManager, WorkerView } from "../workers/manager.js";
import type { EnvironmentSource } from "./workers.js";
import {
  backTo,
  buttonLink,
  callout,
  escapeHtml,
  externalLink,
  lookup,
  menu,
  postButton,
  statusText,
  type MenuItem,
  type Row,
} from "./html.js";
import { readBody, redirect, type Route, type RouteContext } from "./http.js";
import type { Deploy } from "./settings.js";

/** What the factory pages read and act on. */
export interface FactoryPages {
  cards: CardStore;
  intake: Pick<Intake, "issues" | "approve" | "reject" | "fileIssue">;
  pipeline: Pick<
    Pipeline,
    | "paused"
    | "setPaused"
    | "approveMerge"
    | "sendToLead"
    | "abandon"
    | "blockedBecause"
    | "runningThreads"
  >;
  events: ThreadEvents;
  mcp: Pick<FactoryMcp, "calls" | "evidence">;
  store: ConfigStore;
  analytics: (options: { repo?: string; days: number }) => Analytics;
  workers?: Pick<WorkerManager, "views">;
  environments: EnvironmentSource;
  /** Publishes a version and deploys it to every worker; approving a proposal calls it. */
  deploy?: Deploy;
  /** The chat Hephaestus talks to the owner in; absent without the factory's Hermes. */
  messaging?: Pick<
    Messaging,
    "ready" | "states" | "connect" | "disconnect" | "send" | "alertsOn" | "setAlerts" | "restart"
  >;
  /** Sets the factory Hermes's provider and model; absent without the factory's Hermes. */
  model?: Pick<
    FactoryModel,
    "ready" | "catalog" | "addKey" | "setModel" | "startDeviceLogin" | "deviceLogin"
  >;
  /** The config repo named on Config, as `owner/name`. */
  configRepo?: () => string | undefined;
  /** Names the config repo; without it the Config page shows the repo but cannot change it. */
  setConfigRepo?: (slug: string) => void;
  /** The factory Hermes root's default model, when one is set, for the setup checklist. */
  hermesModel?: () => string | undefined;
  /** GitHub reads for the Projects page: repo suggestions, and a check that a new repo is readable. */
  github?: { repos(): Promise<string[]>; canonicalName(repo: string): Promise<string> };
  now?: () => number;
  /** How long a page waits for T3 before it shows that section as loading. */
  t3WaitMs?: number;
}

/** Stages in the order work moves through them. */
export const ACTIVE_STAGES: readonly Stage[] = [
  "Admitted",
  "Implementing",
  "Reviewing",
  "Merging",
  "Validating",
  "Reverting",
];
/** Card stages the owner can abandon from, as the stage diagram allows. */
const ABANDONABLE: readonly Stage[] = [
  "Admitted",
  "Implementing",
  "Reviewing",
  "Merging",
  "Escalated",
];

export type Read<T> = { ok: true; value: T } | { ok: false };

/**
 * Runs a read against the store. A failure is logged and reported as
 * unreadable, so the page shows the error banner instead of the error text.
 */
export function read<T>(what: string, run: () => T): Read<T> {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    console.error(`Reading ${what} for the dashboard failed`, error);
    return { ok: false };
  }
}

export const STORE_ERROR = callout(
  "err",
  "Hephaestus could not read its store",
  "Part of this page could not be loaded, so its actions are off. The service log has the error. Reload to try again.",
);

export function t3Error(reason: string): string {
  return callout(
    "err",
    "T3 could not be reached",
    escapeHtml(
      `Link expiry and worker state are unknown until T3 answers (${reason}). Reload to try again.`,
    ),
  );
}

/** Whether the worker's next step is the owner's: a sign-in, a failed deploy, a missing instance. */
export function workerNeedsOwner(view: WorkerView): boolean {
  return view.ownerStep;
}

export function shortSha(sha: string | null): string {
  return sha === null ? "" : sha.slice(0, 7);
}

/**
 * The name the pages give an internal stage. The merge gate is Testing until
 * the head commit's checks no longer hold the merge back, which only a task at
 * the gate can say; an event that records the move there is always Testing.
 */
export function stageName(stage: string, pastChecks = false): string {
  if (stage === "Merging") return pastChecks ? "Merging" : "Testing";
  return stage === "Validating" ? "Verifying" : stage;
}

/** The stage a task in progress is at, by the name the task page's tracker gives it. */
export function taskStage(card: Card): string {
  return stageName(card.stage, checksPassedAtGate(card.waiting));
}

/** The task's stage as status text. */
export function stagePill(card: Card): string {
  switch (card.stage) {
    case "Done":
      return statusText("done", "Done");
    case "Abandoned":
      return statusText("off", "Abandoned");
    case "Escalated":
      return card.escalatedTo === "owner"
        ? statusText("you", "Needs you")
        : statusText("wait", "With the lead");
    case "Reverting":
      return statusText("bad", "Reverting");
    case "Admitted":
      return statusText("wait", "Admitted");
    default:
      return statusText(card.waiting === null ? "run" : "wait", taskStage(card));
  }
}

export function cardLabel(card: Card): string {
  return `${card.issueNumber === null ? `Task ${String(card.id)}` : `#${String(card.issueNumber)}`} ${card.title}`;
}

export function prUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${String(number)}`;
}

export function issueUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/issues/${String(number)}`;
}

export function threadHref(thread: { environmentId: string; threadId: string }): string {
  return `/threads/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.threadId)}`;
}

export function isRunning(thread: StoredThread): boolean {
  return !ENDED_STATUSES.has(thread.status);
}

export function providerName(providerInstanceId: string): string {
  if (providerInstanceId === "hephaestus-claude") return "Factory Claude";
  if (providerInstanceId === "hephaestus-codex") return "Factory Codex";
  return providerInstanceId;
}

/** What the owner can do to a card in its current stage. */
interface CardActions {
  approveMerge: boolean;
  sendToLead: boolean;
  abandon: boolean;
}

export function cardActions(card: Card): CardActions {
  const withOwner = card.stage === "Escalated" && card.escalatedTo === "owner";
  return {
    approveMerge: withOwner && card.ownerAction !== null && card.headSha !== null,
    // A rollback stays with the owner; the lead's restart would rebuild the reverted work.
    sendToLead: withOwner && !card.reverting,
    abandon: ABANDONABLE.includes(card.stage),
  };
}

/** A page of its own that holds a form, with the place it returns to in its address. */
export function formHref(path: string, back: string): string {
  return `${path}?back=${encodeURIComponent(back)}`;
}

/** The button that approves the merge a task waits on, named for the PR it merges. Nothing when it waits on none. */
export function mergeButton(card: Card, back: string): string {
  if (!cardActions(card).approveMerge || card.headSha === null || card.ownerAction === null) {
    return "";
  }
  const revert = card.ownerAction === "revert-merge";
  return postButton(
    `/work/${String(card.id)}/approve-merge`,
    `Merge ${revert ? "revert PR" : "PR"} #${String(revert ? card.revertPr : card.prNumber)} at ${shortSha(card.headSha)}`,
    { fields: { headSha: card.headSha, action: card.ownerAction, back }, variant: "primary" },
  );
}

/**
 * Owner actions for a task escalated to the owner, as shown in lists: one
 * button, and the rest in a menu. The actions that need typed text are links
 * to their own pages, because a list page reloads and would drop the text.
 */
export function escalationActions(item: Card, back: string): string {
  const actions = cardActions(item);
  const id = String(item.id);
  const lead = { label: "Send to lead", href: formHref(`/work/${id}/lead`, back) };
  const abandon = { label: "Abandon", href: formHref(`/work/${id}/abandon`, back) };
  const rest: MenuItem[] = [];
  let primary = mergeButton(item, back);
  if (primary !== "") {
    if (actions.sendToLead) rest.push(lead);
    if (actions.abandon) rest.push(abandon);
  } else if (actions.sendToLead) {
    primary = buttonLink(lead.href, lead.label, { variant: "primary" });
    if (actions.abandon) rest.push(abandon);
  } else if (actions.abandon) {
    primary = buttonLink(abandon.href, abandon.label, { variant: "danger" });
  }
  return primary + menu(rest);
}

/** An issue that waits for the owner, as a list row: its number and title link to GitHub, with its repo and why it waits underneath. */
export function heldIssueRow(issue: TrackedIssue, back: string): Row {
  const label = `#${String(issue.number)} ${issue.title}`;
  return {
    kind: "issue",
    title: label,
    titleHtml: externalLink(issueUrl(issue.repo, issue.number), label),
    sub: `${escapeHtml(issue.repo)} &middot; ${escapeHtml(issueWhy(issue))}`,
    aside: issueActions(issue, back),
  };
}

/** The buttons that admit or reject an issue that waits for the owner. */
export function issueActions(issue: TrackedIssue, back: string): string {
  const fields = { repo: issue.repo, number: String(issue.number), back };
  return (
    postButton("/work/issues/admit", "Admit", { fields, variant: "primary" }) +
    postButton("/work/issues/reject", "Reject", { fields })
  );
}

/** Why an issue waits for the owner, as text. */
export function issueWhy(issue: TrackedIssue): string {
  return issue.state === "held-cap"
    ? `${issue.filedBy === "owner" ? "You requested it" : `Filed by the ${issue.filedBy ?? "factory"}`}, and it is held: the project already has its cap of factory-filed issues waiting.`
    : `Opened by ${issue.author} outside Hephaestus. The factory works on it only if you admit it.`;
}

/** What each running thread of a task is: its job, worker, and provider. */
export function runningThreads(threads: StoredThread[], labels: Map<string, string>): string[] {
  return threads
    .filter(isRunning)
    .map(
      (thread) =>
        `${thread.kind === "review" ? "Review" : "Implement"} on ${labels.get(thread.environmentId) ?? thread.environmentId}, ${providerName(thread.providerInstanceId)}`,
    );
}

/** Results of owner actions, shown as a banner on the page the action returns to. */
const NOTICES: Record<string, { kind: "err" | "info"; title: string; text: string }> = {
  paused: {
    kind: "info",
    title: "The factory is paused",
    text: "No factory thread starts or resumes until you resume it. Running threads finish.",
  },
  resumed: {
    kind: "info",
    title: "The factory is running",
    text: "Tasks start and resume as caps allow.",
  },
  "merge-approved": {
    kind: "info",
    title: "Merge approved",
    text: "The task goes back through the merge gate at the commit you approved.",
  },
  "merge-refused": {
    kind: "err",
    title: "The merge was not approved",
    text: "The task is no longer waiting for your approval of that commit. The page shows its current state.",
  },
  "sent-to-lead": {
    kind: "info",
    title: "Sent to the lead",
    text: "The lead picks the task up with your note.",
  },
  "send-failed": {
    kind: "err",
    title: "The task was not sent to the lead",
    text: "It is no longer escalated, or the Hermes board could not be updated. The service log has the error.",
  },
  abandoned: { kind: "info", title: "Task abandoned", text: "No more threads start for it." },
  "merge-validating": {
    kind: "info",
    title: "The PR has already merged",
    text: "Hephaestus made the merge, whose reply was lost. The task was not sent back; the merge step will validate the merge.",
  },
  "merge-foreign": {
    kind: "info",
    title: "The PR has already merged",
    text: "Someone merged it outside Hephaestus, so the task is done and was not sent back.",
  },
  "merge-unclear": {
    kind: "err",
    title: "The PR has already merged",
    text: "Hephaestus could not yet read whose merge it was, so the task was not sent back. Try again shortly.",
  },
  "abandon-failed": {
    kind: "err",
    title: "The task was not abandoned",
    text: "Its stage no longer allows it. The page shows its current state.",
  },
  admitted: { kind: "info", title: "Issue admitted", text: "It has a task now." },
  "admit-failed": {
    kind: "err",
    title: "The issue was not admitted",
    text: "GitHub could not confirm that the issue is still open. The service log has the error.",
  },
  rejected: { kind: "info", title: "Issue rejected", text: "The factory will not work on it." },
  "issue-filed": {
    kind: "info",
    title: "Issue filed and admitted",
    text: "It has a task. The lead starts it, or Hephaestus does after the auto-start delay.",
  },
  "issue-held": {
    kind: "info",
    title: "Issue filed, and held at the project's cap",
    text: "The project already has its limit of factory-filed issues waiting for work. Admit it under Needs you on Work when you want it worked.",
  },
  "issue-waiting": {
    kind: "info",
    title: "Issue filed, and waiting for you",
    text: "The project was removed while the issue was filed, so it was not admitted. Add the project back on Projects to work on it, or reject the issue.",
  },
  dismissed: { kind: "info", title: "Notification dismissed", text: "It no longer needs you." },
  "too-large": {
    kind: "err",
    title: "That did not work",
    text: "The form was too large to read, so nothing was changed.",
  },
  "action-failed": {
    kind: "err",
    title: "That did not work",
    text: "Hephaestus could not record the change. The service log has the error.",
  },
  approved: {
    kind: "info",
    title: "Proposal approved and deployed",
    text: "Workers pick the version up once their running factory threads finish.",
  },
  "deploy-failed": {
    kind: "err",
    title: "Approved, but not deployed",
    text: "The version is approved. Deploying it failed; retry from its page in Config. The service log has the error.",
  },
  "hermes-failed": {
    kind: "err",
    title: "Deployed, but the factory Hermes root was not updated",
    text: "Workers get the version. Applying it to the factory Hermes root failed; the service log has the error.",
  },
  "proposal-rejected": {
    kind: "info",
    title: "Proposal rejected",
    text: "It will never deploy.",
  },
  "proposal-refused": {
    kind: "err",
    title: "The proposal was not changed",
    text: "It is no longer a draft. The page shows its current state.",
  },
};

/** The banner for `?notice=` after an action, or nothing. */
export function notice(url: URL): string {
  const found = lookup(NOTICES, url.searchParams.get("notice"));
  return found === undefined ? "" : callout(found.kind, found.title, escapeHtml(found.text));
}

export type NoticeKey = keyof typeof NOTICES;

export function withNotice(path: string, key: NoticeKey): string {
  return `${path}${path.includes("?") ? "&" : "?"}notice=${key}`;
}

/** The current page path with its query, for forms that return here. */
export function here(url: URL): string {
  const query = new URLSearchParams(url.searchParams);
  query.delete("notice");
  const rest = query.toString();
  return rest === "" ? url.pathname : `${url.pathname}?${rest}`;
}

const MAX_FORM_BYTES = 16 * 1024;

/**
 * The fields of a posted form, or undefined when its body is over `maxBytes`.
 * The caller says so: a form too large to read is not an empty form.
 */
export async function form(
  { request }: Pick<RouteContext, "request">,
  maxBytes = MAX_FORM_BYTES,
): Promise<URLSearchParams | undefined> {
  const body = await readBody(request, maxBytes);
  return body === undefined ? undefined : new URLSearchParams(body);
}

/**
 * The notice for an owner action that threw. A merge that settled meanwhile
 * says where the task went, which is not a failure of the action's own work;
 * anything else is logged and shown as `failed`, never as its text.
 */
export function failureNotice(error: unknown, failed: NoticeKey): NoticeKey {
  if (error instanceof MergeSettledError) {
    return error.stage === "Merging"
      ? "merge-validating"
      : error.stage === "Done"
        ? "merge-foreign"
        : "merge-unclear";
  }
  console.error("A dashboard action failed", error);
  return failed;
}

/**
 * Runs an owner action and returns to the page it came from with a notice.
 * Errors are logged and shown as a fixed notice, never as their text.
 */
async function act(
  context: RouteContext,
  fallback: string,
  run: (fields: URLSearchParams) => Promise<unknown>,
  done: NoticeKey,
  failed: NoticeKey,
): Promise<void> {
  const fields = await form(context);
  if (fields === undefined) {
    redirect(context.response, withNotice(fallback, "too-large"));
    return;
  }
  const back = backTo(fields.get("back"), fallback);
  try {
    await run(fields);
  } catch (error) {
    redirect(context.response, withNotice(back, failureNotice(error, failed)));
    return;
  }
  redirect(context.response, withNotice(back, done));
}

function text(fields: URLSearchParams, name: string): string {
  const value = fields.get(name)?.trim() ?? "";
  if (value === "") throw new Error(`The ${name} is empty.`);
  return value;
}

/**
 * Owner actions on the factory that need no typed input, shared by every page
 * that offers them. The ones with a form of their own are in `work.ts`.
 */
export function factoryActionRoutes(factory: FactoryPages): Route[] {
  const { pipeline, intake, cards } = factory;
  return [
    {
      method: "POST",
      path: /^\/factory\/(pause|resume)$/,
      handle: (context) => {
        const pause = context.params[0] === "pause";
        return act(
          context,
          "/",
          () => {
            pipeline.setPaused(pause);
            return Promise.resolve();
          },
          pause ? "paused" : "resumed",
          "action-failed",
        );
      },
    },
    {
      method: "POST",
      path: /^\/work\/(\d+)\/approve-merge$/,
      handle: (context) => {
        const id = Number(context.params[0]);
        return act(
          context,
          `/work/${String(id)}`,
          (fields) => {
            const action = text(fields, "action");
            if (action !== "merge" && action !== "revert-merge") {
              throw new Error("Unknown merge action.");
            }
            return pipeline.approveMerge(id, text(fields, "headSha"), action);
          },
          "merge-approved",
          "merge-refused",
        );
      },
    },
    {
      method: "POST",
      path: /^\/work\/issues\/(admit|reject)$/,
      handle: (context) => {
        const admit = context.params[0] === "admit";
        return act(
          context,
          "/work",
          async (fields) => {
            const repo = text(fields, "repo");
            const number = Number(text(fields, "number"));
            if (!Number.isInteger(number)) throw new Error("The issue number is not a number.");
            if (admit) await intake.approve(repo, number);
            else await intake.reject(repo, number);
          },
          admit ? "admitted" : "rejected",
          admit ? "admit-failed" : "action-failed",
        );
      },
    },
    {
      method: "POST",
      path: /^\/notifications\/(\d+)\/dismiss$/,
      handle: (context) => {
        const id = Number(context.params[0]);
        return act(
          context,
          "/",
          () => {
            cards.dismissNotification(id);
            return Promise.resolve();
          },
          "dismissed",
          "action-failed",
        );
      },
    },
  ];
}
