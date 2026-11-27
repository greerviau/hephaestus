import { afterEach, describe, expect, it } from "vitest";
import type { FactoryConfig } from "../../src/config/document.js";
import { sampleConfig } from "../config/fixtures.js";
import { startDashboard, type Dashboard, type DashboardOptions } from "./dashboard.js";

let dashboard: Dashboard;
let deployed: number[];

/** A dashboard whose deploy step marks the version deployed, as the real one does. */
async function start(options: DashboardOptions = {}, withDeploy = false): Promise<Dashboard> {
  deployed = [];
  dashboard = await startDashboard({
    configRepo: "octo/hephaestus-config",
    ...options,
    ...(withDeploy
      ? {
          deploy: (id) => {
            deployed.push(id);
            dashboard.store.markDeployed(id);
            return Promise.resolve({});
          },
        }
      : {}),
  });
  return dashboard;
}

afterEach(async () => {
  await dashboard.close();
});

const TABS = [
  "/config",
  "/config/models",
  "/config/agents",
  "/config/versions",
  "/config/json",
] as const;

const FACTORY_FIELDS = {
  parentId: "1",
  "limits.tasksPerWorker": "2",
  "limits.threadsPerWorker": "2",
  "limits.threads": "4",
  "limits.startsPerDay": "40",
  triageAlertMinutes: "30",
};

const MODEL_FIELDS = {
  parentId: "1",
  "claude.model": "claude-sonnet-5-5",
  "codex.model": "gpt-6.2-sol",
  "setup.model": "claude-sonnet-5-5",
  "setup.instanceId": "claudeAgent",
};

function deployVersion(document = sampleConfig(), parentId = 1): number {
  const version = dashboard.store.createVersion({
    document,
    author: "owner",
    message: "",
    parentId,
  });
  dashboard.store.approve(version.id);
  dashboard.store.markDeployed(version.id);
  return version.id;
}

