import { describe, expect, it } from "vitest";
import {
  CONTEXT_TTL_MS,
  MAX_DOC_CHARS,
  MAX_TOTAL_CHARS,
  ProjectContext,
  type ProjectDocsSource,
} from "../../src/factory/project-context.js";

const FACTORY_README = [
  "# Factory",
  "A factory that turns GitHub issues into merged pull requests.",
  "",
  "## Components",
  "- The Lead: the agent that starts and unblocks work on admitted tasks.",
  "- The pipeline: moves each task from implement to review to merge.",
].join("\n");

/** A source with fixed files per repo that counts its reads. */
function source(files: Record<string, Record<string, string>>): ProjectDocsSource & {
  reads: string[];
} {
  const reads: string[] = [];
  return {
    reads,
    readme: (repo) => {
      reads.push(`${repo}:readme`);
      return Promise.resolve(files[repo]?.["README.md"]);
    },
    docs: (repo) => {
      reads.push(`${repo}:docs`);
      return Promise.resolve(
        Object.keys(files[repo] ?? {}).filter((path) => path.startsWith("docs/")),
      );
    },
    file: (repo, path) => {
      reads.push(`${repo}:${path}`);
      return Promise.resolve(files[repo]?.[path]);
    },
  };
}

describe("ProjectContext", () => {
  it("gives every factory project's README and docs list", async () => {
    const docs = source({
      "octo/factory": {
        "README.md": FACTORY_README,
        "docs/factory.md": "x",
        "docs/logo.png": "png",
      },
      "octo/site": { "README.md": "# Site\nThe marketing site." },
    });
    const context = new ProjectContext(docs, () => ["octo/factory", "octo/site"]);
    const projects = await context.summaries();
    expect(projects.map((project) => project.repo)).toEqual(["octo/factory", "octo/site"]);
    expect(projects[0]).toEqual({
      repo: "octo/factory",
      readme: FACTORY_README,
      readme_truncated: false,
      // Only text docs are listed.
      docs: ["docs/factory.md"],
    });
    expect(projects[1]?.readme).toContain("The marketing site.");
  });

  it("carries the text that answers what a named part of a project is", async () => {
    const context = new ProjectContext(
      source({ "octo/factory": { "README.md": FACTORY_README } }),
      () => ["octo/factory"],
    );
    const [project] = await context.summaries();
    expect(project?.readme).toMatch(/The Lead: the agent that starts and unblocks work/);
  });

  it("gives a project with no README or docs as empty, not as an error", async () => {
    const context = new ProjectContext(source({}), () => ["octo/empty"]);
    expect(await context.summaries()).toEqual([
      { repo: "octo/empty", readme: null, readme_truncated: false, docs: [] },
    ]);
  });

  it("lists a project it cannot read with the reason and still gives the others", async () => {
    const docs = source({ "octo/site": { "README.md": "# Site" } });
    const failing: ProjectDocsSource = {
      ...docs,
      readme: (repo) =>
        repo === "octo/gone"
          ? Promise.reject(new Error("gh api failed: gh: Could not resolve to a Repository"))
          : docs.readme(repo),
    };
    const projects = await new ProjectContext(failing, () => [
      "octo/gone",
      "octo/site",
    ]).summaries();
    expect(projects[0]).toMatchObject({ repo: "octo/gone", readme: null, docs: [] });
    expect(projects[0]?.error).toMatch(/Could not read the project's README or docs from GitHub/);
    expect(projects[1]).toMatchObject({ repo: "octo/site", readme: "# Site" });
  });

  it("cuts long READMEs so all projects together stay within the limit", async () => {
    const long = "a".repeat(MAX_TOTAL_CHARS);
    const repos = ["octo/a", "octo/b", "octo/c", "octo/d"];
    const context = new ProjectContext(
      source(Object.fromEntries(repos.map((repo) => [repo, { "README.md": long }]))),
      () => repos,
    );
    const projects = await context.summaries();
    const total = projects.reduce((sum, project) => sum + (project.readme?.length ?? 0), 0);
    expect(total).toBeLessThan(MAX_TOTAL_CHARS + 400);
    expect(projects.every((project) => project.readme_truncated)).toBe(true);
    expect(projects[0]?.readme).toMatch(/\[cut: the rest is longer than/);
  });

  it("reads the default branch again once its copy is older than the refresh time", async () => {
    const files = { "octo/factory": { "README.md": "# Old" } };
    const docs = source(files);
    let now = 0;
    const context = new ProjectContext(
      docs,
      () => ["octo/factory"],
      () => now,
    );
    expect((await context.summaries())[0]?.readme).toBe("# Old");
    files["octo/factory"]["README.md"] = "# New";
    now = CONTEXT_TTL_MS - 1;
    expect((await context.summaries())[0]?.readme).toBe("# Old");
    now = CONTEXT_TTL_MS;
    expect((await context.summaries())[0]?.readme).toBe("# New");
  });

  it("reads again a project whose last read failed", async () => {
    let fail = true;
    const docs = source({ "octo/site": { "README.md": "# Site" } });
    const flaky: ProjectDocsSource = {
      ...docs,
      readme: (repo) => (fail ? Promise.reject(new Error("timeout")) : docs.readme(repo)),
    };
    const context = new ProjectContext(
      flaky,
      () => ["octo/site"],
      () => 0,
    );
    expect((await context.summaries())[0]?.error).toBeDefined();
    fail = false;
    expect((await context.summaries())[0]?.readme).toBe("# Site");
  });

  it("reads one listed doc, cut to its limit", async () => {
    const context = new ProjectContext(
      source({ "octo/factory": { "docs/factory.md": "b".repeat(MAX_DOC_CHARS + 10) } }),
      () => ["octo/factory"],
    );
    const doc = await context.doc("OCTO/factory", "docs/factory.md");
    expect(doc).toMatchObject({ repo: "octo/factory", path: "docs/factory.md", truncated: true });
    expect(doc.text.startsWith("b".repeat(MAX_DOC_CHARS))).toBe(true);
  });

  it("refuses a path outside the docs list and a repo that is not a factory project", async () => {
    const docs = source({
      "octo/factory": { "docs/factory.md": "x", "src/secret.ts": "y" },
    });
    const context = new ProjectContext(docs, () => ["octo/factory"]);
    await expect(context.doc("octo/factory", "src/secret.ts")).rejects.toThrow(
      "src/secret.ts is not one of octo/factory's docs",
    );
    await expect(context.doc("octo/factory", "docs/../src/secret.ts")).rejects.toThrow(
      "is not one of",
    );
    await expect(context.summaries("other/thing")).rejects.toThrow(
      "other/thing is not a factory project",
    );
    expect(docs.reads).not.toContain("octo/factory:src/secret.ts");
  });
});
