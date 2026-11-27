import { afterEach, describe, expect, it } from "vitest";
import type { Deploy } from "../../src/web/settings.js";
import { runningTask, startDashboard, type Dashboard, type DashboardOptions } from "./dashboard.js";

let dashboard: Dashboard | undefined;
const deployed: number[] = [];

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
  deployed.length = 0;
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const deploy: Deploy = (id) => {
  deployed.push(id);
  return Promise.resolve({});
};

/** Starts a dashboard with an improver proposal citing the running task's implement thread. */
async function withProposal(
  options: DashboardOptions = { deploy },
): Promise<{ dashboard: Dashboard; id: number }> {
  const started = await startDashboard(options);
  dashboard = started;
  runningTask(started.h);
  const base = started.store.current();
  if (base === undefined) throw new Error("no version");
  const document = structuredClone(base.document);
  document.roles.lead.persona = "Lead <briefly>.";
  const version = started.store.createVersion({
    document,
    author: "improver",
    message: "Shorter lead briefs",
    parentId: base.id,
  });
  started.h.db
    .prepare(
      "INSERT INTO version_evidence (version_id, environment_id, thread_id, note) VALUES (?, ?, ?, ?)",
    )
    .run(version.id, "w1", "t-impl", "The brief ran <long>");
  return { dashboard: started, id: version.id };
}

