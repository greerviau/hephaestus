import type { Card } from "../factory/cards.js";
import type { TrackedIssue } from "../factory/intake.js";
import type { StoredThread } from "../t3/events.js";
import type { WorkerView } from "../workers/manager.js";
import { expiresIn, expiringSoon, readEnvironments } from "./environments.js";
import {
  ACTIVE_STAGES,
  STORE_ERROR,
  cardActions,
  cardLink,
  isRunning,
  issueUrl,
  notice,
  providerName,
  read,
  shortSha,
  stagePill,
  t3Error,
  threadHref,
  workerNeedsOwner,
  type FactoryPages,
  type Read,
} from "./factory.js";
import {
  card,
  empty,
  escapeHtml,
  externalLink,
  icon,
  layout,
  loading,
  pageHead,
  pill,
  postButton,
  status,
  textAction,
  when,
  type IconName,
} from "./html.js";
import { sendHtml, type Route } from "./http.js";

interface Need {
  icon: IconName;
  tone: "warn" | "crit";
  /** Safe HTML. */
  title: string;
  /** Safe HTML. */
  why: string;
  /** Safe HTML. */
  actions: string;
}

const RELOAD_SECONDS = 5;

/** Owner actions for an escalated card, as shown in lists. */
export function escalationActions(item: Card, back: string): string {
  const actions = cardActions(item);
  const id = String(item.id);
  const parts: string[] = [];
  if (actions.approveMerge && item.headSha !== null && item.ownerAction !== null) {
    // The button names the PR it merges: the card's own, or its revert PR.
    const target = item.ownerAction === "revert-merge" ? item.revertPr : item.prNumber;
    const what = item.ownerAction === "revert-merge" ? "revert PR" : "PR";
    parts.push(
      postButton(
        `/work/${id}/approve-merge`,
        `Merge ${what} #${String(target)} at ${shortSha(item.headSha)}`,
        { fields: { headSha: item.headSha, action: item.ownerAction, back }, variant: "primary" },
      ),
    );
  }
  if (actions.sendToLead) {
    parts.push(
      textAction(
        `/work/${id}/send-to-lead`,
        "Send to lead",
        { name: "note", label: "Note for the lead", placeholder: "What to change" },
        { fields: { back, version: String(item.version) } },
      ),
    );
  }
  if (actions.abandon) {
    parts.push(
      textAction(
        `/work/${id}/abandon`,
        "Abandon",
        { name: "reason", label: "Why abandon it" },
        { fields: { back, version: String(item.version) }, crit: true },
      ),
    );
  }
  return parts.join("");
}

export function issueActions(issue: TrackedIssue, back: string): string {
  const fields = { repo: issue.repo, number: String(issue.number), back };
  return (
    postButton("/work/issues/admit", "Admit", { fields, variant: "primary" }) +
    postButton("/work/issues/reject", "Reject", { fields })
  );
}

export function issueWhy(issue: TrackedIssue): string {
  return issue.state === "held-cap"
    ? `Filed by the ${escapeHtml(issue.filedBy ?? "factory")} role and held: the project's cap on open factory-filed issues is reached.`
    : `Opened by ${escapeHtml(issue.author)} outside Hephaestus. The factory works on it only if you admit it.`;
}

function workerStep(view: WorkerView): string {
  if (view.tasks["claude-sign-in"]?.status === "running") {
    return `Paste the Claude setup token into the thread "Hephaestus: sign in Factory Claude" on ${view.label} in T3.`;
  }
  if (view.tasks["codex-sign-in"]?.status === "running") {
    return "Approve the Codex sign-in code shown on the Workers page.";
  }
  return view.blocker ?? "";
}

/** A line for each running thread of a card: its role, worker, and provider. */
export function threadLines(threads: StoredThread[], labels: Map<string, string>): string {
  return threads
    .filter(isRunning)
    .map(
      (thread) =>
        `<a href="${threadHref(thread)}">${escapeHtml(
          `${thread.kind === "review" ? "Review" : "Implement"} on ${labels.get(thread.environmentId) ?? thread.environmentId}, ${providerName(thread.providerInstanceId)}`,
        )}</a>`,
    )
    .join("<br>");
}

