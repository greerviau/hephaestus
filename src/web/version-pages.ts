import { VersionNotFoundError, type ConfigVersion } from "../config/store.js";
import { configPage, configTab, refusal } from "./config-page.js";
import { ownerReason } from "./workers.js";
import { approveVersion, deployVersion } from "./versions.js";
import type { FactoryPages } from "./factory.js";
import {
  callout,
  dialog,
  dialogButton,
  empty,
  escapeHtml,
  fold,
  pageHead,
  rowList,
  section,
  statusText,
  when,
  type StatusTone,
} from "./html.js";
import { changeDiffs, description } from "./improvement.js";
import { redirect, sendHtml, sendJson, type Route, type RouteContext } from "./http.js";

const STATES: Record<ConfigVersion["state"], readonly [StatusTone, string]> = {
  draft: ["you", "Waiting for you"],
  approved: ["wait", "Approved"],
  deployed: ["done", "Deployed"],
  superseded: ["off", "Superseded"],
  rejected: ["bad", "Rejected"],
};

const SEP = " &middot; ";
/** How many versions the tab lists before it asks. */
const SHOWN = 20;
const PICKED_UP = "Workers pick it up once their running threads finish.";

function href(id: number): string {
  return `/config/versions/${String(id)}`;
}

/** The Versions tab, each version's page, and the actions that move a version between states. */
export function versionRoutes(factory: FactoryPages): Route[] {
  const { store, deploys } = factory;
  return [
    {
      method: "GET",
      path: /^\/config\/versions$/,
      handle: (context) => {
        list(context);
      },
    },
    {
      method: "GET",
      path: /^\/config\/versions\/(\d+)$/,
      handle: (context) => {
        show(context);
      },
    },
    {
      method: "POST",
      path: /^\/config\/versions\/(\d+)\/(approve|reject|revert|deploy)$/,
      handle: (context) => {
        act(context);
      },
    },
    {
      method: "GET",
      path: /^\/api\/config\/versions$/,
      handle: ({ response }) => {
        sendJson(response, 200, store.list().map(summary));
      },
    },
    {
      method: "GET",
      path: /^\/api\/config\/versions\/(\d+)$/,
      handle: ({ response, params }) => {
        const version = find(Number(params[0]));
        if (version === undefined) sendJson(response, 404, { error: "not found" });
        else sendJson(response, 200, { version, diff: store.diff(version.id) });
      },
    },
  ];

  function find(id: number): ConfigVersion | undefined {
    try {
      return store.get(id);
    } catch (error) {
      if (error instanceof VersionNotFoundError) return undefined;
      throw error;
    }
  }

  function notFound(context: RouteContext): void {
    sendHtml(
      context.response,
      404,
      configPage(
        context.shell,
        "No such version",
        `${pageHead({ title: "No such version" })}${empty('No such config version. <a href="/config/versions">Back to versions</a>')}`,
        [["Config", "/config/versions"], ["Not found"]],
      ),
    );
  }

  function list(context: RouteContext): void {
    const versions = store.list();
    const all = context.url.searchParams.get("all") === "1";
    const shown = all ? versions : versions.slice(0, SHOWN);
    const rows = shown.map((version) => ({
      title: `v${String(version.id)} ${version.title}`.trim(),
      href: href(version.id),
      wholeRow: true,
      sub: `${escapeHtml(version.author)}${SEP}${when(version.createdAt, Date.now())}`,
      aside: statusText(...STATES[version.state]),
    }));
    const older = versions.length - shown.length;
    sendHtml(
      context.response,
      200,
      configTab(
        factory,
        context,
        "versions",
        rows.length === 0
          ? empty("No config version yet.")
          : `${rowList(rows)}${older > 0 ? `<a class="more-link" href="/config/versions?all=1">Show ${String(older)} older</a>` : ""}`,
      ),
    );
  }

  function show(context: RouteContext): void {
    const { url } = context;
    const version = find(Number(context.params[0]));
    if (version === undefined) {
      notFound(context);
      return;
    }
    const v = `v${String(version.id)}`;
    const here = href(version.id);
    const actions: string[] = [];
    const dialogs: string[] = [];
    if (version.state === "draft") {
      const label = deploys === undefined ? "Approve" : "Approve and deploy";
      actions.push(
        dialogButton("approve-version", label, { variant: "primary" }),
        dialogButton("reject-version", "Reject"),
      );
      dialogs.push(
        dialog({
          id: "approve-version",
          title: `Approve ${v}`,
          body:
            deploys === undefined
              ? `<p>Approve config ${v}?</p>`
              : `<p>Approve config ${v} and deploy it to every worker?</p><p class="muted">${PICKED_UP}</p>`,
          action: `${here}/approve`,
          submit: `${label} ${v}`,
        }),
        dialog({
          id: "reject-version",
          title: `Reject ${v}`,
          body: `<p>Reject config ${v}? It will never deploy.</p>`,
          action: `${here}/reject`,
          submit: `Reject ${v}`,
          danger: true,
        }),
      );
    }
    if (deploys !== undefined && (version.state === "approved" || version.state === "deployed")) {
      const again = version.state === "deployed";
      // A second start joins the deploy under way, so the button would do nothing.
      const busy = deploys.has(version.id);
      actions.push(
        dialogButton("deploy-version", again ? "Deploy again" : "Deploy", {
          ...(again ? {} : { variant: "primary" as const }),
          ...(busy
            ? { disabled: true, title: `Version ${String(version.id)} is deploying now.` }
            : {}),
        }),
      );
      dialogs.push(
        dialog({
          id: "deploy-version",
          title: `Deploy ${v}`,
          body: `<p>Deploy config ${v} to every worker${again ? " again" : ""}?</p><p class="muted">It is published to the config repo and applied to the factory's Hermes. ${PICKED_UP}</p>`,
          action: `${here}/deploy`,
          submit: `Deploy ${v}`,
        }),
      );
    }
    if (
      (version.state === "deployed" || version.state === "superseded") &&
      version.parentId !== null
    ) {
      actions.push(
        dialogButton(
          "revert-version",
          "Revert",
          store.canRevert(version.id)
            ? {}
            : {
                disabled: true,
                title: "Nothing to revert: reverting this version would change nothing.",
              },
        ),
      );
      dialogs.push(
        dialog({
          id: "revert-version",
          title: `Revert ${v}`,
          body: `<p>Create a draft that undoes the changes of ${v}?</p><p class="muted">Changes a later version changed again are left as they are. Nothing deploys until you approve the draft.</p>`,
          action: `${here}/revert`,
          submit: "Create the revert draft",
        }),
      );
    }
    const conflicts = Number(url.searchParams.get("conflicts") ?? "0");
    const notes = [
      Number.isInteger(conflicts) && conflicts > 0
        ? callout(
            "info",
            "Some changes were left as they are",
            `${String(conflicts)} ${conflicts === 1 ? "change was" : "changes were"} left as ${conflicts === 1 ? "it is" : "they are"}, because a later version changed ${conflicts === 1 ? "it" : "them"} again.`,
          )
        : "",
    ].join("");
    const built =
      version.parentId === null
        ? ""
        : `${SEP}built from <a href="${href(version.parentId)}">v${String(version.parentId)}</a>`;
    const diff = store.diff(version.id);
    sendHtml(
      context.response,
      200,
      configPage(
        context.shell,
        `Version ${String(version.id)}`,
        `${pageHead({
          title: `${v} ${version.title}`.trim(),
          lede: `${statusText(...STATES[version.state])}${SEP}by ${escapeHtml(version.author)}, ${when(version.createdAt, Date.now())}${built}`,
          ...(actions.length === 0 ? {} : { actions: actions.join("") }),
        })}${notes}${description(version)}${section({
          title: "Changes",
          count: diff.length,
          body: changeDiffs(diff),
        })}${fold(
          "Show the whole config",
          `<pre class="block">${escapeHtml(JSON.stringify(version.document, null, 2))}</pre>`,
        )}${dialogs.join("")}`,
        [["Config", "/config/versions"], [v]],
      ),
    );
  }

  function act(context: RouteContext): void {
    const { response, params } = context;
    const id = Number(params[0]);
    const action = params[1];
    if (find(id) === undefined || (action === "deploy" && deploys === undefined)) {
      notFound(context);
      return;
    }
    const here = href(id);
    const refuse = (title: string, error: unknown): void => {
      sendHtml(
        response,
        409,
        refusal(context.shell, title, ownerReason(error), here, `Back to version ${String(id)}`),
      );
    };
    if (action === "deploy") {
      try {
        if (deploys !== undefined) deployVersion(store, deploys, id);
        redirect(response, here);
      } catch (error) {
        refuse("Not deployed", error);
      }
      return;
    }
    try {
      if (action === "revert") {
        const { version, conflicts } = store.revert(id, "owner");
        redirect(response, `${href(version.id)}?conflicts=${String(conflicts.length)}`);
        return;
      }
      // Approval starts the deploy, which runs in the background; a failed one can be retried from the page.
      if (action === "reject") store.reject(id);
      else approveVersion(store, deploys, id);
    } catch (error) {
      refuse("Not allowed", error);
      return;
    }
    redirect(response, here);
  }
}

function summary(version: ConfigVersion): Omit<ConfigVersion, "document"> {
  return {
    id: version.id,
    parentId: version.parentId,
    state: version.state,
    author: version.author,
    title: version.title,
    message: version.message,
    createdAt: version.createdAt,
  };
}
