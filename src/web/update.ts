import { UpdateRunningError } from "../self-update.js";
import {
  escapeHtml,
  callout,
  keyValues,
  layout,
  pageHead,
  postButton,
  section,
  statusText,
  empty,
} from "./html.js";
import type { FactoryPages } from "./factory.js";
import { sendHtml, redirect, type Route, type RouteContext } from "./http.js";

const PATH = "/update";
/** How often the page reloads while an update runs. */
const RELOAD_SECONDS = 3;

/** The update page: start `update` on the Hermes host, and follow its log. */
export function updateRoutes(factory: FactoryPages): Route[] {
  function show(context: RouteContext, status: number, refused?: string): void {
    const { updater } = factory;
    if (updater === undefined) {
      sendHtml(
        context.response,
        404,
        layout(
          "Not found",
          `${pageHead({ title: "No update here" })}${empty("This service cannot update itself.")}`,
          { shell: context.shell },
        ),
      );
      return;
    }
    const version = factory.version?.();
    const run = updater.status();
    const behind = version?.behind ?? 0;
    const versionSection =
      version === undefined
        ? ""
        : section({
            title: "Version",
            body: `<div class="sec-body">${keyValues([
              ["Running", `<code>${escapeHtml(version.commit.slice(0, 7))}</code>`],
              [
                "origin/main",
                version.behind === undefined
                  ? "Not checked yet"
                  : behind === 0
                    ? "Nothing newer at the last check"
                    : behind === 1
                      ? "1 new commit"
                      : `${String(behind)} new commits`,
              ],
            ])}<p class="hint">If the dashboard does not come back after an update, run <code>${escapeHtml(version.command)}</code> on the Hermes host.</p></div>`,
          });
    // A finished run needs no callout: the status beside the log says so.
    const state = run.running
      ? callout(
          "info",
          "Updating",
          "The service restarts near the end, so this page may fail to load for a few seconds. Reload it then.",
        )
      : run.log === undefined || run.exitCode === 0
        ? ""
        : run.exitCode === undefined
          ? callout(
              "err",
              "The last update stopped before it finished",
              "It was stopped, or the host restarted, partway through, so the checkout may be half updated. Run the command below on the Hermes host to finish it or roll it back.",
            )
          : callout("err", "The last update did not finish", "Its log below says why.");
    const refusal = refused === undefined ? "" : callout("err", "Not started", escapeHtml(refused));
    const outcome = run.running
      ? statusText("run", "Running")
      : run.exitCode === undefined
        ? statusText("bad", "Stopped")
        : run.exitCode === 0
          ? statusText("done", "Finished")
          : statusText("bad", "Failed");
    const log =
      run.log === undefined
        ? ""
        : section({
            title: "Last run",
            right: outcome,
            body: `<div class="sec-body"><pre class="block">${escapeHtml(run.log)}</pre></div>`,
          });
    sendHtml(
      context.response,
      status,
      layout(
        "Update",
        `${pageHead({
          title: "Update",
          lede: "Pulls origin/main, builds, and restarts the service. A failed build rolls back.",
          ...(run.running
            ? {}
            : { actions: postButton(PATH, "Update now", { variant: "primary" }) }),
        })}${refusal}${state}${versionSection}${log}`,
        {
          shell: context.shell,
          updateNotice: false,
          ...(run.running ? { refreshSeconds: RELOAD_SECONDS } : {}),
        },
      ),
    );
  }

  return [
    {
      method: "GET",
      path: /^\/update$/,
      handle: (context) => {
        show(context, 200);
      },
    },
    {
      method: "POST",
      path: /^\/update$/,
      handle: (context) => {
        const { updater } = factory;
        if (updater === undefined) {
          show(context, 404);
          return;
        }
        try {
          updater.start();
        } catch (error) {
          // Another update running is a conflict; systemd refusing is the server's failure.
          show(
            context,
            error instanceof UpdateRunningError ? 409 : 503,
            error instanceof Error ? error.message : String(error),
          );
          return;
        }
        redirect(context.response, PATH);
      },
    },
  ];
}