export function overviewRoutes(factory: FactoryPages): Route[] {
  const now = factory.now ?? Date.now;
  return [
    {
      method: "GET",
      path: /^\/$/,
      handle: async ({ response, url }) => {
        const t3 = await readEnvironments(factory.environments, factory.t3WaitMs ?? 2000);
        const cards = read("cards", () => factory.cards.list());
        const issues = read("issues", () => factory.intake.issues(["awaiting-owner", "held-cap"]));
        const proposals = read("proposals", () =>
          factory.store
            .list()
            .filter((version) => version.author === "improver" && version.state === "draft"),
        );
        const notifications = read("notifications", () => factory.cards.notifications());
        const reverts = read("reverts", () => factory.cards.revertCount());
        const workers = read("workers", () => factory.workers?.views() ?? []);
        const paused = read("the pause switch", () => factory.pipeline.paused());
        const blocked = read("the thread caps", () => factory.pipeline.blockedBecause(undefined));
        const threads = read("threads", () => {
          const byCard = new Map<number, StoredThread[]>();
          for (const item of cards.ok ? cards.value : []) {
            if (ACTIVE_STAGES.includes(item.stage) || item.stage === "Escalated") {
              byCard.set(item.id, factory.events.forCard(item.id));
            }
          }
          return byCard;
        });
        const labels = new Map(
          (workers.ok ? workers.value : []).map((view) => [view.environmentId, view.label]),
        );
        const storeFailed = [
          cards,
          issues,
          proposals,
          notifications,
          workers,
          paused,
          threads,
        ].some((result) => !result.ok);

        const needs: Need[] = [];
        if (cards.ok) {
          for (const item of cards.value) {
            if (item.stage !== "Escalated" || item.escalatedTo !== "owner") continue;
            needs.push({
              icon: "q",
              tone: "warn",
              title: cardLink(item),
              why: `${escapeHtml(item.reason ?? "Escalated to you.")} <span class="meta">${escapeHtml(item.repo)}</span>`,
              actions: escalationActions(item, "/"),
            });
          }
        }
        if (issues.ok) {
          for (const issue of issues.value) {
            needs.push({
              icon: "q",
              tone: "warn",
              title: externalLink(
                issueUrl(issue.repo, issue.number),
                `${issue.repo}#${String(issue.number)} ${issue.title}`,
              ),
              why: issueWhy(issue),
              actions: issueActions(issue, "/"),
            });
          }
        }
        if (proposals.ok) {
          for (const version of proposals.value) {
            needs.push({
              icon: "q",
              tone: "warn",
              title: `<a href="/improvement#v${String(version.id)}">${escapeHtml(`Proposal v${String(version.id)}: ${version.message}`)}</a>`,
              why: "The improver proposed a config change. Approving it deploys it.",
              actions: `<a class="btn btn-secondary btn-s" href="/improvement#v${String(version.id)}">Open proposal</a>`,
            });
          }
        }
        if (t3.state === "ok") {
          for (const environment of t3.value.environments) {
            if (!expiringSoon(environment, now())) continue;
            needs.push({
              icon: "warn",
              tone: "warn",
              title: escapeHtml(
                `${environment.label}: the T3 link ${expiresIn(environment, now())}`,
              ),
              why: "Link it again from this host before then, or factory threads on it stop.",
              actions: '<a href="/environments">Open Workers</a>',
            });
          }
        }
        if (workers.ok) {
          for (const view of workers.value.filter(workerNeedsOwner)) {
            needs.push({
              icon: "warn",
              tone: "crit",
              title: `<a href="/environments">${escapeHtml(view.label)}</a>`,
              why: escapeHtml(workerStep(view)),
              actions: '<a href="/environments">Open Workers</a>',
            });
          }
        }
        if (notifications.ok) {
          for (const item of notifications.value) {
            // Escalations are listed from the card's state above; their notifications stay in Activity.
            if (item.kind === "escalation") continue;
            const linked =
              item.cardId === null ? "" : `<a href="/work/${String(item.cardId)}">Open card</a>`;
            needs.push({
              icon: "q",
              tone: "warn",
              title: escapeHtml(item.text),
              why: `<span class="meta">${when(item.at, now())}</span>`,
              actions:
                linked +
                postButton(`/notifications/${String(item.id)}/dismiss`, "Dismiss", {
                  fields: { back: "/" },
                }),
            });
          }
        }

        const inProgress = cards.ok
          ? cards.value.filter(
              (item) =>
                ACTIVE_STAGES.includes(item.stage) ||
                (item.stage === "Escalated" && item.escalatedTo !== "owner"),
            )
          : [];
        const isWaiting = (item: Card): boolean =>
          item.waiting !== null || item.stage === "Admitted" || item.stage === "Escalated";
        const running = inProgress.filter((item) => !isWaiting(item)).length;
        const waiting = inProgress.length - running;

        // With any source unread, an empty list or an exact count would be a claim the page cannot make.
        const incomplete =
          t3.state === "error" ||
          [cards, issues, proposals, notifications, workers].some((part) => !part.ok);
        const lede = `<strong>${incomplete ? "At least " : ""}${String(needs.length)} need you</strong> &middot; ${String(running)} running &middot; ${String(waiting)} waiting`;
        const actions = paused.ok
          ? paused.value
            ? `${pill("off", "Paused")}${postButton("/factory/resume", "Resume factory", { fields: { back: "/" }, variant: "primary", small: false })}`
            : `${pill("run", "Running")}${postButton("/factory/pause", "Pause factory", { fields: { back: "/" }, small: false })}`
          : '<button type="button" class="btn-secondary" disabled>Pause factory</button>';

        const banners = [
          notice(url),
          storeFailed ? STORE_ERROR : "",
          t3.state === "error" ? t3Error(t3.reason) : "",
        ].join("");

        const needsBody =
          needs.length === 0 && t3.state === "loading"
            ? loading("Checking T3 links...")
            : needs.length === 0 && incomplete
              ? `<p class="calm">${icon("warn", "s-warn")}Some of what may need you could not be read. Reload to try again.</p>`
              : needs.length === 0
                ? `<p class="calm">${icon("ok", "s-good")}Nothing needs you.</p>`
                : `<ul class="need-rows">${needs
                    .map(
                      (need) =>
                        `<li><div class="nr-main">${status(need.tone, need.icon, need.title)}<span class="sub">${need.why}</span></div><div class="need-acts">${need.actions}</div></li>`,
                    )
                    .join(
                      "\n",
                    )}</ul>${t3.state === "loading" ? loading("Checking T3 links...") : ""}`;

        const body = [
          card({
            title: "Needs you",
            className: needs.length > 0 ? "needbox" : undefined,
            meta: `<span class="meta">${String(needs.length)} items</span>`,
            body: needsBody,
            busy: t3.state === "loading",
          }),
          card({
            title: "In progress",
            span: 7,
            meta: '<a href="/pipeline">Pipeline</a>',
            body: progressBody(
              inProgress,
              cards,
              threads,
              labels,
              blocked,
              running,
              waiting,
              now(),
            ),
          }),
          card({
            title: "Finished",
            span: 5,
            meta: '<a href="/work?stage=finished">View all</a>',
            body: finishedBody(cards, reverts, now()),
          }),
        ].join("\n");

        sendHtml(
          response,
          200,
          layout(
            "Overview",
            `${pageHead({ title: "Overview", lede, actions })}${banners}<div class="grid">${body}</div>`,
            { section: "/", ...(t3.state === "loading" ? { refreshSeconds: RELOAD_SECONDS } : {}) },
          ),
        );
      },
    },
  ];
}

