import { afterEach, describe, expect, it } from "vitest";
import type { Deploy } from "../../src/web/settings.js";
import { runningCard, startDashboard, type Dashboard, type DashboardOptions } from "./dashboard.js";

let dashboard: Dashboard | undefined;
const deployed: number[] = [];

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
  deployed.length = 0;
});

const deploy: Deploy = (id) => {
  deployed.push(id);
  return Promise.resolve({});
};

/** Starts a dashboard with an improver proposal citing the running card's implement thread. */
async function withProposal(
  options: DashboardOptions = { deploy },
): Promise<{ dashboard: Dashboard; id: number }> {
  const started = await startDashboard(options);
  dashboard = started;
  runningCard(started.h);
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

describe("Improvement", () => {
  it("shows each proposal with its diff, evidence threads, and approve and reject", async () => {
    const { dashboard, id } = await withProposal();

    const { status, html } = await dashboard.get("/improvement");

    expect(status).toBe(200);
    expect(html).toContain(`id="v${String(id)}"`);
    expect(html).toContain("Shorter lead briefs");
    expect(html).toContain("roles.lead.persona");
    expect(html).toContain("Lead &lt;briefly&gt;.");
    expect(html).toContain('href="/threads/w1/t-impl"');
    expect(html).toContain("The brief ran &lt;long&gt;");
    expect(html).toContain(`action="/improvement/${String(id)}/approve"`);
    expect(html).toContain(`action="/improvement/${String(id)}/reject"`);
  });

  it("approving deploys the version", async () => {
    const { dashboard, id } = await withProposal();

    const response = await dashboard.post(`/improvement/${String(id)}/approve`);

    expect(response.headers.get("location")).toBe("/improvement?notice=approved");
    expect(dashboard.store.get(id).state).toBe("approved");
    expect(deployed).toEqual([id]);
    expect((await dashboard.get("/improvement")).html).not.toContain(
      `action="/improvement/${String(id)}/approve"`,
    );
  });

  it("says when approval worked but the deploy failed, without the error text", async () => {
    const { dashboard, id } = await withProposal({
      deploy: () => Promise.reject(new Error("push failed: token ghp_secret")),
    });

    const response = await dashboard.post(`/improvement/${String(id)}/approve`);
    const { html } = await dashboard.get(response.headers.get("location") ?? "");

    expect(response.headers.get("location")).toBe("/improvement?notice=deploy-failed");
    expect(html).toContain("Approved, but not deployed");
    expect(html).not.toContain("ghp_secret");
  });

  it("rejecting means it never deploys", async () => {
    const { dashboard, id } = await withProposal();

    await dashboard.post(`/improvement/${String(id)}/reject`);
    const again = await dashboard.post(`/improvement/${String(id)}/approve`);

    expect(dashboard.store.get(id).state).toBe("rejected");
    expect(again.headers.get("location")).toBe("/improvement?notice=proposal-refused");
    expect(deployed).toEqual([]);
  });

  it("acts only on improver proposals", async () => {
    dashboard = await startDashboard({ deploy });
    const base = dashboard.store.current();
    if (base === undefined) throw new Error("no version");
    const owner = dashboard.store.createVersion({
      document: base.document,
      author: "owner",
      message: "mine",
      parentId: base.id,
    });

    expect((await dashboard.post(`/improvement/${String(owner.id)}/approve`)).status).toBe(404);
    expect(dashboard.store.get(owner.id).state).toBe("draft");
  });

  it("says when no proposal is waiting", async () => {
    dashboard = await startDashboard({ deploy });

    expect((await dashboard.get("/improvement")).html).toContain("No proposal is waiting.");
  });

  it("shows the store error banner and no actions when the store cannot be read", async () => {
    const { dashboard } = await withProposal();
    dashboard.h.db.close();

    const { status, html } = await dashboard.get("/improvement");

    expect(status).toBe(200);
    expect(html).toContain("Hephaestus could not read its store");
    expect(html).not.toContain("/approve");
  });
});
