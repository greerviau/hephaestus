import type { Change } from "../config/diff.js";
import { VersionNotFoundError, isProposal, type ConfigVersion } from "../config/store.js";
import { STORE_ERROR, notice, read, threadHref, withNotice, type FactoryPages } from "./factory.js";
import {
  dialog,
  dialogButton,
  empty,
  escapeHtml,
  layout,
  pageHead,
  rowList,
  section,
  statusText,
  when,
  type StatusTone,
} from "./html.js";
import { redirect, sendHtml, type Route, type RouteContext } from "./http.js";

const STATES: Record<ConfigVersion["state"], readonly [StatusTone, string]> = {
  draft: ["you", "Waiting for you"],
  approved: ["wait", "Approved"],
  deployed: ["done", "Deployed"],
  superseded: ["off", "Superseded"],
  rejected: ["bad", "Rejected"],
};

const SEP = " &middot; ";
const APPROVE_DIALOG = "approve-proposal";
const REJECT_DIALOG = "reject-proposal";

function stateText(version: ConfigVersion): string {
  return statusText(...STATES[version.state]);
}

function count(n: number, one: string): string {
  return `${String(n)} ${one}${n === 1 ? "" : "s"}`;
}

/** A value as the lines a diff shows: text as it is, anything else as JSON. */
function lines(value: unknown): string[] {
  if (value === undefined) return [];
  return (typeof value === "string" ? value : JSON.stringify(value, null, 2)).split("\n");
}

/**
 * A config version's changes, one scrollable diff per changed path. Lines
 * that open or close both sides unchanged are counted instead of shown, so a
 * one-line edit to a long instruction text reads as one line.
 */
export function changeDiffs(changes: readonly Change[]): string {
  if (changes.length === 0) return empty("No changes.");
  return changes
    .map((change) => {
      const path = escapeHtml(change.path.join("."));
      const before = lines(change.before);
      const after = lines(change.after);
      const shorter = Math.min(before.length, after.length);
      let lead = 0;
      while (lead < shorter && before[lead] === after[lead]) lead += 1;
      let tail = 0;
      while (
        tail < shorter - lead &&
        before[before.length - 1 - tail] === after[after.length - 1 - tail]
      ) {
        tail += 1;
      }
      const context = (n: number): string =>
        n === 0 ? "" : `<div class="ln ctx">  ${count(n, "unchanged line")}</div>`;
      const side = (all: string[], kind: "del" | "add"): string =>
        all
          .slice(lead, all.length - tail)
          .map(
            (line) =>
              `<div class="ln ${kind}">${kind === "del" ? "-" : "+"} ${escapeHtml(line)}</div>`,
          )
          .join("");
      return `<div class="diff" tabindex="0" role="region" aria-label="Changes to ${path}"><div class="path">${path}</div>${context(lead)}${side(before, "del")}${side(after, "add")}${context(tail)}</div>`;
    })
    .join("");
}

