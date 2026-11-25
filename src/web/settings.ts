import type { Change } from "../config/diff.js";
import { ConfigValidationError, MAX_CONFIG_BYTES } from "../config/document.js";
import { VersionNotFoundError, type ConfigStore, type ConfigVersion } from "../config/store.js";
import { escapeHtml, layout } from "./html.js";
import { readBody, redirect, sendHtml, sendJson, type Route, type RouteContext } from "./http.js";

/**
 * Form encoding at most triples a config's UTF-8 bytes, so this fits any
 * config up to MAX_CONFIG_BYTES plus the rest of the form.
 */
const MAX_EDIT_BYTES = 3 * MAX_CONFIG_BYTES + 64 * 1024;

/** Settings: config versions, their diffs, and edits that create new versions. */
export function settingsRoutes(store: ConfigStore): Route[] {
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

  function list(
    { response }: RouteContext,
    problem?: { text: string; errors: string[]; parentId: string; message: string },
  ): void {
    const current = store.current();
    const rows = store
      .list()
      .map(
        (version) => `<tr>
  <td><a href="/settings/versions/${String(version.id)}">${String(version.id)}</a></td>
  <td>${escapeHtml(version.state)}</td>
  <td>${escapeHtml(version.author)}</td>
  <td>${escapeHtml(version.createdAt)}</td>
  <td>${escapeHtml(version.message)}</td>
</tr>`,
      )
      .join("\n");
    const text = problem?.text ?? editorText(current?.document ?? {});
    // A refused edit keeps the version it was built from, so retrying cannot change its base.
    const parentId = problem?.parentId ?? (current === undefined ? "" : String(current.id));
    const message = problem?.message ?? "";
    const errors =
      problem === undefined
        ? ""
        : `<ul class="error">${problem.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>`;
    sendHtml(
      response,
      problem === undefined ? 200 : 400,
      layout(
        "Settings",
        `<h1>Settings</h1>
<h2>Config versions</h2>
<table>
<thead><tr><th>Version</th><th>State</th><th>Author</th><th>Created</th><th>Message</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<h2>Edit the config</h2>
<p>Saving creates a draft version built from version ${parentId === "" ? "none" : escapeHtml(parentId)}. Nothing changes until the draft is approved and deployed.</p>
${errors}
<form method="post" action="/settings/versions">
  <input type="hidden" name="parentId" value="${escapeHtml(parentId)}">
  <label for="message">What changed</label>
  <input id="message" name="message" value="${escapeHtml(message)}" required>
  <label for="document">Config</label>
  <textarea id="document" name="document" spellcheck="false">${escapeHtml(text)}</textarea>
  <button type="submit">Save as a draft</button>
</form>`,
      ),
    );
  }

  function show({ response, params, url }: RouteContext): void {
    const version = find(Number(params[0]));
    if (version === undefined) {
      sendHtml(response, 404, layout("Not found", "<p>No such config version.</p>"));
      return;
    }
    const id = String(version.id);
    const conflicts = Number(url.searchParams.get("conflicts") ?? "0");
    const actions: string[] = [];
    if (version.state === "draft") {
      actions.push(button(id, "approve", "Approve"), button(id, "reject", "Reject"));
    }
    if (
      (version.state === "deployed" || version.state === "superseded") &&
      version.parentId !== null
    ) {
      actions.push(button(id, "revert", "Revert"));
    }
    sendHtml(
      response,
      200,
      layout(
        `Version ${id}`,
        `<h1>Config version ${id}</h1>
<p>${escapeHtml(version.state)}, by ${escapeHtml(version.author)}, ${escapeHtml(version.createdAt)}${
          version.parentId === null
            ? ""
            : `, built from <a href="/settings/versions/${String(version.parentId)}">version ${String(version.parentId)}</a>`
        }</p>
<p>${escapeHtml(version.message)}</p>
${
  conflicts > 0
    ? `<p class="error">${String(conflicts)} changes were left as they are, because a later version changed them again.</p>`
    : ""
}
<div class="actions">${actions.join("")}</div>
<h2>Changes</h2>
${diffTable(store.diff(version.id))}
<h2>Config</h2>
<pre>${escapeHtml(JSON.stringify(version.document, null, 2))}</pre>`,
      ),
    );
  }

  async function create(context: RouteContext): Promise<void> {
    const { request, response } = context;
    const body = await readBody(request, MAX_EDIT_BYTES);
    if (body === undefined) {
      sendHtml(response, 413, layout("Too large", "<p>The config is too large to save.</p>"));
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

  function act({ response, params }: RouteContext): void {
    const id = Number(params[0]);
    const action = params[1];
    if (find(id) === undefined) {
      sendHtml(response, 404, layout("Not found", "<p>No such config version.</p>"));
      return;
    }
    try {
      if (action === "approve") store.approve(id);
      else if (action === "reject") store.reject(id);
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
        layout("Not allowed", `<p class="error">${escapeHtml(String(error))}</p>`),
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

function button(id: string, action: string, label: string): string {
  return `<form method="post" action="/settings/versions/${id}/${action}"><button type="submit">${label}</button></form>`;
}

function cell(value: unknown): string {
  return value === undefined
    ? "<em>absent</em>"
    : `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function diffTable(changes: Change[]): string {
  if (changes.length === 0) return "<p>No changes.</p>";
  const rows = changes
    .map(
      (change) =>
        `<tr><td><code>${escapeHtml(change.path.join("."))}</code></td><td>${cell(change.before)}</td><td>${cell(change.after)}</td></tr>`,
    )
    .join("\n");
  return `<table>
<thead><tr><th>Path</th><th>Before</th><th>After</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

/** Pretty JSON for the editor, or compact JSON when pretty JSON could exceed the form limit. */
function editorText(document: unknown): string {
  const pretty = JSON.stringify(document, null, 2);
  return 3 * Buffer.byteLength(pretty) + 64 * 1024 <= MAX_EDIT_BYTES
    ? pretty
    : JSON.stringify(document);
}
