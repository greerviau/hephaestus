import type { Card } from "../factory/cards.js";
import type { Stage } from "../hermes/board.js";
import type { StoredThread } from "../t3/events.js";
import {
  ACTIVE_STAGES,
  STORE_ERROR,
  cardLink,
  isRunning,
  read,
  stagePill,
  type FactoryPages,
} from "./factory.js";
import { card, empty, escapeHtml, layout, pageHead, status, table, when } from "./html.js";
import { sendHtml, type Route } from "./http.js";
import { threadLines } from "./overview.js";

const PIPELINE_STAGES: readonly Stage[] = [...ACTIVE_STAGES, "Escalated"];

/** The role a card's stage gives the next or current thread. */
function role(item: Card, threads: StoredThread[]): string {
  const running = threads.filter(isRunning);
  if (running.some((thread) => thread.kind === "review")) return "Review";
  if (running.some((thread) => thread.kind === "implement")) return "Implement";
  if (item.stage === "Reviewing") return "Review";
  if (item.stage === "Implementing" || item.stage === "Admitted") return "Implement";
  return "-";
}

/** The Pipeline page: cards by stage and role, with the threads running for them. */
export function pipelineRoutes(factory: FactoryPages): Route[] {
  const now = factory.now ?? Date.now;
  return [
    {
      method: "GET",
      path: /^\/pipeline$/,
      handle: ({ response }) => {
        const cards = read("cards", () => factory.cards.list(PIPELINE_STAGES));
        const threads = read("threads", () => {
          const byCard = new Map<number, StoredThread[]>();
          for (const item of cards.ok ? cards.value : []) {
            byCard.set(item.id, factory.events.forCard(item.id));
          }
          return byCard;
        });
        const running = read("running threads", () => factory.pipeline.runningThreads());
        const blocked = read("the thread caps", () => factory.pipeline.blockedBecause(undefined));
        const workers = read("workers", () => factory.workers?.views() ?? []);
        const limits = read(
          "the deployed config",
          () =>
            factory.store.list().find((version) => version.state === "deployed")?.document.factory
              .limits,
        );
        const labels = new Map(
          (workers.ok ? workers.value : []).map((view) => [view.environmentId, view.label]),
        );
        const failed = [cards, threads, running, blocked, workers, limits].some(
          (result) => !result.ok,
        );

        const summary: string[] = [];
        if (running.ok) {
          const of =
            limits.ok && limits.value !== undefined
              ? ` of ${String(limits.value.threads)} allowed`
              : "";
          summary.push(
            `<strong>${String(running.value)} running factory threads</strong>${escapeHtml(of)}`,
          );
        }
        if (limits.ok && limits.value !== undefined) {
          summary.push(
            escapeHtml(
              `${String(limits.value.threadsPerWorker)} per worker, ${String(limits.value.startsPerDay)} starts per day`,
            ),
          );
        }
        const why =
          blocked.ok && blocked.value !== undefined
            ? `<p class="note">${status("warn", "pause", `No factory thread starts now: ${escapeHtml(blocked.value)}`)}</p>`
            : "";

        let body: string;
        if (!cards.ok) body = card({ title: "Cards", body: empty("Cards could not be read.") });
        else if (cards.value.length === 0) {
          body = card({
            title: "Cards",
            body: empty(
              "No card is in the pipeline. Admitted cards appear here until they are done.",
            ),
          });
        } else {
          body = PIPELINE_STAGES.map((stage) => {
            const inStage = cards.value.filter((item) => item.stage === stage);
            if (inStage.length === 0) return "";
            const rows = inStage.map((item) => {
              const cardThreads = threads.ok ? (threads.value.get(item.id) ?? []) : [];
              const lines = threadLines(cardThreads, labels);
              return [
                cardLink(item),
                escapeHtml(role(item, cardThreads)),
                lines === "" ? '<span class="s-muted">None running</span>' : lines,
                `${stagePill(item)}${item.waiting === null ? "" : `<span class="sub">${escapeHtml(item.waiting)}</span>`}${item.stage === "Escalated" && item.reason !== null ? `<span class="sub">${escapeHtml(item.reason)}</span>` : ""}`,
                when(item.updatedAt, now()),
              ];
            });
            return `<section class="card span-12" id="stage-${stage}" aria-labelledby="h-stage-${stage}"><div class="card-head"><h2 id="h-stage-${stage}">${stage}</h2><span class="meta">${String(inStage.length)} ${inStage.length === 1 ? "card" : "cards"}</span></div>${table(
              [
                { label: "Card", className: "title-cell" },
                { label: "Role" },
                { label: "Active threads" },
                { label: "Status" },
                { label: "Updated", right: true },
              ],
              rows,
            )}</section>`;
          }).join("\n");
        }

        sendHtml(
          response,
          200,
          layout(
            "Pipeline",
            `${pageHead({
              title: "Pipeline",
              lede: summary.join(" &middot; ") || "Cards from admission to merge and validation.",
            })}${failed ? STORE_ERROR : ""}${why}<div class="grid">${body}</div>`,
            { section: "/pipeline" },
          ),
        );
      },
    },
  ];
}
