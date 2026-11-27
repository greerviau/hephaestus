import { afterEach, describe, expect, it } from "vitest";
import { parsePolicy } from "../../src/web/projects.js";
import { startDashboard, type Dashboard } from "./dashboard.js";

let dashboard: Dashboard | undefined;

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
});

const github = {
  repos: () => Promise.resolve(["octo/app", "octo/lib", "octo/site"]),
  // GitHub resolves any casing to its own spelling.
  canonicalName: (repo: string) =>
    repo.toLowerCase() === "octo/missing"
      ? Promise.reject(new Error("not found"))
      : Promise.resolve(repo.toLowerCase()),
};

/** What the service's deploy does to the store once workers have the version. */
function markDeployed(id: number): Promise<Record<string, never>> {
  dashboard?.store.markDeployed(id);
  return Promise.resolve({});
}

/** The fields the Add form posts for `repo` with the standard preset and no changes. */
function added(repo: string, parentId: number, extra: Record<string, string> = {}) {
  return {
    mode: "add",
    repo,
    parentId: String(parentId),
    preset: "standard",
    deploy: "on",
    ...extra,
  };
}

describe("Projects", () => {
  it("lists the factory projects and suggests repos that are not projects yet", async () => {
    dashboard = await startDashboard({ github });
    const { status, html } = await dashboard.get("/projects");

    expect(status).toBe(200);
    expect(html).toContain('href="https://github.com/octo/app" target="_blank"');
    expect(html).toContain('<a class="title" href="/projects/octo/app">octo/app</a>');
    expect(html).toContain(
      "Merges on its own: reviewed PRs with passing checks, except .github/workflows/**",
    );
    expect(html).toContain('<option value="octo/lib"></option>');
    expect(html).not.toContain('<option value="octo/app"></option>');
    expect(html).toContain('href="/projects"');
  });

  it("opens the add form as a dialog on a page that does not reload", async () => {
    dashboard = await startDashboard({ github });
    const { html } = await dashboard.get("/projects");

    expect(html).toContain('popovertarget="add-project">Add project</button>');
    expect(html).toMatch(
      /<div class="dlg" id="add-project" popover[^>]*><form method="post" action="\/projects\/save">/,
    );
    expect(html).toContain('<input type="hidden" name="mode" value="add">');
    expect(html).toContain('list="repos"');
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("counts a project's active tasks and puts Remove behind a menu that asks first", async () => {
    dashboard = await startDashboard({ github });
    const id = dashboard.h.tasks.create({ repo: "octo/app", issueNumber: 1, title: "Work" }).id;
    dashboard.h.tasks.transition(id, "Implementing", "started");
    const { html } = await dashboard.get("/projects");

    expect(html).toContain("1 active");
    expect(html).toMatch(
      /<details class="menu"[^>]*>.*popovertarget="remove-0">Remove project<\/button>/s,
    );
    expect(html).toMatch(
      /id="remove-0" popover[^>]*><form method="post" action="\/projects\/remove">/,
    );
    expect(html).toContain("1 active task waits until you add the repo again or abandon it.");
    expect(html).toContain("Remove and deploy");
  });

  it("keeps what was typed in the add dialog when the server refuses it", async () => {
    dashboard = await startDashboard({ github });
    const base = dashboard.store.current()?.id ?? 0;
    const response = await dashboard.post("/projects/save", added("not a repo", base));
    const html = await response.text();

    expect(html).toContain("Not saved");
    expect(html).toContain('value="not a repo"');
  });

  it("answers 404 for a repo that is not a project, and for the old edit path", async () => {
    dashboard = await startDashboard({ github });

    const missing = await dashboard.get("/projects/octo/nope");
    expect(missing.status).toBe(404);
    expect(missing.html).toContain("octo/nope is not a factory project.");
    expect((await dashboard.get("/projects/edit?repo=octo%2Fapp")).status).toBe(404);
  });

  it("adds a project, approving and deploying the new version", async () => {
    const deployed: number[] = [];
    dashboard = await startDashboard({
      github,
      deploy: (id) => {
        deployed.push(id);
        return markDeployed(id);
      },
    });
    const base = dashboard.store.current()?.id ?? 0;

    const response = await dashboard.post(
      "/projects/save",
      added("octo/lib", base, { requireReview: "off", openIssueCap: "3" }),
    );

    expect(response.headers.get("location")).toBe("/projects?notice=added");
    const version = dashboard.store.current();
    expect(version?.message).toBe("Add the project octo/lib");
    expect(version?.document.projects["octo/lib"]).toEqual({
      policy: { preset: "standard", overrides: { requireReview: false, openIssueCap: 3 } },
    });
    expect(deployed).toEqual([version?.id]);
    expect((await dashboard.get("/projects?notice=added")).html).toContain("Project added");
  });

  it("keeps a new project as a draft when asked", async () => {
    dashboard = await startDashboard({ github });
    const base = dashboard.store.current()?.id ?? 0;
    const fields = added("octo/lib", base);
    delete (fields as Partial<typeof fields>).deploy;

    const response = await dashboard.post("/projects/save", fields);

    const draft = dashboard.store.list()[0];
    expect(draft?.state).toBe("draft");
    expect(response.headers.get("location")).toBe(`/config/versions/${String(draft?.id)}`);
    expect(dashboard.store.current()?.document.projects["octo/lib"]).toBeUndefined();
  });

  it("refuses a repo gh cannot read, one already added, a bad name, and a stale form", async () => {
    dashboard = await startDashboard({ github });
    const base = dashboard.store.current()?.id ?? 0;

    for (const [fields, message] of [
      [added("octo/missing", base), "cannot read octo/missing"],
      [added("octo/app", base), "already a factory project"],
      [added("not a repo", base), "owner/name"],
      [added("octo/lib", base - 1), "changed since the page was loaded"],
    ] as const) {
      const response = await dashboard.post("/projects/save", fields);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(message);
    }
    expect(dashboard.store.list()).toHaveLength(1);
  });

  it("edits a project's policy and removes a project", async () => {
    dashboard = await startDashboard({ github, deploy: markDeployed });
    const base = dashboard.store.current()?.id ?? 0;
    const edit = await dashboard.get("/projects/octo/app");
    expect(edit.html).toContain('<input type="radio" name="preset" value="standard" checked>');
    expect(edit.html).toContain(
      "By preset: standard: .github/workflows/**; strict: .github/workflows/**; yolo: none.",
    );
    expect(edit.html).toContain('<a href="/projects">Projects</a>');
    expect(edit.html).toContain("<summary>Customize the preset</summary>");
    expect(edit.html).toContain(">Save policy</button>");
    expect(edit.html).toContain(
      '<input type="checkbox" name="deploy" value="on" checked>Deploy now',
    );

    await dashboard.post("/projects/save", {
      mode: "edit",
      repo: "octo/app",
      parentId: String(base),
      preset: "strict",
      "escalationPaths.mode": "custom",
      escalationPaths: "ci/**\n\n infra/** ",
      deploy: "on",
    });
    expect(dashboard.store.current()?.document.projects["octo/app"]).toEqual({
      policy: { preset: "strict", overrides: { escalationPaths: ["ci/**", "infra/**"] } },
    });
    const changed = (await dashboard.get("/projects/octo/app")).html;
    expect(changed).toContain(
      '<details class="fold" open><summary>Customize the preset (1 changed)',
    );
    expect((await dashboard.get("/projects")).html).toContain("strict +1");

    const next = dashboard.store.current()?.id ?? 0;
    const removed = await dashboard.post("/projects/remove", {
      repo: "octo/app",
      parentId: String(next),
      deploy: "on",
    });
    expect(removed.headers.get("location")).toBe("/projects?notice=removed");
    expect(dashboard.store.current()?.document.projects).toEqual({});
    expect((await dashboard.get("/projects")).html).toContain("No project yet.");
  });

  it("says when the approved version could not be deployed", async () => {
    dashboard = await startDashboard({
      github,
      deploy: () => Promise.reject(new Error("no config repo")),
    });
    const base = dashboard.store.current()?.id ?? 0;
    const response = await dashboard.post("/projects/save", added("octo/lib", base));
    expect(response.headers.get("location")).toBe("/projects?notice=deploy-failed");
    expect(dashboard.store.list()[0]?.state).toBe("approved");
  });

  it("refuses actions from another origin", async () => {
    dashboard = await startDashboard({ github });
    const base = dashboard.store.current()?.id ?? 0;
    const response = await fetch(`${dashboard.base}/projects/save`, {
      method: "POST",
      headers: {
        cookie: dashboard.cookie,
        origin: "http://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(added("octo/lib", base)).toString(),
      redirect: "manual",
    });
    expect(response.status).toBe(403);
    expect(dashboard.store.list()).toHaveLength(1);
  });
});

describe("Projects, under concurrent changes", () => {
  it("refuses an add when Config deployed a version while the repo was looked up", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    dashboard = await startDashboard({
      deploy: markDeployed,
      github: {
        ...github,
        canonicalName: async (repo: string) => {
          await held;
          return repo;
        },
      },
    });
    const base = dashboard.store.current()?.id ?? 0;
    const adding = dashboard.post("/projects/save", added("octo/lib", base));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Meanwhile Config deploys a lower thread limit.
    const lowered = structuredClone(dashboard.store.current()?.document);
    if (lowered === undefined) throw new Error("no config");
    lowered.factory.limits.threads = 1;
    const settings = dashboard.store.createVersion({
      document: lowered,
      author: "owner",
      message: "Lower the limit",
      parentId: base,
    });
    dashboard.store.approve(settings.id);
    dashboard.store.markDeployed(settings.id);
    release();

    const response = await adding;
    expect(response.status).toBe(400);
    expect(dashboard.store.current()?.document.factory.limits.threads).toBe(1);
    expect(dashboard.store.current()?.document.projects["octo/lib"]).toBeUndefined();
  });

  it("refuses the same repo under another casing", async () => {
    dashboard = await startDashboard({ github, deploy: markDeployed });
    const base = dashboard.store.current()?.id ?? 0;
    const response = await dashboard.post("/projects/save", added("Octo/App", base));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("octo/app is already a factory project");
  });

  it("re-adds a repo under the spelling its tasks were recorded with", async () => {
    dashboard = await startDashboard({ github, deploy: markDeployed });
    dashboard.h.tasks.create({ repo: "Octo/Lib", issueNumber: 1, title: "Old" });
    await dashboard.post("/projects/save", added("octo/lib", dashboard.store.current()?.id ?? 0));
    expect(Object.keys(dashboard.store.current()?.document.projects ?? {})).toContain("Octo/Lib");
  });

  it("returns a stale edit with the policy now in force", async () => {
    dashboard = await startDashboard({ github, deploy: markDeployed });
    const stale = dashboard.store.current()?.id ?? 0;
    await dashboard.post("/projects/save", {
      mode: "edit",
      repo: "octo/app",
      parentId: String(stale),
      preset: "strict",
      deploy: "on",
    });
    const response = await dashboard.post("/projects/save", {
      mode: "edit",
      repo: "octo/app",
      parentId: String(stale),
      preset: "yolo",
      deploy: "on",
    });
    const html = await response.text();
    expect(response.status).toBe(400);
    expect(html).toContain('<input type="radio" name="preset" value="strict" checked>');
    expect(dashboard.store.current()?.document.projects["octo/app"]?.policy.preset).toBe("strict");
  });

  it("removes a project with a merge in flight, and says the merge finishes under its policy", async () => {
    dashboard = await startDashboard({ github, deploy: markDeployed });
    const id = dashboard.h.tasks.create({ repo: "octo/app", issueNumber: 1, title: "Work" }).id;
    dashboard.h.tasks.transition(id, "Implementing", "started");
    dashboard.h.tasks.transition(id, "Reviewing", "PR #5");
    dashboard.h.tasks.transition(id, "Merging", "approved");
    dashboard.h.tasks.transition(id, "Validating", "merged");
    expect((await dashboard.get("/projects/octo/app")).html).toContain(
      "1 task is merging, validating, or reverting a merge; it finishes under the policy it started with.",
    );
    const response = await dashboard.post("/projects/remove", {
      repo: "octo/app",
      parentId: String(dashboard.store.current()?.id ?? 0),
      deploy: "on",
    });
    expect(response.headers.get("location")).toBe("/projects?notice=removed");
  });

  it("checks for a stale form before other errors, and keeps a draft a draft", async () => {
    dashboard = await startDashboard({ github, deploy: markDeployed });
    const stale = dashboard.store.current()?.id ?? 0;
    await dashboard.post("/projects/save", {
      mode: "edit",
      repo: "octo/app",
      parentId: String(stale),
      preset: "strict",
      deploy: "on",
    });
    // The old form, with a bad number too, comes back with the policy now in force.
    const html = await (
      await dashboard.post("/projects/save", {
        mode: "edit",
        repo: "octo/app",
        parentId: String(stale),
        preset: "standard",
        openIssueCap: "1001",
        deploy: "on",
      })
    ).text();
    expect(html).toContain('<input type="radio" name="preset" value="strict" checked>');
    expect(html).toContain("The config changed since the page was loaded.");

    const draft = await (
      await dashboard.post("/projects/save", {
        mode: "add",
        repo: "not a repo",
        parentId: String(dashboard.store.current()?.id ?? 0),
        preset: "standard",
      })
    ).text();
    expect(draft).toContain('<input type="checkbox" name="deploy" value="on">Deploy now');
  });

  it("says when no version is deployed, so the projects listed are not live yet", async () => {
    dashboard = await startDashboard({
      github,
      deploy: () => Promise.reject(new Error("no config repo")),
    });
    // As on a fresh install: the only version is approved, none deployed.
    dashboard.h.db.prepare("UPDATE config_versions SET state = 'approved'").run();
    await dashboard.post("/projects/save", added("octo/lib", dashboard.store.current()?.id ?? 0));
    const html = (await dashboard.get("/projects")).html;
    expect(html).toContain("Not deployed yet");
    expect(html).toContain("the factory works on none of these projects yet");
    expect(html).toContain('<a href="/config">Config</a>');
    expect(html).toMatch(/href="\/config\/versions\/\d+"/);
    expect(html).not.toContain("/environments");
    expect(html).not.toContain("/settings");
  });

  it("says when the factory Hermes root was not updated", async () => {
    dashboard = await startDashboard({
      github,
      deploy: (id) => {
        dashboard?.store.markDeployed(id);
        return Promise.resolve({ hermesError: "hermes failed" });
      },
    });
    const response = await dashboard.post(
      "/projects/save",
      added("octo/lib", dashboard.store.current()?.id ?? 0),
    );
    expect(response.headers.get("location")).toBe("/projects?notice=hermes-failed");
  });
});

describe("parsePolicy", () => {
  it("lets the selector decide a list, and asks when the list changed on the preset", () => {
    // Switching a custom list back to the preset leaves the shown text in the box.
    const back = new URLSearchParams({
      preset: "standard",
      "escalationPaths.mode": "preset",
      escalationPaths: "docs/**",
      "escalationPaths.shown": "docs/**",
    });
    expect(parsePolicy(back)).toEqual({
      policy: { preset: "standard", overrides: {} },
      errors: [],
    });
    const typed = new URLSearchParams({
      preset: "standard",
      "requiredChecks.mode": "preset",
      requiredChecks: "unit",
      "requiredChecks.shown": "",
    });
    const parsed = parsePolicy(typed);
    expect(parsed.errors[0]).toContain("you changed the list but left it on the preset");
    // The form comes back with the typed list, so resubmitting keeps it.
    expect(parsed.policy.overrides).toEqual({ requiredChecks: ["unit"] });
  });

  it("refuses a switch that is not the preset, on, or off, and a number too large", () => {
    const { errors } = parsePolicy(
      new URLSearchParams({
        preset: "standard",
        autoMerge: "yes",
        openIssueCap: "9007199254740993",
      }),
    );
    expect(errors).toHaveLength(2);
  });

  it("leaves settings on their preset and reads changed ones", () => {
    const form = new URLSearchParams({
      preset: "yolo",
      autoRevert: "",
      allowNoChecks: "on",
      maxReviewRounds: "",
      "requiredChecks.mode": "preset",
      requiredChecks: "",
    });
    expect(parsePolicy(form)).toEqual({
      policy: { preset: "yolo", overrides: { allowNoChecks: true } },
      errors: [],
    });
  });

  it("refuses an unknown preset and a bad number", () => {
    const { errors } = parsePolicy(new URLSearchParams({ preset: "wild", openIssueCap: "-1" }));
    expect(errors).toHaveLength(2);
  });
});
