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
  defaultBranch: (repo: string) =>
    repo === "octo/missing" ? Promise.reject(new Error("not found")) : Promise.resolve("main"),
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
    expect(html).toContain('href="https://github.com/octo/app"');
    expect(html).toContain("reviewed PRs with passing checks, except .github/workflows/**");
    expect(html).toContain('<option value="octo/lib"></option>');
    expect(html).not.toContain('<option value="octo/app"></option>');
    expect(html).toContain('href="/projects"');
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
    expect(response.headers.get("location")).toBe(`/settings/versions/${String(draft?.id)}`);
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
    const edit = await dashboard.get("/projects/edit?repo=octo%2Fapp");
    expect(edit.html).toContain('<option value="standard" selected>standard</option>');
    expect(edit.html).toContain("Preset (.github/workflows/**)");

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

describe("parsePolicy", () => {
  it("leaves settings on their preset and reads changed ones", () => {
    const form = new URLSearchParams({
      preset: "yolo",
      autoRevert: "",
      allowNoChecks: "on",
      maxReviewRounds: "",
      "requiredChecks.mode": "preset",
      requiredChecks: "ignored",
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
