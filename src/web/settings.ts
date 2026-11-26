import type { Change } from "../config/diff.js";
import { ConfigValidationError, MAX_CONFIG_BYTES } from "../config/document.js";
import { VersionNotFoundError, type ConfigStore, type ConfigVersion } from "../config/store.js";
import { ownerReason } from "./environments.js";
import {
  banner,
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
import { readBody, redirect, sendHtml, sendJson, type Route, type RouteContext } from "./http.js";

/**
 * Form encoding at most triples a config's UTF-8 bytes, so this fits any
 * config up to MAX_CONFIG_BYTES plus the rest of the form.
 */
const MAX_EDIT_BYTES = 3 * MAX_CONFIG_BYTES + 64 * 1024;

/** Publishes a version and deploys it to every worker. */
export type Deploy = (id: number) => Promise<{ hermesError?: string }>;

/** Settings: config versions, their diffs, and edits that create new versions. */
export function settingsRoutes(store: ConfigStore, deploy?: Deploy): Route[] {
  return [
    {
      method: "GET",
      path: /^\/settings$/,
      handle: (context) => {
        list(context);
      },
    },
    {
      method: "GET",
      path: /^\/settings\/versions\/(\d+)$/,
      handle: (context) => {
        show(context);
      },
    },
    { method: "POST", path: /^\/settings\/versions$/, handle: (context) => create(context) },
    {
      method: "POST",
      path: /^\/settings\/versions\/(\d+)\/(approve|reject|revert)$/,
      handle: (context) => act(context),
    },
    {
      method: "POST",
      path: /^\/settings\/versions\/(\d+)\/deploy$/,
      handle: async ({ response, params }) => {
        const id = Number(params[0]);
        if (deploy === undefined || find(id) === undefined) {
          sendHtml(response, 404, settingsPage("Not found", empty("No such config version.")));
          return;
        }
        try {
          const { hermesError } = await deploy(id);
          redirect(
            response,
            `/settings/versions/${String(id)}${hermesError === undefined ? "" : "?hermes=failed"}`,
          );
        } catch (error) {
          sendHtml(
            response,
            409,
            settingsPage(
              "Not deployed",
              `${banner("err", "Not deployed", ownerReason(error))}<p><a href="/settings/versions/${String(id)}">Back to version ${String(id)}</a></p>`,
            ),
          );
        }
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

  function list(
    { response }: RouteContext,
    problem?: { text: string; errors: string[]; parentId: string; message: string },
  ): void {
    const current = store.current();
    const rows = store
      .list()
      .map((version) => [
        `<a href="/settings/versions/${String(version.id)}">v${String(version.id)}</a>`,
        statePill(version.state),
        escapeHtml(version.author),
        when(version.createdAt, Date.now()),
        escapeHtml(version.message),
      ]);
    const text = problem?.text ?? editorText(current?.document ?? {});
    // A refused edit keeps the version it was built from, so retrying cannot change its base.
    const parentId = problem?.parentId ?? (current === undefined ? "" : String(current.id));
    const message = problem?.message ?? "";
    const errors =
      problem === undefined
        ? ""
        : `<div class="banner err" role="alert"><strong class="status s-crit">The draft was not saved</strong><ul>${problem.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>`;
    sendHtml(
      response,
      problem === undefined ? 200 : 400,
      settingsPage(
        "Settings",
        `<div class="grid">${card({
          title: "Config versions",
          meta: '<span class="meta">Newest first</span>',
          body:
            rows.length === 0
              ? empty("No config version yet.")
              : table(
                  [
                    { label: "Version" },
                    { label: "State" },
                    { label: "Author" },
                    { label: "Created" },
                    { label: "Message", className: "title-cell" },
                  ],
                  rows,
                ),
        })}${card({
          title: "Edit the config",
          body: `<p class="lede">Saving creates a draft version built from version ${parentId === "" ? "none" : escapeHtml(parentId)}. Nothing changes until the draft is approved and deployed.</p>
${errors}
<form method="post" action="/settings/versions" class="form-grid wide">
  <input type="hidden" name="parentId" value="${escapeHtml(parentId)}">
  <div class="field"><label for="message">What changed</label>
  <input type="text" id="message" name="message" value="${escapeHtml(message)}" required></div>
  <div class="field"><label for="document">Config</label>
  <textarea id="document" class="config" name="document" spellcheck="false">${escapeHtml(text)}</textarea></div>
  <div class="btn-row"><button type="submit" class="btn-primary">Save as a draft</button></div>
</form>`,
        })}</div>`,
      ),
    );
  }

  function show({ response, params, url }: RouteContext): void {
    const version = find(Number(params[0]));
    if (version === undefined) {
      sendHtml(response, 404, settingsPage("Not found", empty("No such config version.")));
      return;
    }
    const id = String(version.id);
    const conflicts = Number(url.searchParams.get("conflicts") ?? "0");
    const actions: string[] = [];
    if (version.state === "draft") {
      actions.push(
        button(id, "approve", deploy === undefined ? "Approve" : "Approve and deploy", "primary"),
        button(id, "reject", "Reject"),
      );
    }
    if (deploy !== undefined && (version.state === "approved" || version.state === "deployed")) {
      actions.push(
        button(
          id,
          "deploy",
          version.state === "deployed" ? "Deploy again to workers" : "Deploy",
          version.state === "approved" ? "primary" : "secondary",
        ),
      );
    }
    if (
      (version.state === "deployed" || version.state === "superseded") &&
      version.parentId !== null
    ) {
      actions.push(button(id, "revert", "Revert"));
    }
    const banners = [
      url.searchParams.get("deploy") === null
        ? ""
        : banner(
            "err",
            "Approved, but not deployed",
            "Deploying the version failed. Check that the config repo is named on the Workers page, then use Deploy. The service log has the error.",
          ),
      url.searchParams.get("hermes") === "failed"
        ? banner(
            "err",
            "The factory Hermes root was not updated",
            "The version is deployed, but applying it to the factory Hermes root failed. The service log has the error.",
          )
        : "",
      conflicts > 0
        ? banner(
            "info",
            "Some changes were left as they are",
            `${String(conflicts)} changes were left as they are, because a later version changed them again.`,
          )
        : "",
    ].join("");
    const built =
      version.parentId === null
        ? ""
        : `, built from <a href="/settings/versions/${String(version.parentId)}">version ${String(version.parentId)}</a>`;
    sendHtml(
      response,
      200,
      layout(
        `Version ${id}`,
        `${pageHead({
          title: `Config version ${id}`,
          crumbs: `<a href="/settings">Settings</a><span aria-hidden="true">/</span><span>v${id}</span>`,
          lede: `${statePill(version.state)} by ${escapeHtml(version.author)}, ${when(version.createdAt, Date.now())}${built}. ${escapeHtml(version.message)}`,
          ...(actions.length === 0 ? {} : { actions: actions.join("") }),
        })}${banners}<div class="grid">${card({
          title: "Changes",
          body: diffTable(store.diff(version.id)),
        })}${card({
          title: "Config",
          body: `<details class="more"><summary>Show the whole config</summary><pre class="block">${escapeHtml(JSON.stringify(version.document, null, 2))}</pre></details>`,
        })}</div>`,
        { section: "/settings" },
      ),
    );
  }

  async function create(context: RouteContext): Promise<void> {
    const { request, response } = context;
    const body = await readBody(request, MAX_EDIT_BYTES);
    if (body === undefined) {
      sendHtml(
        response,
        413,
        settingsPage("Too large", banner("err", "Too large", "The config is too large to save.")),
      );
      return;
    }
    const form = new URLSearchParams(body);
    const text = form.get("document") ?? "";
    const parent = form.get("parentId");
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (error) {
      list(context, {
        text,
        parentId: parent ?? "",
        message: form.get("message") ?? "",
        errors: [`The config is not valid JSON: ${String(error)}`],
      });
      return;
    }
    try {
      const version = store.createVersion({
        document: document as never,
        author: "owner",
        message: form.get("message") ?? "",
        ...(parent === null || parent === "" ? {} : { parentId: Number(parent) }),
      });
      redirect(response, `/settings/versions/${String(version.id)}`);
    } catch (error) {
      if (error instanceof ConfigValidationError)
        list(context, {
          text,
          parentId: parent ?? "",
          message: form.get("message") ?? "",
          errors: error.problems,
        });
      else if (error instanceof Error)
        list(context, {
          text,
          parentId: parent ?? "",
          message: form.get("message") ?? "",
          errors: [error.message],
        });
      else throw error;
    }
  }

  async function act({ response, params }: RouteContext): Promise<void> {
    const id = Number(params[0]);
    const action = params[1];
    if (find(id) === undefined) {
      sendHtml(response, 404, settingsPage("Not found", empty("No such config version.")));
      return;
    }
    try {
      if (action === "approve") {
        store.approve(id);
        // Approval deploys the version; a failed deploy can be retried from this page.
        if (deploy !== undefined) {
          try {
            const { hermesError } = await deploy(id);
            redirect(
              response,
              `/settings/versions/${String(id)}${hermesError === undefined ? "" : "?hermes=failed"}`,
            );
          } catch (error) {
            console.error(`Deploying version ${String(id)} failed`, error);
            redirect(response, `/settings/versions/${String(id)}?deploy=failed`);
          }
          return;
        }
      } else if (action === "reject") store.reject(id);
      else {
        const { version, conflicts } = store.revert(id, "owner");
        redirect(
          response,
          `/settings/versions/${String(version.id)}?conflicts=${String(conflicts.length)}`,
        );
        return;
      }
    } catch (error) {
      sendHtml(
        response,
        409,
        settingsPage(
          "Not allowed",
          `${banner("err", "Not allowed", ownerReason(error))}<p><a href="/settings/versions/${String(id)}">Back to version ${String(id)}</a></p>`,
        ),
      );
      return;
    }
    redirect(response, `/settings/versions/${String(id)}`);
  }
}

function summary(version: ConfigVersion): Omit<ConfigVersion, "document"> {
  return {
    id: version.id,
    parentId: version.parentId,
    state: version.state,
    author: version.author,
    message: version.message,
    createdAt: version.createdAt,
  };
}

function settingsPage(title: string, body: string): string {
  return layout(
    title,
    `${pageHead({ title: title === "Settings" ? "Settings" : title, lede: "The factory config as numbered versions. Edits create drafts; approving one deploys it." })}${body}`,
    { section: "/settings" },
  );
}

const STATE_PILLS: Record<ConfigVersion["state"], string> = {
  draft: pill("you", "draft"),
  approved: pill("wait", "approved"),
  deployed: pill("done", "deployed"),
  superseded: pill("off", "superseded"),
  rejected: pill("bad", "rejected"),
};

function statePill(state: ConfigVersion["state"]): string {
  return STATE_PILLS[state];
}

function button(
  id: string,
  action: string,
  label: string,
  variant: "primary" | "secondary" = "secondary",
): string {
  return postButton(`/settings/versions/${id}/${action}`, label, { variant, small: false });
}

function cell(value: unknown): string {
  return value === undefined
    ? '<em class="s-muted">absent</em>'
    : `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

/** A config version's changes, one row per changed path. */
export function diffTable(changes: Change[]): string {
  if (changes.length === 0) return empty("No changes.");
  return table(
    [{ label: "Path" }, { label: "Before" }, { label: "After" }],
    changes.map((change) => [
      `<code>${escapeHtml(change.path.join("."))}</code>`,
      cell(change.before),
      cell(change.after),
    ]),
  );
}

/** Pretty JSON for the editor, or compact JSON when pretty JSON could exceed the form limit. */
function editorText(document: unknown): string {
  const pretty = JSON.stringify(document, null, 2);
  return 3 * Buffer.byteLength(pretty) + 64 * 1024 <= MAX_EDIT_BYTES
    ? pretty
    : JSON.stringify(document);
}
