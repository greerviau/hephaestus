import { afterEach, describe, expect, it } from "vitest";
import { PullRequestEvidence } from "../../src/factory/pr-evidence.js";
import { STYLESHEET } from "../../src/web/style.js";
import { SHA } from "../factory/harness.js";
import { runningTask, startDashboard, type Dashboard } from "./dashboard.js";

let dashboard: Dashboard | undefined;

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const BLOB = "https://github.com/octo/app/blob/1111111111111111111111111111111111111111";

function shots(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `<img src="${BLOB}/shot-${String(i)}.png?raw=true" alt="Shot ${String(i)}">`,
  ).join("");
}

/** Evidence read from a PR whose rendered body and comments are `htmls`, with the files the repo holds. */
function source(
  htmls: string[] | Error,
  files: Record<string, Buffer> = {},
  reads: { repo: string; number: number }[] = [],
): PullRequestEvidence {
  return new PullRequestEvidence({
    github: {
      pullRequestHtml: (repo, number) => {
        reads.push({ repo, number });
        return htmls instanceof Error ? Promise.reject(htmls) : Promise.resolve(htmls);
      },
      fileAt: (_repo, _ref, path) => {
        const data = files[path];
        return data === undefined
          ? Promise.reject(new Error("gh failed: Not Found (HTTP 404)"))
          : Promise.resolve(data);
      },
    },
  });
}

/** A task with PR 5 open in review. */
function reviewingTask(d: Dashboard): number {
  const id = runningTask(d.h);
  d.h.tasks.transition(id, "Reviewing", "PR #5 at 1111111", { prNumber: 5, headSha: SHA });
  return id;
}

describe("the Evidence row in a task's Proof", () => {
  it("loads after the page, so a slow GitHub read does not hold the page up", async () => {
    dashboard = await startDashboard({ evidence: source([shots(1)]) });
    const id = reviewingTask(dashboard);

    const { html } = await dashboard.get(`/work/${String(id)}`);

    const proof = /<h2>Proof<\/h2>.*?<\/section>/s.exec(html)?.[0] ?? "";
    expect(proof).toContain('<span class="title">Review</span>');
    expect(proof).toContain("Checks after the merge");
    expect(proof).toContain(`data-lazy-url="/work/${String(id)}/evidence"`);
    expect(proof).toContain(">Evidence<");
    expect(html).toContain('<script src="/assets/lazy.js" defer></script>');
  });

  it("has no row before the task has a PR", async () => {
    dashboard = await startDashboard({ evidence: source([shots(1)]) });
    const id = runningTask(dashboard.h);

    const { html } = await dashboard.get(`/work/${String(id)}`);

    expect(html).not.toContain("/evidence");
  });

  it("shows the PR's screenshots as thumbnails that open full size, and other evidence as short links", async () => {
    const reads: { repo: string; number: number }[] = [];
    dashboard = await startDashboard({
      evidence: source(
        [
          `${shots(2)}<a href="https://github.com/octo/app/actions/runs/9">CI run</a>`,
          '<a href="https://gist.github.com/x/abc">test output</a>',
        ],
        {},
        reads,
      ),
    });
    const id = reviewingTask(dashboard);

    const { status, html } = await dashboard.get(`/work/${String(id)}/evidence`);

    expect(status).toBe(200);
    expect(reads).toEqual([{ repo: "octo/app", number: 5 }]);
    const thumbs = [
      ...html.matchAll(
        /<a href="(\/work\/\d+\/evidence\/[0-9a-f]{16})" target="_blank" rel="noopener noreferrer"[^>]*><img src="([^"]+)" alt="([^"]*)" loading="lazy"[^>]*><\/a>/g,
      ),
    ];
    expect(thumbs.map((match) => match[3])).toEqual(["Shot 0", "Shot 1"]);
    // The thumbnail and its full-size link are the same image, served by the dashboard.
    for (const match of thumbs) expect(match[2]).toBe(match[1]);
    expect(html).toContain('<div class="shots">');
    expect(html).not.toContain("github.com/octo/app/blob");
    expect(html).toContain('href="https://github.com/octo/app/actions/runs/9"');
    expect(html).toContain(">CI run<");
    expect(html).toContain(">test output<");
    expect(html).toContain("2 screenshots, 2 links");
    expect(html).not.toContain("<pre");
  });

  it("keeps a PR with many screenshots to a short scrolling collage", async () => {
    dashboard = await startDashboard({ evidence: source([shots(40)]) });
    const id = reviewingTask(dashboard);

    const { html } = await dashboard.get(`/work/${String(id)}/evidence`);

    expect(html.match(/<img /g)).toHaveLength(40);
    expect(html).toContain("40 screenshots");
    const rule = /\.shots \{[^}]*\}/.exec(STYLESHEET)?.[0] ?? "";
    expect(rule).toMatch(/max-height: \d+px/);
    expect(rule).toContain("overflow-y: auto");
    const thumb = /\.shots img \{[^}]*\}/.exec(STYLESHEET)?.[0] ?? "";
    expect(thumb).toMatch(/height: \d+px/);
    expect(thumb).toContain("object-fit: cover");
  });

  it("says in one line when the PR has no evidence", async () => {
    dashboard = await startDashboard({ evidence: source(["<p>Closes #7.</p>"]) });
    const id = reviewingTask(dashboard);

    const { status, html } = await dashboard.get(`/work/${String(id)}/evidence`);

    expect(status).toBe(200);
    expect(html).toContain("No evidence");
    expect(html).not.toContain('class="shots"');
  });

  it("says the PR could not be read, with a way to try again", async () => {
    dashboard = await startDashboard({ evidence: source(new Error("gh is down")) });
    const id = reviewingTask(dashboard);

    const { status, html } = await dashboard.get(`/work/${String(id)}/evidence`);

    expect(status).toBe(200);
    expect(html).toContain("Could not read the PR");
    expect(html).toContain("data-lazy-refresh");
    expect(html).not.toContain("gh is down");
  });

  it("serves a private repo's screenshot from the host, and a placeholder for one it cannot fetch", async () => {
    dashboard = await startDashboard({
      evidence: source([shots(2)], { "shot-0.png": PNG }),
    });
    const id = reviewingTask(dashboard);
    const fragment = (await dashboard.get(`/work/${String(id)}/evidence`)).html;
    const [first, second] = [...fragment.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1] ?? "");

    const image = await fetch(`${dashboard.base}${first ?? ""}`, {
      headers: { cookie: dashboard.cookie },
    });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toContain("private");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);

    const missing = await fetch(`${dashboard.base}${second ?? ""}`, {
      headers: { cookie: dashboard.cookie },
    });
    expect(missing.headers.get("content-type")).toBe("image/svg+xml");
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(await missing.text()).toContain("Image unavailable");
  });

  it("serves evidence only to a signed-in owner", async () => {
    dashboard = await startDashboard({ evidence: source([shots(1)], { "shot-0.png": PNG }) });
    const id = reviewingTask(dashboard);
    const fragment = (await dashboard.get(`/work/${String(id)}/evidence`)).html;
    const src = /<img src="([^"]+)"/.exec(fragment)?.[1] ?? "";

    const response = await fetch(`${dashboard.base}${src}`, { redirect: "manual" });

    expect(response.status).not.toBe(200);
  });
});
