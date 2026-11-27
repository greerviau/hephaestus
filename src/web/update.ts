import { escapeHtml, callout, layout, pageHead, postButton, section, empty } from "./html.js";
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
    const where =
      version === undefined
        ? ""
        : `<p>The service runs <code>${escapeHtml(version.commit.slice(0, 7))}</code>. ${
            version.behind === undefined
              ? "Whether origin/main is ahead is not known yet."
              : behind === 0
                ? "origin/main had nothing newer at the last check."
                : `${behind === 1 ? "1 new commit" : `${String(behind)} new commits`} on origin/main.`
          }</p>`;
    const state = run.running
      ? callout(
          "info",
          "Updating",
          "The service restarts near the end, so this page may fail to load for a few seconds. Reload it then.",
        )
      : run.exitCode === undefined
        ? ""
        : run.exitCode === 0
          ? callout("info", "The last update finished", "Its log is below.")
          : callout(
              "err",
              "The last update did not finish",
              "Its log below says why. A build that failed was rolled back, and the service runs the build it had.",
            );
    const refusal = refused === undefined ? "" : callout("err", "Not started", escapeHtml(refused));
    const button = run.running ? "" : postButton(PATH, "Update now", { variant: "primary" });
    const fallback =
      version === undefined
        ? ""
        : `<p class="hint">If the dashboard does not come back, run <code>${escapeHtml(version.command)}</code> on the Hermes host.</p>`;
    const log =
      run.log === undefined
        ? ""
        : section({ title: "Last run", body: `<pre class="block">${escapeHtml(run.log)}</pre>` });
    sendHtml(
      context.response,
      status,
      layout(
        "Update",
        `${pageHead({
          title: "Update",
          lede: "Fast-forwards the checkout the service runs from to origin/main, installs, builds, and restarts the service. A build that fails, or does not start, is rolled back.",
        })}${refusal}${state}${where}${button}${fallback}${log}`,
        {
          shell: context.shell,
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
          show(context, 409, error instanceof Error ? error.message : String(error));
          return;
        }
        redirect(context.response, PATH);
      },
    },
  ];
}
