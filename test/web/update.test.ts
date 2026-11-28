import { afterEach, describe, expect, it } from "vitest";
import { startDashboard, type Dashboard } from "./dashboard.js";

let dashboard: Dashboard | undefined;

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
});

function fakeUpdater(state: {
  running: boolean;
  log?: string;
  exitCode?: number;
  refuse?: string;
}) {
  const started: number[] = [];
  return {
    started,
    updater: {
      start: () => {
        if (state.refuse !== undefined) throw new Error(state.refuse);
        started.push(1);
        state.running = true;
      },
      status: () => ({
        running: state.running,
        ...(state.log === undefined ? {} : { log: state.log }),
        ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
      }),
    },
  };
}

/** The HTML of the page section with this heading. */
function sectionNamed(html: string, title: string): string | undefined {
  return new RegExp(
    `<section class="sec"><div class="sec-head"><h2>${title}</h2>[^]*?</section>`,
  ).exec(html)?.[0];
}

const version = () => ({
  commit: "abcdef1234567890",
  behind: 2,
  command: "node /srv/hephaestus/dist/cli.js update",
});

describe("Update", () => {
  it("links from the sidebar when origin/main is ahead, and starts an update from its page", async () => {
    const fake = fakeUpdater({ running: false });
    dashboard = await startDashboard({ updater: fake.updater, version });

    const home = await dashboard.get("/");
    expect(home.html).toContain('<a href="/update">Update</a>');
    const page = await dashboard.get("/update");
    expect(page.status).toBe(200);
    // The button sits at the right of the page head, as on other pages with one main action.
    const head = /<div class="head">[^]*?<\/div><\/div>/.exec(page.html)?.[0];
    expect(head).toContain('action="/update"');
    expect(head).toContain("Update now");
    const versionSection = sectionNamed(page.html, "Version");
    expect(versionSection).toContain("<dt>Running</dt><dd><code>abcdef1</code></dd>");
    expect(versionSection).toContain("<dt>origin/main</dt><dd>2 new commits</dd>");
    expect(versionSection).toContain("node /srv/hephaestus/dist/cli.js update");

    const response = await dashboard.post("/update");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/update");
    expect(fake.started).toHaveLength(1);
  });

  it("shows an update notice with an Update now button on every page once origin/main is ahead", async () => {
    const fake = fakeUpdater({ running: false });
    let calls = 0;
    const updater = {
      ...fake.updater,
      status: () => {
        calls += 1;
        return fake.updater.status();
      },
    };
    let behind = 0;
    let updating = false;
    dashboard = await startDashboard({
      updater,
      version: () => ({ ...version(), behind }),
      updating: () => updating,
    });

    expect((await dashboard.get("/")).html).not.toContain("update-notice");

    behind = 2;
    for (const path of ["/", "/work", "/config"]) {
      const page = await dashboard.get(path);
      const notice = /<div class="box info update-notice"[^]*?<\/div><\/div>/.exec(page.html)?.[0];
      expect(notice, path).toContain("Update available");
      expect(notice, path).toContain("2 new commits on origin/main");
      expect(notice, path).toContain('action="/update"');
      expect(notice, path).toContain("Update now");
    }
    // Rendering the notice reads the update lock, never systemd.
    expect(calls).toBe(0);

    // The Update page has its own button, so it shows no notice.
    const own = await dashboard.get("/update");
    expect(own.html).not.toContain("update-notice");

    // An update holds the lock whether the dashboard or a shell started it.
    updating = true;
    const running = await dashboard.get("/");
    expect(running.html).toContain("Updating");
    expect(running.html).toContain('<a href="/update">');
    expect(running.html).not.toContain("Update now");
  });

  it("shows a running update's log and reloads until it finishes, then shows the result", async () => {
    const state = { running: true, log: "Fast-forwarded <a> to <b>\n" } as {
      running: boolean;
      log?: string;
      exitCode?: number;
    };
    dashboard = await startDashboard({ updater: fakeUpdater(state).updater, version });

    const running = await dashboard.get("/update");
    expect(running.html).toContain('http-equiv="refresh"');
    expect(running.html).toContain("Fast-forwarded &lt;a&gt; to &lt;b&gt;");
    expect(running.html).not.toContain('action="/update"');
    expect(sectionNamed(running.html, "Last run")).toContain("Running");

    state.running = false;
    state.exitCode = 1;
    const failed = await dashboard.get("/update");
    expect(failed.html).not.toContain('http-equiv="refresh"');
    expect(failed.html).toMatch(/did not finish|failed/i);
  });

  it("marks a finished update in its log's heading, without a callout", async () => {
    dashboard = await startDashboard({
      updater: fakeUpdater({ running: false, log: "Fast-forwarded a to b\n", exitCode: 0 }).updater,
      version: () => ({ ...version(), behind: 0 }),
    });

    const page = await dashboard.get("/update");
    expect(page.html).not.toContain('class="box');
    expect(sectionNamed(page.html, "Version")).toContain(
      "<dt>origin/main</dt><dd>Nothing newer at the last check</dd>",
    );
    const lastRun = sectionNamed(page.html, "Last run");
    expect(/<div class="sec-head">[^]*?<\/div>/.exec(lastRun ?? "")?.[0]).toContain(
      ">Finished</span>",
    );
    expect(lastRun).toContain("Fast-forwarded a to b");
  });

  it("says origin/main is unknown when the last fetch failed", async () => {
    dashboard = await startDashboard({
      updater: fakeUpdater({ running: false }).updater,
      version: () => ({
        commit: "abcdef1234567890",
        command: "node /srv/hephaestus/dist/cli.js update",
      }),
    });

    const page = await dashboard.get("/update");
    expect(sectionNamed(page.html, "Version")).toContain("<dt>origin/main</dt><dd>Unknown</dd>");
  });

  it("says when the last update stopped before it finished", async () => {
    dashboard = await startDashboard({
      updater: fakeUpdater({ running: false, log: "Fast-forwarded a to b\nnpm ci\n" }).updater,
      version,
    });

    const page = await dashboard.get("/update");
    expect(page.html).toContain("The last update stopped before it finished");
    expect(page.html).toContain("node /srv/hephaestus/dist/cli.js update");
  });

  it("does not point at a command it cannot show when an update stopped partway", async () => {
    dashboard = await startDashboard({
      updater: fakeUpdater({ running: false, log: "Fast-forwarded a to b\nnpm ci\n" }).updater,
    });

    const page = await dashboard.get("/update");
    expect(page.html).toContain("The last update stopped before it finished");
    expect(page.html).not.toContain("command below");
  });

  it("says why an update did not start", async () => {
    dashboard = await startDashboard({
      updater: fakeUpdater({ running: false, refuse: "An update is already running." }).updater,
      version,
    });

    const response = await dashboard.post("/update");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("An update is already running.");
  });

  it("has no update page when the service cannot update itself", async () => {
    dashboard = await startDashboard();
    expect((await dashboard.get("/update")).status).toBe(404);
  });
});
