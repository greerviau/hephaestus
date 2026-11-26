import type { ConfigStore } from "../config/store.js";
import type { Analytics } from "../factory/analytics.js";
import type { Card, CardStore } from "../factory/cards.js";
import type { FactoryMcp } from "../factory/mcp.js";
import type { Intake } from "../factory/intake.js";
import { MergeSettledError, type Pipeline } from "../factory/pipeline.js";
import type { Stage } from "../hermes/board.js";
import { ENDED_STATUSES, type StoredThread, type ThreadEvents } from "../t3/events.js";
import type { WorkerManager, WorkerView } from "../workers/manager.js";
import type { EnvironmentSource } from "./environments.js";
import { backTo, banner, escapeHtml, pill } from "./html.js";
import { readBody, redirect, type Route, type RouteContext } from "./http.js";
import type { Deploy } from "./settings.js";

/** What the factory pages read and act on. */
export interface FactoryPages {
  cards: CardStore;
  intake: Pick<Intake, "issues" | "approve" | "reject">;
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
  /** Publishes a version and deploys it to every worker; Improvement approval calls it. */
  deploy?: Deploy;
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

export const STORE_ERROR = banner(
  "err",
  "Hephaestus could not read its store",
  "Part of this page could not be loaded, so its actions are off. The service log has the error. Reload to try again.",
);

export function t3Error(reason: string): string {
  return banner(
    "err",
    "T3 could not be reached",
    `Link expiry and worker state are unknown until T3 answers (${reason}). Reload to try again.`,
  );
}

/** Whether the worker's next step is the owner's: a sign-in, a failed deploy, a missing instance. */
export function workerNeedsOwner(view: WorkerView): boolean {
  return view.ownerStep;
}

export function shortSha(sha: string | null): string {
  return sha === null ? "" : sha.slice(0, 7);
}

/** The card's stage as a pill. */
export function stagePill(card: Card): string {
  switch (card.stage) {
    case "Done":
      return pill("done", "Done");
    case "Abandoned":
      return pill("off", "Abandoned");
    case "Escalated":
      return card.escalatedTo === "owner"
        ? pill("you", "Needs you")
        : pill("wait", "With the lead");
    case "Reverting":
      return pill("bad", "Reverting");
    case "Admitted":
      return pill("wait", "Admitted");
    default:
      return card.waiting === null ? pill("run", card.stage) : pill("wait", card.stage);
  }
}

export function cardLabel(card: Card): string {
  return `${card.issueNumber === null ? `Card ${String(card.id)}` : `#${String(card.issueNumber)}`} ${card.title}`;
}

export function cardLink(card: Card): string {
  return `<a href="/work/${String(card.id)}">${escapeHtml(cardLabel(card))}</a>`;
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
export interface CardActions {
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
    text: "Cards start and resume as caps allow.",
  },
  "merge-approved": {
    kind: "info",
    title: "Merge approved",
    text: "The card goes back through the merge gate at the commit you approved.",
  },
  "merge-refused": {
    kind: "err",
    title: "The merge was not approved",
    text: "The card is no longer waiting for your approval of that commit. The page shows its current state.",
  },
  "sent-to-lead": {
    kind: "info",
    title: "Sent to the lead",
    text: "The lead picks the card up with your note.",
  },
  "send-failed": {
    kind: "err",
    title: "The card was not sent to the lead",
    text: "It is no longer escalated, or the Hermes board could not be updated. The service log has the error.",
  },
  abandoned: { kind: "info", title: "Card abandoned", text: "No more threads start for it." },
  "merge-validating": {
    kind: "info",
    title: "The PR has already merged",
    text: "Hephaestus made the merge, whose reply was lost. The card was not sent back; the merge step will validate the merge.",
  },
  "merge-foreign": {
    kind: "info",
    title: "The PR has already merged",
    text: "Someone merged it outside Hephaestus, so the card is done and was not sent back.",
  },
  "merge-unclear": {
    kind: "err",
    title: "The PR has already merged",
    text: "Hephaestus could not yet read whose merge it was, so the card was not sent back. Try again shortly.",
  },
  "abandon-failed": {
    kind: "err",
    title: "The card was not abandoned",
    text: "Its stage no longer allows it. The page shows its current state.",
  },
  admitted: { kind: "info", title: "Issue admitted", text: "It has a card now." },
  "admit-failed": {
    kind: "err",
    title: "The issue was not admitted",
    text: "GitHub could not confirm that the issue is still open. The service log has the error.",
  },
  rejected: { kind: "info", title: "Issue rejected", text: "The factory will not work on it." },
  dismissed: { kind: "info", title: "Notification dismissed", text: "It no longer needs you." },
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
    text: "The version is approved. Deploying it failed; retry from its page in Settings. The service log has the error.",
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
  const found = NOTICES[url.searchParams.get("notice") ?? ""];
  return found === undefined ? "" : banner(found.kind, found.title, found.text);
}

export function withNotice(path: string, key: keyof typeof NOTICES): string {
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

async function form({ request }: RouteContext): Promise<URLSearchParams> {
  return new URLSearchParams((await readBody(request, MAX_FORM_BYTES)) ?? "");
}

/**
 * Runs an owner action and returns to the page it came from with a notice.
 * Errors are logged and shown as a fixed notice, never as their text.
 */
async function act(
  context: RouteContext,
  fallback: string,
  run: (fields: URLSearchParams) => Promise<unknown>,
  done: keyof typeof NOTICES,
  failed: keyof typeof NOTICES,
): Promise<void> {
  const fields = await form(context);
  const back = backTo(fields.get("back"), fallback);
  try {
    await run(fields);
  } catch (error) {
    if (error instanceof MergeSettledError) {
      // The card moved on; say where, which is not a failure of the action's own work.
      const notice =
        error.stage === "Merging"
          ? "merge-validating"
          : error.stage === "Done"
            ? "merge-foreign"
            : "merge-unclear";
      redirect(context.response, withNotice(back, notice));
      return;
    }
    console.error("A dashboard action failed", error);
    redirect(context.response, withNotice(back, failed));
    return;
  }
  redirect(context.response, withNotice(back, done));
}

function text(fields: URLSearchParams, name: string): string {
  const value = fields.get(name)?.trim() ?? "";
  if (value === "") throw new Error(`The ${name} is empty.`);
  return value;
}

/** Owner actions on the factory, shared by every page that offers them. */
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
      path: /^\/work\/(\d+)\/send-to-lead$/,
      handle: (context) => {
        const id = Number(context.params[0]);
        return act(
          context,
          `/work/${String(id)}`,
          (fields) => pipeline.sendToLead(id, text(fields, "note"), text(fields, "version")),
          "sent-to-lead",
          "send-failed",
        );
      },
    },
    {
      method: "POST",
      path: /^\/work\/(\d+)\/abandon$/,
      handle: (context) => {
        const id = Number(context.params[0]);
        return act(
          context,
          `/work/${String(id)}`,
          (fields) =>
            pipeline.abandon(
              id,
              `The owner abandoned it: ${text(fields, "reason")}`,
              text(fields, "version"),
            ),
          "abandoned",
          "abandon-failed",
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
