import { VersionNotFoundError, type ConfigVersion } from "../config/store.js";
import { STORE_ERROR, notice, read, threadHref, withNotice, type FactoryPages } from "./factory.js";
import {
  card,
  empty,
  escapeHtml,
  layout,
  pageHead,
  pill,
  postButton,
  table,
  when,
} from "./html.js";
import { redirect, sendHtml, type Route } from "./http.js";
import { diffTable } from "./settings.js";

const STATE_PILLS: Record<ConfigVersion["state"], string> = {
  draft: pill("you", "Waiting for you"),
  approved: pill("wait", "Approved"),
  deployed: pill("done", "Deployed"),
  superseded: pill("off", "Superseded"),
  rejected: pill("bad", "Rejected"),
};

/** The Improvement page: the improver's proposals with their diff and evidence, and the owner's gate. */
export function improvementRoutes(factory: FactoryPages): Route[] {
  const now = factory.now ?? Date.now;
  const { store } = factory;

  function proposal(id: number): ConfigVersion | undefined {
    try {
      const version = store.get(id);
      return version.author === "improver" ? version : undefined;
    } catch (error) {
      if (error instanceof VersionNotFoundError) return undefined;
      throw error;
    }
  }

  return [
    {
      method: "GET",
      path: /^\/improvement$/,
      handle: ({ response, url }) => {
        const proposals = read("proposals", () =>
          store.list().filter((version) => version.author === "improver"),
        );
        const pending = read("proposal details", () =>
          (proposals.ok ? proposals.value : [])
            .filter((version) => version.state === "draft")
            .map((version) => ({
              version,
              diff: store.diff(version.id),
              evidence: factory.mcp.evidence(version.id),
            })),
        );
        const failed = !proposals.ok || !pending.ok;

        const drafts = !pending.ok
          ? [card({ title: "Proposals", body: empty("Proposals could not be read.") })]
          : pending.value.length === 0
            ? [
                card({
                  title: "Proposals",
                  body: empty(
                    "No proposal is waiting. The improver files one when the factory's threads show a change worth making.",
                  ),
                }),
              ]
            : pending.value.map(({ version, diff, evidence }) => {
                const id = String(version.id);
                const threads =
                  evidence.length === 0
                    ? empty("The proposal cites no threads.")
                    : `<ul class="mini-list">${evidence
                        .map(
                          (item) =>
                            `<li><span><a href="${threadHref(item)}">${escapeHtml(`${item.threadId} on ${item.environmentId}`)}</a>${item.note === "" ? "" : `<span class="sub">${escapeHtml(item.note)}</span>`}</span></li>`,
                        )
                        .join("")}</ul>`;
                return `<section class="card span-12" id="v${id}" aria-labelledby="h-v${id}"><div class="card-head"><h2 id="h-v${id}">Proposal v${id}</h2><span class="meta">${when(version.createdAt, now())}, built on v${String(version.parentId ?? "-")}</span></div>
<p class="lede">${escapeHtml(version.message)}</p>
<div class="btn-row">${postButton(`/improvement/${id}/approve`, `Approve and deploy v${id}`, { variant: "primary", small: false })}${postButton(`/improvement/${id}/reject`, `Reject v${id}`, { small: false })}</div>
<h3 class="group">Evidence threads</h3>${threads}
<h3 class="group">Changes</h3>${diffTable(diff)}
</section>`;
              });

        const past = proposals.ok
          ? proposals.value.filter((version) => version.state !== "draft")
          : [];
        const history =
          past.length === 0
            ? ""
            : card({
                title: "Past proposals",
                body: table(
                  [
                    { label: "Version" },
                    { label: "What it changed", className: "title-cell" },
                    { label: "Outcome" },
                    { label: "Proposed", right: true },
                  ],
                  past.map((version) => [
                    `<a href="/settings/versions/${String(version.id)}">v${String(version.id)}</a>`,
                    escapeHtml(version.message),
                    STATE_PILLS[version.state],
                    when(version.createdAt, now()),
                  ]),
                ),
              });

        sendHtml(
          response,
          200,
          layout(
            "Improvement",
            `${pageHead({
              title: "Improvement loop",
              lede: "Each night the improver may propose a config version that changes the factory's own instructions and skills. Nothing changes until you approve it; approving deploys it to every worker.",
            })}${notice(url)}${failed ? STORE_ERROR : ""}<div class="grid">${drafts.join("\n")}${history}</div>`,
            { section: "/improvement" },
          ),
        );
      },
    },
    {
      method: "POST",
      path: /^\/improvement\/(\d+)\/(approve|reject)$/,
      handle: async ({ response, params }) => {
        const id = Number(params[0]);
        const version = proposal(id);
        if (version === undefined) {
          sendHtml(
            response,
            404,
            layout(
              "Not found",
              `${pageHead({ title: "No such proposal" })}${empty("This is not an improver proposal.")}`,
              {
                section: "/improvement",
              },
            ),
          );
          return;
        }
        if (params[1] === "reject") {
          try {
            store.reject(id);
          } catch (error) {
            console.error(`Rejecting proposal ${String(id)} failed`, error);
            redirect(response, withNotice("/improvement", "proposal-refused"));
            return;
          }
          redirect(response, withNotice("/improvement", "proposal-rejected"));
          return;
        }
        try {
          store.approve(id);
        } catch (error) {
          console.error(`Approving proposal ${String(id)} failed`, error);
          redirect(response, withNotice("/improvement", "proposal-refused"));
          return;
        }
        if (factory.deploy === undefined) {
          redirect(response, withNotice("/improvement", "deploy-failed"));
          return;
        }
        try {
          const { hermesError } = await factory.deploy(id);
          redirect(
            response,
            withNotice("/improvement", hermesError === undefined ? "approved" : "hermes-failed"),
          );
        } catch (error) {
          console.error(`Deploying proposal ${String(id)} failed`, error);
          redirect(response, withNotice("/improvement", "deploy-failed"));
        }
      },
    },
  ];
}