/** The Proposals pages: the improver's proposals with their diff and evidence, and the owner's gate. */
export function improvementRoutes(factory: FactoryPages): Route[] {
  const now = factory.now ?? Date.now;
  const { store } = factory;

  function proposal(id: number): ConfigVersion | undefined {
    try {
      const version = store.get(id);
      return isProposal(version) ? version : undefined;
    } catch (error) {
      if (error instanceof VersionNotFoundError) return undefined;
      throw error;
    }
  }

  function notFound({ response, shell }: RouteContext): void {
    sendHtml(
      response,
      404,
      layout(
        "Not found",
        `${pageHead({ title: "No such proposal" })}${empty("This is not a proposal.")}`,
        { section: "/proposals", shell, crumbs: [["Proposals", "/proposals"], ["Not found"]] },
      ),
    );
  }

  return [
    {
      method: "GET",
      path: /^\/proposals$/,
      handle: ({ response, url, shell }) => {
        const proposals = read("proposals", () => store.list().filter(isProposal));
        const pending = read("proposal details", () =>
          (proposals.ok ? proposals.value : [])
            .filter((version) => version.state === "draft")
            .map((version) => ({
              version,
              changes: store.diff(version.id).length,
              evidence: factory.mcp.evidence(version.id).length,
            })),
        );
        const failed = !proposals.ok || !pending.ok;

        const waiting = !pending.ok
          ? section({ title: "Waiting for you", body: empty("Proposals could not be read.") })
          : section({
              title: "Waiting for you",
              count: pending.value.length,
              body:
                pending.value.length === 0
                  ? empty(
                      "No proposal is waiting. The improver files one when the factory's threads show a change worth making.",
                    )
                  : rowList(
                      pending.value.map(({ version, changes, evidence }) => ({
                        title: `v${String(version.id)} ${version.message}`,
                        href: `/proposals/${String(version.id)}`,
                        wholeRow: true,
                        sub: [
                          `Proposed ${when(version.createdAt, now())}`,
                          count(changes, "change"),
                          count(evidence, "evidence thread"),
                        ].join(SEP),
                        aside: '<span class="btn">Review</span>',
                      })),
                    ),
            });

        const past = proposals.ok
          ? proposals.value.filter((version) => version.state !== "draft")
          : [];
        const history =
          past.length === 0
            ? ""
            : section({
                title: "Past proposals",
                count: past.length,
                body: rowList(
                  past.map((version) => ({
                    title: `v${String(version.id)} ${version.message}`,
                    href: `/config/versions/${String(version.id)}`,
                    wholeRow: true,
                    sub: when(version.createdAt, now()),
                    aside: stateText(version),
                  })),
                ),
              });

        sendHtml(
          response,
          200,
          layout(
            "Proposals",
            `${pageHead({
              title: "Proposals",
              lede: "Config changes the improver suggests from the factory's own threads, which it may file each night, and starter skills a Hephaestus update brings. Nothing changes until you approve one; approving deploys it to every worker.",
            })}${notice(url)}${failed ? STORE_ERROR : ""}${waiting}${history}`,
            { section: "/proposals", shell },
          ),
        );
      },
    },
    {
      method: "GET",
      path: /^\/proposals\/(\d+)$/,
      handle: (context) => {
        const { response, url, params, shell } = context;
        const id = Number(params[0]);
        const loaded = read("a proposal", () => {
          const version = proposal(id);
          return version === undefined
            ? undefined
            : { version, diff: store.diff(id), evidence: factory.mcp.evidence(id) };
        });
        if (!loaded.ok) {
          sendHtml(
            response,
            200,
            layout("Proposal", `${pageHead({ title: `Proposal v${String(id)}` })}${STORE_ERROR}`, {
              section: "/proposals",
              shell,
              crumbs: [["Proposals", "/proposals"], [`v${String(id)}`]],
            }),
          );
          return;
        }
        if (loaded.value === undefined) {
          notFound(context);
          return;
        }
        const { version, diff, evidence } = loaded.value;
        const name = `v${String(id)}`;
        const draft = version.state === "draft";
        const head = pageHead({
          title: `${name} ${version.message}`,
          lede: [
            stateText(version),
            `proposed ${when(version.createdAt, now())}`,
            `built on v${String(version.parentId ?? "-")}`,
          ].join(SEP),
          ...(draft
            ? {
                actions: `${dialogButton(APPROVE_DIALOG, "Approve and deploy", { variant: "primary" })}${dialogButton(REJECT_DIALOG, "Reject")}`,
              }
            : {}),
        });
        const threads =
          evidence.length === 0
            ? empty("The proposal cites no threads.")
            : rowList(
                evidence.map((item) => ({
                  title: `${item.threadId} on ${item.environmentId}`,
                  href: threadHref(item),
                  wholeRow: true,
                  sub: item.note === "" ? undefined : escapeHtml(item.note),
                })),
              );
        const dialogs = draft
          ? `${dialog({
              id: APPROVE_DIALOG,
              title: `Approve ${name}`,
              body: `<p>Deploy config ${name} to every worker?</p><p class="muted">Workers pick it up once their running threads finish.</p>`,
              action: `/proposals/${String(id)}/approve`,
              submit: `Approve and deploy ${name}`,
            })}${dialog({
              id: REJECT_DIALOG,
              title: `Reject ${name}`,
              body: `<p>Reject config ${name}? It will never deploy.</p>`,
              action: `/proposals/${String(id)}/reject`,
              submit: `Reject ${name}`,
              danger: true,
            })}`
          : "";
        sendHtml(
          response,
          200,
          layout(
            `Proposal ${name}`,
            `${head}${notice(url)}${section({ title: "Changes", count: diff.length, body: changeDiffs(diff) })}${section(
              { title: "Evidence threads", count: evidence.length, body: threads },
            )}${dialogs}`,
            { section: "/proposals", shell, crumbs: [["Proposals", "/proposals"], [name]] },
          ),
        );
      },
    },
    {
      method: "POST",
      path: /^\/proposals\/(\d+)\/(approve|reject)$/,
      handle: async (context) => {
        const { response, params } = context;
        const id = Number(params[0]);
        if (proposal(id) === undefined) {
          notFound(context);
          return;
        }
        // A refusal returns to the proposal, which shows the state that caused it.
        const refused = withNotice(`/proposals/${String(id)}`, "proposal-refused");
        if (params[1] === "reject") {
          try {
            store.reject(id);
          } catch (error) {
            console.error(`Rejecting proposal ${String(id)} failed`, error);
            redirect(response, refused);
            return;
          }
          redirect(response, withNotice("/proposals", "proposal-rejected"));
          return;
        }
        try {
          store.approve(id);
        } catch (error) {
          console.error(`Approving proposal ${String(id)} failed`, error);
          redirect(response, refused);
          return;
        }
        if (factory.deploy === undefined) {
          redirect(response, withNotice("/proposals", "deploy-failed"));
          return;
        }
        try {
          const { hermesError } = await factory.deploy(id);
          redirect(
            response,
            withNotice("/proposals", hermesError === undefined ? "approved" : "hermes-failed"),
          );
        } catch (error) {
          console.error(`Deploying proposal ${String(id)} failed`, error);
          redirect(response, withNotice("/proposals", "deploy-failed"));
        }
      },
    },
  ];
}