describe("Proposals", () => {
  it("lists the starter skills an update brings as a proposal from Hephaestus", async () => {
    const started = await startDashboard({ deploy });
    dashboard = started;
    const base = started.store.current();
    if (base === undefined) throw new Error("no version");
    const document = structuredClone(base.document);
    document.skills["test-first"] = { "SKILL.md": "---\nname: test-first\n---\n" };
    const version = started.store.createVersion({
      document,
      author: "hephaestus",
      message: "Add the starter skill test-first",
      parentId: base.id,
    });

    const { html } = await started.get("/proposals");
    expect(html).toContain(`<a class="row" href="/proposals/${String(version.id)}">`);
    expect((await started.get(`/proposals/${String(version.id)}`)).status).toBe(200);
  });

  it("lists each waiting proposal as a row that links to its page", async () => {
    const { dashboard, id } = await withProposal();

    const { status, html } = await dashboard.get("/proposals");

    expect(status).toBe(200);
    expect(html).toContain('<h1 id="page-title">Proposals</h1>');
    expect(html).toContain('<h2>Waiting for you<span class="n">1</span></h2>');
    expect(html).toContain(`<a class="row" href="/proposals/${String(id)}">`);
    expect(html).toContain(`v${String(id)} Shorter lead briefs`);
    expect(html).toMatch(
      /Proposed <time [^>]*>[^<]*<\/time> &middot; 1 change &middot; 1 evidence thread</,
    );
    expect(html).not.toContain("/approve");
    expect(html).not.toContain("Past proposals");
    expect(html).not.toContain('http-equiv="refresh"');
    expect((await dashboard.get("/improvement")).status).toBe(404);
  });

  it("shows a proposal's changes as diffs, its evidence threads, and approve and reject behind confirms", async () => {
    const { dashboard, id } = await withProposal();
    const before = dashboard.store.get(1).document.roles.lead.persona;

    const { status, html } = await dashboard.get(`/proposals/${String(id)}`);

    expect(status).toBe(200);
    expect(html).toContain(`<h1 id="page-title">v${String(id)} Shorter lead briefs</h1>`);
    expect(html).toContain('<a href="/proposals">Proposals</a>');
    expect(html).toContain("Waiting for you");
    expect(html).toContain("built on v1");
    expect(html).toContain('<h2>Changes<span class="n">1</span></h2>');
    expect(html).toContain(
      '<div class="diff" tabindex="0" role="region" aria-label="Changes to roles.lead.persona"><div class="path">roles.lead.persona</div>',
    );
    expect(html).toContain(`<div class="ln del">- ${before.split("\n")[0] ?? ""}`);
    expect(html).toContain('<div class="ln add">+ Lead &lt;briefly&gt;.</div>');
    expect(html).toContain('<h2>Evidence threads<span class="n">1</span></h2>');
    expect(html).toContain('<a class="row" href="/threads/w1/t-impl">');
    expect(html).toContain("t-impl on w1");
    expect(html).toContain("The brief ran &lt;long&gt;");
    expect(html).toContain(
      '<button type="button" class="primary" popovertarget="approve-proposal">Approve and deploy</button>',
    );
    expect(html).toContain('<button type="button" popovertarget="reject-proposal">Reject</button>');
    expect(html).toContain(
      `id="approve-proposal" popover role="dialog" aria-labelledby="approve-proposal-title"><form method="post" action="/proposals/${String(id)}/approve">`,
    );
    expect(html).toContain(
      `id="reject-proposal" popover role="dialog" aria-labelledby="reject-proposal-title"><form method="post" action="/proposals/${String(id)}/reject">`,
    );
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it("lists a proposal by its short title and shows what it does on its page", async () => {
    const started = await startDashboard({ deploy });
    dashboard = started;
    const base = started.store.current();
    if (base === undefined) throw new Error("no version");
    const document = structuredClone(base.document);
    document.roles.lead.persona = "Name the files.";
    const description =
      "Briefs now name the files to touch, because two <implement> threads edited the wrong module.";
    const version = started.store.createVersion({
      document,
      author: "improver",
      title: "Name the files in each brief",
      message: description,
      parentId: base.id,
    });
    const v = `v${String(version.id)}`;

    const list = (await started.get("/proposals")).html;
    expect(list).toContain(`<span class="title">${v} Name the files in each brief</span>`);
    expect(list).not.toContain("wrong module");

    const page = (await started.get(`/proposals/${String(version.id)}`)).html;
    expect(page).toContain(`<h1 id="page-title">${v} Name the files in each brief</h1>`);
    expect(page).toContain("<h2>What it does</h2>");
    expect(page).toContain(
      '<p class="desc">Briefs now name the files to touch, because two &lt;implement&gt; threads edited the wrong module.</p>',
    );

    await started.post(`/proposals/${String(version.id)}/reject`);
    const past = (await started.get("/proposals")).html;
    expect(past).toContain(`<span class="title">${v} Name the files in each brief</span>`);
    expect(past).not.toContain("wrong module");
  });

  it("gives a proposal saved with only a long message a short title and keeps the message on its page", async () => {
    const started = await startDashboard({ deploy });
    dashboard = started;
    const base = started.store.current();
    if (base === undefined) throw new Error("no version");
    const document = structuredClone(base.document);
    document.roles.lead.persona = "Name the files.";
    const long =
      "Add a rule to the lead persona that every brief names the exact files to touch, because three implement threads this week edited the wrong module and needed extra review rounds";
    // A proposal an earlier build saved has a message and no title.
    const version = started.store.createVersion({
      document,
      author: "improver",
      message: long,
      parentId: base.id,
    });
    started.h.db.prepare("UPDATE config_versions SET title = '' WHERE id = ?").run(version.id);

    const list = (await started.get("/proposals")).html;
    const title = /<span class="title">(v\d+ [^<]*)<\/span>/.exec(list)?.[1] ?? "";
    expect(title).toMatch(/^v\d+ Add a rule to the lead persona .*\.\.\.$/);
    expect(title.length).toBeLessThan(long.length / 2);
    expect(list).not.toContain("extra review rounds");

    const page = (await started.get(`/proposals/${String(version.id)}`)).html;
    expect(page).toContain(`<p class="desc">${long}</p>`);

    const response = await started.post(`/proposals/${String(version.id)}/approve`);
    expect(response.headers.get("location")).toBe("/proposals?notice=approved");
    expect(deployed).toEqual([version.id]);
  });

  it("shows no separate description when the message is the title", async () => {
    const { dashboard, id } = await withProposal();

    const { html } = await dashboard.get(`/proposals/${String(id)}`);

    expect(html).not.toContain("What it does");
  });

  it("shows only the lines of a long text that changed", async () => {
    const started = await startDashboard({ deploy });
    dashboard = started;
    const base = started.store.current();
    if (base === undefined) throw new Error("no version");
    const first = structuredClone(base.document);
    first.roles.lead.persona = "one\ntwo\nthree\nfour";
    const parent = started.store.createVersion({
      document: first,
      author: "owner",
      message: "lines",
      parentId: base.id,
    });
    const second = structuredClone(first);
    second.roles.lead.persona = "one\ntwo\n3 & 3\nfour";
    const version = started.store.createVersion({
      document: second,
      author: "improver",
      message: "Third line",
      parentId: parent.id,
    });

    const { html } = await started.get(`/proposals/${String(version.id)}`);

    expect(html).toContain(
      '<div class="ln ctx">  2 unchanged lines</div><div class="ln del">- three</div><div class="ln add">+ 3 &amp; 3</div><div class="ln ctx">  1 unchanged line</div>',
    );
  });

  it("says when a proposal cites no threads", async () => {
    const { dashboard, id } = await withProposal();
    dashboard.h.db.prepare("DELETE FROM version_evidence").run();

    const { html } = await dashboard.get(`/proposals/${String(id)}`);

    expect(html).toContain("The proposal cites no threads.");
  });

  it("approving deploys the version", async () => {
    const { dashboard, id } = await withProposal();

    const response = await dashboard.post(`/proposals/${String(id)}/approve`);

    expect(response.headers.get("location")).toBe("/proposals?notice=approved");
    expect(dashboard.store.get(id).state).toBe("approved");
    expect(deployed).toEqual([id]);
    const list = (await dashboard.get("/proposals?notice=approved")).html;
    expect(list).toContain("Proposal approved");
    expect(list).toContain("No proposal is waiting.");
    expect(list).toContain('<h2>Past proposals<span class="n">1</span></h2>');
    expect(list).toContain(`<a class="row" href="/config/versions/${String(id)}">`);
    expect(list).toContain("Approved</span>");
  });

  it("shows a decided proposal's page without the actions", async () => {
    const { dashboard, id } = await withProposal();
    await dashboard.post(`/proposals/${String(id)}/reject`);

    const { status, html } = await dashboard.get(`/proposals/${String(id)}`);

    expect(status).toBe(200);
    expect(html).toContain("Rejected</span>");
    expect(html).toContain("roles.lead.persona");
    expect(html).not.toContain("/approve");
    expect(html).not.toContain("/reject");
  });

  it("answers an approval before the deploy finishes, and shows the deploy in the sidebar", async () => {
    const release = deferred();
    const { dashboard, id } = await withProposal({
      deploy: (version) => {
        deployed.push(version);
        return release.promise.then(() => ({}));
      },
    });

    const response = await dashboard.post(`/proposals/${String(id)}/approve`);

    expect(response.headers.get("location")).toBe("/proposals?notice=approved");
    expect(dashboard.store.get(id).state).toBe("approved");
    const during = (await dashboard.get("/proposals")).html;
    expect(during).toContain(`Deploying version ${String(id)}`);
    expect(during).toContain('data-live-seconds="3"');

    release.resolve();
    await dashboard.deploysSettled();
    expect((await dashboard.get("/proposals")).html).toContain(`Deployed version ${String(id)}`);
  });

  it("shows a failed background deploy in the sidebar, without the error text", async () => {
    const { dashboard, id } = await withProposal({
      deploy: () => Promise.reject(new Error("push failed: token ghp_secret")),
    });

    await dashboard.post(`/proposals/${String(id)}/approve`);
    await dashboard.deploysSettled();
    const { html } = await dashboard.get("/proposals");

    expect(html).toContain(`Deploying version ${String(id)} failed`);
    expect(html).not.toContain("ghp_secret");
  });

  it("approving twice deploys once and gives no error", async () => {
    const release = deferred();
    const { dashboard, id } = await withProposal({
      deploy: (version) => {
        deployed.push(version);
        return release.promise.then(() => ({}));
      },
    });

    const first = await dashboard.post(`/proposals/${String(id)}/approve`);
    const second = await dashboard.post(`/proposals/${String(id)}/approve`);

    expect(first.headers.get("location")).toBe("/proposals?notice=approved");
    expect(second.headers.get("location")).toBe("/proposals?notice=approved");
    release.resolve();
    await dashboard.deploysSettled();
    expect(deployed).toEqual([id]);
  });

  it("says so when an already deployed proposal is approved again", async () => {
    const { dashboard, id } = await withProposal({
      deploy: (version) => {
        dashboard.store.markDeployed(version);
        return Promise.resolve({});
      },
    });
    await dashboard.post(`/proposals/${String(id)}/approve`);
    await dashboard.deploysSettled();

    const again = await dashboard.post(`/proposals/${String(id)}/approve`);

    expect(again.headers.get("location")).toBe("/proposals?notice=already-deployed");
    expect((await dashboard.get("/proposals?notice=already-deployed")).html).toContain(
      "Already approved and deployed",
    );
  });

  it("rejecting means it never deploys", async () => {
    const { dashboard, id } = await withProposal();

    const rejected = await dashboard.post(`/proposals/${String(id)}/reject`);
    const again = await dashboard.post(`/proposals/${String(id)}/approve`);

    expect(rejected.headers.get("location")).toBe("/proposals?notice=proposal-rejected");
    expect(dashboard.store.get(id).state).toBe("rejected");
    expect(again.headers.get("location")).toBe(`/proposals/${String(id)}?notice=proposal-refused`);
    expect(deployed).toEqual([]);
    const { html } = await dashboard.get(again.headers.get("location") ?? "");
    expect(html).toContain("The proposal was not changed");
  });

  it("shows and acts only on improver proposals", async () => {
    dashboard = await startDashboard({ deploy });
    const base = dashboard.store.current();
    if (base === undefined) throw new Error("no version");
    const owner = dashboard.store.createVersion({
      document: base.document,
      author: "owner",
      message: "mine",
      parentId: base.id,
    });

    expect((await dashboard.post(`/proposals/${String(owner.id)}/approve`)).status).toBe(404);
    expect(dashboard.store.get(owner.id).state).toBe("draft");
    for (const id of [owner.id, 999]) {
      const { status, html } = await dashboard.get(`/proposals/${String(id)}`);
      expect(status).toBe(404);
      expect(html).toContain('<h1 id="page-title">No such proposal</h1>');
      expect(html).toContain('<a href="/proposals">Proposals</a>');
    }
  });

  it("says when no proposal is waiting", async () => {
    dashboard = await startDashboard({ deploy });

    const { html } = await dashboard.get("/proposals");

    expect(html).toContain('<h2>Waiting for you<span class="n">0</span></h2>');
    expect(html).toContain("No proposal is waiting.");
  });

  it("shows the store error and no actions when the store cannot be read", async () => {
    const { dashboard, id } = await withProposal();
    dashboard.h.db.close();

    for (const path of ["/proposals", `/proposals/${String(id)}`]) {
      const { status, html } = await dashboard.get(path);
      expect(status).toBe(200);
      expect(html).toContain("Hephaestus could not read its store");
      expect(html).not.toContain("/approve");
    }
  });
});