function progressBody(
  inProgress: Card[],
  cards: Read<Card[]>,
  threads: Read<Map<number, StoredThread[]>>,
  labels: Map<string, string>,
  blocked: Read<string | undefined>,
  running: number,
  waiting: number,
  now: number,
): string {
  if (!cards.ok) return empty("Cards could not be read.");
  const why =
    blocked.ok && blocked.value !== undefined
      ? `<p class="note">${status("warn", "pause", `No factory thread starts now: ${escapeHtml(blocked.value)}`)}</p>`
      : "";
  if (inProgress.length === 0) {
    return `${empty("No work in progress. Admitted issues start when the lead runs start_work.")}${why}`;
  }
  const counts = `<p class="counts">${pill("run", `${String(running)} running`)}${pill("wait", `${String(waiting)} waiting`)}</p>`;
  const rows = inProgress
    .map((item) => {
      const lines = threads.ok ? threadLines(threads.value.get(item.id) ?? [], labels) : "";
      const waitingLine =
        item.waiting === null ? "" : `<p class="hint">${escapeHtml(item.waiting)}</p>`;
      return `<li><div class="prog-main">${cardLink(item)}<p class="doing">${stagePill(item)} ${lines}</p>${waitingLine}</div><div class="prog-when meta">${when(item.updatedAt, now)}</div></li>`;
    })
    .join("\n");
  return `${counts}${why}<ul class="prog">${rows}</ul>`;
}

function finishedBody(cards: Read<Card[]>, reverts: Read<number>, now: number): string {
  if (!cards.ok) return empty("Cards could not be read.");
  const finished = cards.value.filter(
    (item) => item.stage === "Done" || item.stage === "Abandoned",
  );
  // A revert counts once its revert PR merged, whatever the card does next.
  const reverted = reverts.ok ? reverts.value : 0;
  if (finished.length === 0 && reverted === 0) {
    return empty("Finished work appears here with its outcome.");
  }
  const merged = finished.filter((item) => item.stage === "Done").length;
  const abandoned = finished.length - merged;
  const recent = [...finished]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5)
    .map(
      (item) =>
        `<li><span>${cardLink(item)} <span class="meta">${when(item.updatedAt, now)}</span></span>${stagePill(item)}</li>`,
    )
    .join("");
  return `<p class="bignum"><span class="num">${String(finished.length)}</span> <span class="meta">finished</span></p>
<p class="counts">${pill("done", `${String(merged)} merged`)}${pill("you", `${String(reverted)} reverted`)}${pill("off", `${String(abandoned)} abandoned`)}</p>
<ul class="mini-list">${recent}</ul>`;
}