describe("Config page", () => {
  it.each(TABS)("shows the config repo above the tabs on %s", async (path) => {
    await start();

    const { status, html } = await dashboard.get(path);

    expect(status).toBe(200);
    expect(html).toContain("<code>octo/hephaestus-config</code>");
    expect(html).toContain('action="/config/repo"');
    expect(html.indexOf("octo/hephaestus-config")).toBeLessThan(
      html.indexOf('aria-label="Config sections"'),
    );
    expect(html).toContain(`<a href="${path}" aria-current="page">`);
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it.each(TABS)("asks for the config repo in a warning on %s when none is named", async (path) => {
    dashboard = await startDashboard();

    const { html } = await dashboard.get(path);

    expect(html).toContain('<div class="box warn">');
    expect(html).toContain("Name the config repo");
    expect(html).toContain('action="/config/repo"');
    expect(html).toContain('name="slug"');
  });

  it("saves the config repo and returns to the tab it was changed on", async () => {
    dashboard = await startDashboard();

    const response = await dashboard.post("/config/repo", {
      slug: " octo/config ",
      back: "/config/models",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/config/models");
    expect((await dashboard.get("/config")).html).toContain("<code>octo/config</code>");
  });

  it("refuses a config repo that is not owner/name", async () => {
    await start();

    const response = await dashboard.post("/config/repo", { slug: "not a repo" });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Name the repo as owner/name.");
    expect((await dashboard.get("/config")).html).toContain("octo/hephaestus-config");
  });

  it("serves nothing at the old paths", async () => {
    await start();

    for (const path of ["/settings", "/settings/versions/1", "/model"]) {
      expect((await dashboard.get(path)).status).toBe(404);
    }
    expect((await dashboard.post("/settings/factory", FACTORY_FIELDS)).status).toBe(404);
    expect((await dashboard.post("/environments/config-repo", { slug: "a/b" })).status).toBe(404);
  });
});

describe("Factory tab", () => {
  it("shows the limits and schedules, and leaves the models to the Models tab", async () => {
    await start();
    const withCron = sampleConfig();
    withCron.roles.improver.cron = [{ name: "nightly", schedule: "0 3 * * *", prompt: "Improve." }];
    const id = deployVersion(withCron);

    const { html } = await dashboard.get("/config");

    expect(html).toContain('action="/config/factory"');
    expect(html).toContain('name="limits.threads" min="0" step="1" value="4"');
    expect(html).toContain('name="triageAlertMinutes" min="0" step="1" value="30"');
    expect(html).toContain('name="cron.improver.nightly.time" value="03:00"');
    expect(html).toContain('<label for="f-threads">Threads in all</label>');
    expect(html).toContain("Deploy now");
    expect(html).toContain(`built from version ${String(id)}`);
    expect(html).not.toContain('name="claude.model"');
  });

  it("saves changed limits and a schedule as an approved version, and keeps the models", async () => {
    await start();
    const withCron = sampleConfig();
    withCron.roles.improver.cron = [{ name: "nightly", schedule: "0 3 * * *", prompt: "Improve." }];
    withCron.factory.models.codex = { model: "gpt-6.2-sol", options: { effort: "high" } };
    const id = deployVersion(withCron);

    const response = await dashboard.post("/config/factory", {
      parentId: String(id),
      "limits.tasksPerWorker": "3",
      "limits.threadsPerWorker": "1",
      "limits.threads": "2",
      "limits.startsPerDay": "10",
      triageAlertMinutes: "0",
      "cron.improver.nightly.on": "1",
      "cron.improver.nightly.time": "03:00",
      "cron.improver.nightly.custom": "every 12h",
      deploy: "on",
    });

    expect(response.status).toBe(303);
    // Without a deploy step, the approved version's page offers the deploy.
    expect(response.headers.get("location")).toBe(`/config/versions/${String(id + 1)}`);
    const saved = dashboard.store.list()[0];
    expect(saved?.state).toBe("approved");
    expect(saved?.message).toBe("Change the factory settings");
    expect(saved?.document.factory.limits).toEqual({
      tasksPerWorker: 3,
      threadsPerWorker: 1,
      threads: 2,
      startsPerDay: 10,
    });
    expect(saved?.document.factory.triageAlertMinutes).toBe(0);
    expect(saved?.document.factory.models.codex).toEqual(withCron.factory.models.codex);
    expect(saved?.document.roles.improver.cron?.[0]?.schedule).toBe("every 12h");
  });

  it("deploys the saved version and says so on the tab", async () => {
    await start({}, true);

    const response = await dashboard.post("/config/factory", {
      ...FACTORY_FIELDS,
      "limits.threads": "6",
      deploy: "on",
    });

    expect(response.headers.get("location")).toBe("/config?saved=2");
    expect(deployed).toEqual([2]);
    const { html } = await dashboard.get("/config?saved=2");
    expect(html).toContain("Version 2 is saved and deploying.");
    expect(html).toContain('name="limits.threads" min="0" step="1" value="6"');
  });

  it("keeps the version a draft when Deploy now is not ticked", async () => {
    await start({}, true);

    const response = await dashboard.post("/config/factory", {
      ...FACTORY_FIELDS,
      "limits.threads": "6",
    });

    expect(response.headers.get("location")).toBe("/config/versions/2");
    expect(dashboard.store.get(2).state).toBe("draft");
    expect(deployed).toEqual([]);
  });

  it("refuses a bad number and a stale form, and saves nothing", async () => {
    await start();

    const bad = await dashboard.post("/config/factory", {
      ...FACTORY_FIELDS,
      "limits.threadsPerWorker": "-1",
      "limits.threads": "",
    });
    const html = await bad.text();

    expect(bad.status).toBe(400);
    expect(html).toContain("Not saved");
    expect(html).toContain("Running factory threads per worker: give a whole number of 0 or more.");
    // An empty limit is not read as 0, which would stop every thread.
    expect(html).toContain("Running factory threads in all: give a whole number of 0 or more.");
    // The form comes back with what was typed.
    expect(html).toContain('name="limits.threadsPerWorker" min="0" step="1" value="-1"');
    // A draft stays a draft: the box comes back unticked.
    expect(html).toContain('<input type="checkbox" name="deploy" value="on">Deploy now');
    expect(html).not.toContain('http-equiv="refresh"');

    const stale = await dashboard.post("/config/factory", { ...FACTORY_FIELDS, parentId: "7" });
    expect(await stale.text()).toContain("The config changed since the page was loaded.");
    expect(dashboard.store.list()).toHaveLength(1);
  });
});

const HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The Factory tab with the improver's nightly job set to `schedule`, and the job's settings row. */
async function nightlyRow(job: { schedule: string; enabled?: boolean }): Promise<string> {
  await start();
  const config = sampleConfig();
  config.roles.improver.cron = [{ name: "nightly", prompt: "Improve.", ...job }];
  deployVersion(config);
  const { html } = await dashboard.get("/config");
  const at = html.indexOf('id="f-cron-improver-nightly"');
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<div class="setting">', at), html.indexOf("</fieldset>", at));
}

describe("Factory tab schedules", () => {
  it("shows a daily job as an on switch, a time of day, and a summary with the host time zone", async () => {
    const row = await nightlyRow({ schedule: "30 2 * * *" });

    expect(row).toContain(
      '<input type="checkbox" name="cron.improver.nightly.on" value="1" checked>',
    );
    expect(row).toContain(
      '<input type="time" id="f-cron-improver-nightly" name="cron.improver.nightly.time" value="02:30"',
    );
    expect(row).toContain('name="cron.improver.nightly.custom" value=""');
    expect(row).toContain(`Runs every day at 02:30, Hermes host time (${HOST_ZONE}).`);
    expect(row).not.toContain('value="30 2 * * *"');
  });

  it.each([
    ["0 0 * * *", "00:00"],
    ["5 9 * * *", "09:05"],
    ["05 09 * * *", "09:05"],
    ["59 23 * * *", "23:59"],
  ])("shows %s as %s", async (schedule, time) => {
    const row = await nightlyRow({ schedule });

    expect(row).toContain(`name="cron.improver.nightly.time" value="${time}"`);
    expect(row).toContain(`Runs every day at ${time}, Hermes host time`);
  });

  it("shows any other schedule in the custom field, open, and summarizes it", async () => {
    const row = await nightlyRow({ schedule: "every 12h" });

    expect(row).toContain('name="cron.improver.nightly.custom" value="every 12h"');
    expect(row).toContain('name="cron.improver.nightly.time" value=""');
    expect(row).toContain('<details class="fold" open>');
    expect(row).toContain(
      `Runs on the custom schedule every 12h, Hermes host time (${HOST_ZONE}).`,
    );
  });

  it("shows a job that is off unticked, keeps its time, and says it does not run", async () => {
    const row = await nightlyRow({ schedule: "0 0 * * *", enabled: false });

    expect(row).toContain('<input type="checkbox" name="cron.improver.nightly.on" value="1">');
    expect(row).toContain('name="cron.improver.nightly.time" value="00:00"');
    expect(row).toContain("Off: this job does not run.");
  });

  async function saveNightly(fields: Record<string, string>): Promise<Response> {
    const config = sampleConfig();
    config.roles.improver.cron = [{ name: "nightly", schedule: "30 2 * * *", prompt: "Improve." }];
    const id = deployVersion(config);
    return dashboard.post("/config/factory", {
      ...FACTORY_FIELDS,
      parentId: String(id),
      ...fields,
    });
  }

  it.each([
    ["00:00", "0 0 * * *"],
    ["09:05", "5 9 * * *"],
    ["9:05", "5 9 * * *"],
    ["23:59", "59 23 * * *"],
  ])("saves the time %s as %s and shows it again after a reload", async (time, schedule) => {
    await start();

    const response = await saveNightly({
      "cron.improver.nightly.on": "1",
      "cron.improver.nightly.time": time,
      "cron.improver.nightly.custom": "",
    });

    expect(response.status).toBe(303);
    const job = dashboard.store.list()[0]?.document.roles.improver.cron?.[0];
    expect(job).toEqual({ name: "nightly", schedule, prompt: "Improve." });
    dashboard.store.approve(dashboard.store.list()[0]?.id ?? 0);
    dashboard.store.markDeployed(dashboard.store.list()[0]?.id ?? 0);
    const { html } = await dashboard.get("/config");
    const shown = time.padStart(5, "0");
    expect(html).toContain(`name="cron.improver.nightly.time" value="${shown}"`);
    expect(html).toContain(`Runs every day at ${shown}, Hermes host time`);
  });

  it("saves a job turned off, with its time kept", async () => {
    await start();

    await saveNightly({
      "cron.improver.nightly.time": "04:15",
      "cron.improver.nightly.custom": "",
    });

    expect(dashboard.store.list()[0]?.document.roles.improver.cron?.[0]).toEqual({
      name: "nightly",
      schedule: "15 4 * * *",
      prompt: "Improve.",
      enabled: false,
    });
  });

  it.each([
    ["25:00", "improver: nightly: give a time of day as HH:MM, such as 02:30."],
    ["2:3", "improver: nightly: give a time of day as HH:MM, such as 02:30."],
    ["", "improver: nightly: give a time of day, or a custom schedule."],
  ])("refuses the time %j with a clear message and saves nothing", async (time, message) => {
    await start();

    const response = await saveNightly({
      "cron.improver.nightly.on": "1",
      "cron.improver.nightly.time": time,
      "cron.improver.nightly.custom": " ",
    });
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain(message);
    expect(html).toContain(`name="cron.improver.nightly.time" value="${time}"`);
    // Only the starting version and the one the test deployed.
    expect(dashboard.store.list()).toHaveLength(2);
  });

  it("refuses a custom schedule that is neither a five-field cron expression nor an every form", async () => {
    await start();

    const response = await saveNightly({
      "cron.improver.nightly.on": "1",
      "cron.improver.nightly.time": "02:30",
      "cron.improver.nightly.custom": "2 * *",
    });
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain(
      "improver: nightly: write the custom schedule as five cron fields, such as 30 2 * * *, or as every 2h.",
    );
    expect(html).toContain('name="cron.improver.nightly.custom" value="2 * *"');
  });

  it("keeps a job as it is when the form does not carry its fields", async () => {
    await start();

    await saveNightly({});

    expect(dashboard.store.list()[0]?.document.roles.improver.cron?.[0]).toEqual({
      name: "nightly",
      schedule: "30 2 * * *",
      prompt: "Improve.",
    });
  });
});

describe("Models tab", () => {
  it("shows one row per coding job with its model, and the provider as fixed text", async () => {
    await start();

    const { html } = await dashboard.get("/config/models");

    expect(html).toContain('action="/config/models"');
    for (const job of ["Implement", "Review", "Housekeeping"]) {
      expect(html).toContain(`<span class="title">${job}</span>`);
    }
    expect(html).toContain('name="claude.model" value="claude-sonnet-5-5"');
    expect(html).toContain('name="codex.model" value="gpt-6.2-sol"');
    expect(html).toContain('name="setup.model" value="claude-sonnet-5-5"');
    expect(html).toContain('name="setup.instanceId" value="claudeAgent"');
    expect(html).not.toMatch(/<select[^>]*provider/);
    expect(html).toContain("<summary>Provider options</summary>");
    expect(html).not.toContain('name="limits.threads"');
  });

  it("saves the coding models and their options, and keeps the limits", async () => {
    await start();
    const tuned = sampleConfig();
    tuned.factory.limits.threads = 9;
    const id = deployVersion(tuned);

    const response = await dashboard.post("/config/models", {
      ...MODEL_FIELDS,
      parentId: String(id),
      "claude.model": "claude-opus-5-5",
      "claude.options": "",
      "codex.options": "effort=high\r\nfast=false",
      "setup.instanceId": "myClaude",
      deploy: "on",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/config/versions/${String(id + 1)}`);
    const saved = dashboard.store.list()[0];
    expect(saved?.message).toBe("Change the coding models");
    expect(saved?.document.factory.models).toEqual({
      claude: { model: "claude-opus-5-5" },
      codex: { model: "gpt-6.2-sol", options: { effort: "high", fast: false } },
    });
    expect(saved?.document.factory.setup).toEqual({
      instanceId: "myClaude",
      model: "claude-sonnet-5-5",
    });
    expect(saved?.document.factory.limits.threads).toBe(9);
  });

  it("refuses a malformed option and a missing model, and opens the options to show what was typed", async () => {
    await start();

    const bad = await dashboard.post("/config/models", {
      ...MODEL_FIELDS,
      "claude.options": "effort",
      "codex.model": " ",
    });
    const html = await bad.text();

    expect(bad.status).toBe(400);
    expect(html).toContain("Implement model options: write each as id=value, not effort.");
    expect(html).toContain("Review model: name one.");
    expect(html).toContain(">effort</textarea>");
    expect(html).toContain('<details class="fold" open>');
    expect(dashboard.store.list()).toHaveLength(1);
  });

  it("keeps a string option that reads like a switch a string", async () => {
    await start();
    const quoted = sampleConfig();
    quoted.factory.models.codex = {
      model: "gpt-6.2-sol",
      options: { mode: "false", fast: true, note: "first\nfast=true" },
    };
    const id = deployVersion(quoted);

    const { html } = await dashboard.get("/config/models");
    expect(html).toContain("mode=&quot;false&quot;\nfast=true\nnote=&quot;first\\nfast=true&quot;");

    await dashboard.post("/config/models", {
      ...MODEL_FIELDS,
      parentId: String(id),
      "codex.options": 'mode="false"\nfast=true\nnote="first\\nfast=true"',
    });

    expect(dashboard.store.list()[0]?.document.factory.models.codex.options).toEqual({
      mode: "false",
      fast: true,
      note: "first\nfast=true",
    });
  });
});

describe("JSON tab", () => {
  it("says it is the fallback, and saves an edit as a draft with its diff", async () => {
    await start();
    const document = sampleConfig();
    document.roles.lead.persona = "Lead <carefully>.";

    expect((await dashboard.get("/config/json")).html).toContain(
      "for changes the other tabs do not cover",
    );
    const created = await dashboard.post("/config/json", {
      document: JSON.stringify(document),
      message: "Tune the lead",
      parentId: "1",
    });

    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/config/versions/2");
    expect(dashboard.store.get(2)).toMatchObject({ state: "draft", author: "owner", parentId: 1 });

    const { html } = await dashboard.get("/config/versions/2");
    expect(html).toContain("roles.lead.persona");
    expect(html).toContain("Lead &lt;carefully&gt;.");
    expect(html).not.toContain("Lead <carefully>.");
  });

  it("refuses an invalid edit and keeps the text for correction", async () => {
    await start();

    const response = await dashboard.post("/config/json", {
      document: '{"projects": 5}',
      message: "Broken",
      parentId: "1",
    });
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("The draft was not saved");
    expect(html).toContain("projects must be an object");
    expect(html).toContain("{&quot;projects&quot;: 5}");
    expect(dashboard.store.count()).toBe(1);
  });

  it("refuses a skill file that needs another file to be a folder", async () => {
    await start();
    const document = sampleConfig();
    document.skills.triage = { "SKILL.md": "x", "SKILL.md/notes.md": "y" };

    const response = await dashboard.post("/config/json", {
      document: JSON.stringify(document),
      message: "Clash",
      parentId: "1",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("which is a file, not a folder");
    expect(dashboard.store.count()).toBe(1);
  });

  it("says a config larger than the form reads is too large, with the limit", async () => {
    await start();

    const response = await dashboard.post("/config/json", {
      document: "x".repeat(7 * 1024 * 1024),
      message: "Huge",
      parentId: "1",
    });
    const html = await response.text();

    expect(response.status).toBe(413);
    expect(html).toContain("A config holds at most 2 MB as JSON");
    expect(html).toContain('href="/config/json"');
    expect(dashboard.store.count()).toBe(1);
  });

  it("keeps the submitted parent and message when it refuses an edit", async () => {
    await start();
    deployVersion();

    const response = await dashboard.post("/config/json", {
      document: "{",
      message: "Keep me",
      parentId: "1",
    });
    const html = await response.text();

    expect(html).toContain("The config is not valid JSON");
    expect(html).toContain('name="parentId" value="1"');
    expect(html).toContain('value="Keep me"');
    expect(html).toContain("built from version 1.");
  });

  it("can save back an unchanged config near the size cap", async () => {
    await start();
    const big = sampleConfig();
    big.instructions.big = "é".repeat(600_000);
    const id = deployVersion(big);

    const page = (await dashboard.get("/config/json")).html;
    const start_ = page.indexOf('spellcheck="false">') + 19;
    const text = page.slice(start_, page.indexOf("</textarea>", start_));
    const unescaped = text
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
    const response = await dashboard.post("/config/json", {
      document: unescaped,
      message: "Same",
      parentId: String(id),
    });

    expect(response.status).toBe(303);
  });
});

describe("Versions tab", () => {
  it("lists versions with state, author and message, each linking to its page", async () => {
    await start();
    dashboard.store.createVersion({
      document: sampleConfig(),
      author: "improver",
      message: "Tune <the> lead",
      parentId: 1,
    });

    const { html } = await dashboard.get("/config/versions");

    expect(html).toContain('href="/config/versions/1"');
    expect(html).toContain("v1 first");
    expect(html).toContain("Deployed");
    expect(html).toContain("v2 Tune &lt;the&gt; lead");
    expect(html).toContain("Waiting for you");
    expect(html).toContain("improver");
  });

  it("shows the newest versions first and the rest on request", async () => {
    await start();
    for (let index = 0; index < 22; index += 1) deployVersion(sampleConfig(), index + 1);

    const short = (await dashboard.get("/config/versions")).html;
    expect(short).toContain('href="/config/versions/23"');
    expect(short).not.toContain('href="/config/versions/3"');
    expect(short).toContain('<a class="more-link" href="/config/versions?all=1">Show 3 older</a>');

    const all = (await dashboard.get("/config/versions?all=1")).html;
    expect(all).toContain('href="/config/versions/1"');
    expect(all).not.toContain("more-link");
  });
});

describe("Version page", () => {
  it("offers Approve and Reject for a draft as confirm popovers", async () => {
    await start({}, true);
    dashboard.store.createVersion({
      document: sampleConfig(),
      author: "owner",
      message: "Draft",
      parentId: 1,
    });

    const { html } = await dashboard.get("/config/versions/2");

    expect(html).toContain("<h1");
    expect(html).toContain("v2 Draft");
    expect(html).toContain('<a href="/config/versions/1">v1</a>');
    expect(html).toContain('popovertarget="approve-version">Approve and deploy</button>');
    expect(html).toContain('popovertarget="reject-version">Reject</button>');
    expect(html).toContain('action="/config/versions/2/approve"');
    expect(html).toContain('action="/config/versions/2/reject"');
    expect(html).not.toContain("/config/versions/2/revert");
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it("offers Deploy again and Revert for a deployed version, and no Revert for the first", async () => {
    await start({}, true);
    const changed = sampleConfig();
    changed.roles.lead.persona = "Lead carefully.";
    deployVersion(changed);

    const second = (await dashboard.get("/config/versions/2")).html;
    expect(second).toContain('popovertarget="deploy-version">Deploy again</button>');
    expect(second).toContain('popovertarget="revert-version">Revert</button>');
    expect(second).toContain('action="/config/versions/2/revert"');

    const first = (await dashboard.get("/config/versions/1")).html;
    expect(first).not.toContain("/config/versions/1/revert");
  });

  it("approves and rejects drafts", async () => {
    await start();
    const draft = { document: sampleConfig(), author: "owner", message: "", parentId: 1 };
    const a = dashboard.store.createVersion(draft);
    const b = dashboard.store.createVersion(draft);

    const approved = await dashboard.post(`/config/versions/${String(a.id)}/approve`);
    const rejected = await dashboard.post(`/config/versions/${String(b.id)}/reject`);

    expect(approved.headers.get("location")).toBe(`/config/versions/${String(a.id)}`);
    expect(rejected.headers.get("location")).toBe(`/config/versions/${String(b.id)}`);
    expect(dashboard.store.get(a.id).state).toBe("approved");
    expect(dashboard.store.get(b.id).state).toBe("rejected");
  });

  it("reverts a deployed version into a new draft, and says what it left", async () => {
    await start();
    const changed = sampleConfig();
    changed.roles.lead.persona = "Lead carefully.";
    const second = deployVersion(changed);

    const response = await dashboard.post(`/config/versions/${String(second)}/revert`);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/config/versions/3?conflicts=0");
    expect(dashboard.store.get(3).document.roles.lead.persona).toBe("Lead the work.");
    expect((await dashboard.get("/config/versions/3?conflicts=2")).html).toContain(
      "2 changes were left as they are",
    );
  });

  it("answers 409 for a transition the version's state does not allow", async () => {
    await start();
    const draft = dashboard.store.createVersion({
      document: sampleConfig(),
      author: "o",
      message: "d",
      parentId: 1,
    });
    dashboard.store.reject(draft.id);
    const path = `/config/versions/${String(draft.id)}`;

    const response = await dashboard.post(`${path}/approve`);

    expect(response.status).toBe(409);
    expect(await response.text()).toContain(`href="${path}"`);
  });

  it("deploys an approved version through the deploy hook, and approval deploys too", async () => {
    await start({}, true);
    const draft = { document: sampleConfig(), author: "o", message: "d", parentId: 1 };
    const first = dashboard.store.createVersion(draft);
    const second = dashboard.store.createVersion(draft);
    dashboard.store.approve(first.id);

    expect((await dashboard.get(`/config/versions/${String(first.id)}`)).html).toContain(
      'popovertarget="deploy-version">Deploy</button>',
    );
    const response = await dashboard.post(`/config/versions/${String(first.id)}/deploy`);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/config/versions/${String(first.id)}`);
    expect(deployed).toEqual([first.id]);

    dashboard.store.reject(second.id);
    const next = dashboard.store.createVersion({ ...draft, parentId: first.id });
    await dashboard.post(`/config/versions/${String(next.id)}/approve`);
    expect(deployed).toEqual([first.id, next.id]);
  });

  it("reports a failed deploy after approval in the sidebar, without the error text", async () => {
    dashboard = await startDashboard({
      deploy: () =>
        Promise.reject(
          new Error("git push failed: token ghp_secret", { cause: new Error("exit 128") }),
        ),
    });
    const draft = dashboard.store.createVersion({
      document: sampleConfig(),
      author: "o",
      message: "d",
      parentId: 1,
    });

    const approved = await dashboard.post(`/config/versions/${String(draft.id)}/approve`);
    await dashboard.deploysSettled();
    const location = approved.headers.get("location") ?? "";
    const page = (await dashboard.get(location)).html;

    expect(location).toBe(`/config/versions/${String(draft.id)}`);
    expect(page).toContain(`Deploying version ${String(draft.id)} failed`);
    expect(page).not.toContain("ghp_secret");
  });

  it("answers approving and deploying before the deploy finishes", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const started: number[] = [];
    dashboard = await startDashboard({
      deploy: (id) => {
        started.push(id);
        return held.then(() => ({}));
      },
    });
    const draft = dashboard.store.createVersion({
      document: sampleConfig(),
      author: "o",
      message: "d",
      parentId: 1,
    });

    const approved = await dashboard.post(`/config/versions/${String(draft.id)}/approve`);
    const twice = await dashboard.post(`/config/versions/${String(draft.id)}/approve`);
    const deploy = await dashboard.post(`/config/versions/${String(draft.id)}/deploy`);

    expect(approved.status).toBe(303);
    expect(twice.status).toBe(303);
    expect(deploy.status).toBe(303);
    expect(dashboard.store.get(draft.id).state).toBe("approved");
    expect((await dashboard.get(`/config/versions/${String(draft.id)}`)).html).toContain(
      `Deploying version ${String(draft.id)}`,
    );
    release();
    await dashboard.deploysSettled();
    expect(started).toEqual([draft.id]);
  });

  it("says in the sidebar when a deploy did not reach the factory's Hermes", async () => {
    dashboard = await startDashboard({ deploy: () => Promise.resolve({ hermesError: "no sync" }) });
    const draft = dashboard.store.createVersion({
      document: sampleConfig(),
      author: "o",
      message: "d",
      parentId: 1,
    });

    await dashboard.post(`/config/versions/${String(draft.id)}/approve`);
    await dashboard.deploysSettled();

    expect((await dashboard.get("/")).html).toContain("not applied to the factory Hermes root");
  });

  it("answers 404 for a version that does not exist", async () => {
    await start();

    expect((await dashboard.get("/config/versions/99")).status).toBe(404);
    expect((await dashboard.post("/config/versions/99/approve")).status).toBe(404);
    expect((await dashboard.get("/api/config/versions/99")).status).toBe(404);
  });

  it("serves versions and diffs as JSON", async () => {
    await start();
    const headers = { cookie: dashboard.cookie };

    const list = (await (
      await fetch(`${dashboard.base}/api/config/versions`, { headers })
    ).json()) as { id: number }[];
    const one = (await (
      await fetch(`${dashboard.base}/api/config/versions/1`, { headers })
    ).json()) as { version: { id: number }; diff: unknown[] };

    expect(list.map((version) => version.id)).toEqual([1]);
    expect(one.version.id).toBe(1);
    expect(one.diff.length).toBeGreaterThan(0);
  });

  it.each([
    ["GET", "/config"],
    ["GET", "/config/versions/1"],
    ["POST", "/config/json"],
    ["POST", "/config/versions/1/revert"],
    ["POST", "/config/repo"],
  ])("redirects %s %s to the login page without a session", async (method, path) => {
    await start();

    const response = await fetch(`${dashboard.base}${path}`, { method, redirect: "manual" });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("rejects the config API without a session", async () => {
    await start();

    expect((await fetch(`${dashboard.base}/api/config/versions`)).status).toBe(401);
  });
});

describe("Saving a config that did not change", () => {
  it.each([
    ["/config", "/config/factory", FACTORY_FIELDS],
    ["/config/models", "/config/models", MODEL_FIELDS],
  ])("creates no version from %s and says nothing changed", async (tab, action, fields) => {
    await start({}, true);

    const response = await dashboard.post(action, { ...fields, deploy: "on" });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${tab}?unchanged=1`);
    expect(dashboard.store.count()).toBe(1);
    expect(deployed).toEqual([]);
    const { html } = await dashboard.get(`${tab}?unchanged=1`);
    expect(html).toContain("Nothing to save");
    expect(html).toContain("No version was created.");
  });

  it("creates no version from an instructions page that saves the same text and skills", async () => {
    await start();

    const response = await dashboard.post("/config/agents/lead", {
      parentId: "1",
      text: "Lead the work.",
      message: "Only a message",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/config/agents/lead?unchanged=1");
    expect(dashboard.store.count()).toBe(1);
  });

  it("creates no version from JSON that differs only in key order and spacing", async () => {
    await start();
    const current = dashboard.store.get(1).document;
    const reordered = Object.fromEntries(Object.entries(current).reverse());

    const response = await dashboard.post("/config/json", {
      parentId: "1",
      message: "Same",
      document: JSON.stringify(reordered),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/config/json?unchanged=1");
    expect(dashboard.store.count()).toBe(1);
    expect((await dashboard.get("/config/json?unchanged=1")).html).toContain("Nothing to save");
  });

  it("still saves a config that changed", async () => {
    await start();

    const response = await dashboard.post("/config/factory", {
      ...FACTORY_FIELDS,
      "limits.threads": "6",
    });

    expect(response.headers.get("location")).toBe("/config/versions/2");
    expect(dashboard.store.count()).toBe(2);
  });

  it.each([
    ["/config", "Save settings"],
    ["/config/models", "Save coding models"],
    ["/config/agents/lead", "Save instructions"],
    ["/config/json", "Save as a draft"],
  ])("marks the save button on %s to wait for a change", async (path, label) => {
    await start();

    const { html } = await dashboard.get(path);

    const button = new RegExp(`<button [^>]*>${label}</button>`).exec(html)?.[0] ?? "";
    expect(button).toContain('data-unchanged="Nothing to save: this is the same as version 1."');
    expect(button).toContain('data-unchanged-ignore="deploy message"');
    expect(html).toContain('<script src="/assets/unchanged.js" defer></script>');
  });

  it("leaves the save button on for a refused form, which already differs from the version", async () => {
    await start();

    const refused = await dashboard.post("/config/factory", {
      ...FACTORY_FIELDS,
      "limits.threads": "lots",
    });
    const html = await refused.text();

    expect(refused.status).toBe(400);
    expect(html).toMatch(/<button type="submit" class="primary">Save settings<\/button>/);
  });

  it("serves the script that turns a save button off until something changes", async () => {
    await start();

    const response = await fetch(`${dashboard.base}/assets/unchanged.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
  });
});

describe("Version page buttons that would do nothing", () => {
  function changedConfig(): FactoryConfig {
    const changed = sampleConfig();
    changed.roles.lead.persona = "Lead carefully.";
    return changed;
  }

  it("turns Revert off, and says why, for a version that changed nothing", async () => {
    await start({}, true);
    const id = deployVersion();

    const { html } = await dashboard.get(`/config/versions/${String(id)}`);

    expect(html).toContain(
      '<button type="button" popovertarget="revert-version" disabled title="Nothing to revert: reverting this version would change nothing.">Revert</button>',
    );
  });

  it("turns Revert off for a version whose changes were already undone", async () => {
    await start();
    const second = deployVersion(changedConfig());
    deployVersion(sampleConfig(), second);

    const { html } = await dashboard.get(`/config/versions/${String(second)}`);

    expect(html).toMatch(/popovertarget="revert-version" disabled title="Nothing to revert/);
  });

  it("keeps Revert on for a version whose revert would change the config", async () => {
    await start();
    const second = deployVersion(changedConfig());

    const { html } = await dashboard.get(`/config/versions/${String(second)}`);

    expect(html).toContain('<button type="button" popovertarget="revert-version">Revert</button>');
  });

  it("refuses a revert posted for a version whose revert would change nothing, and creates no draft", async () => {
    await start();
    const second = deployVersion(changedConfig());
    deployVersion(sampleConfig(), second);
    const before = dashboard.store.count();

    const response = await dashboard.post(`/config/versions/${String(second)}/revert`);

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("would change nothing");
    expect(dashboard.store.count()).toBe(before);
  });

  it("turns Deploy again off while that version's deploy is already under way", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    dashboard = await startDashboard({ deploy: () => held.then(() => ({})) });

    await dashboard.post("/config/versions/1/deploy");
    const busy = (await dashboard.get("/config/versions/1")).html;
    release();
    await dashboard.deploysSettled();
    const done = (await dashboard.get("/config/versions/1")).html;

    expect(busy).toContain(
      '<button type="button" popovertarget="deploy-version" disabled title="Version 1 is deploying now.">Deploy again</button>',
    );
    expect(done).toContain(
      '<button type="button" popovertarget="deploy-version">Deploy again</button>',
    );
  });
});
