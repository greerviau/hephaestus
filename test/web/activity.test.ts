import { afterEach, describe, expect, it } from "vitest";
import { runningCard, startDashboard, type Dashboard } from "./dashboard.js";

let dashboard: Dashboard | undefined;

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
});

function recordCall(
  dashboard: Dashboard,
  role: string,
  tool: string,
  ok: boolean,
  at: string,
): void {
  dashboard.h.db
    .prepare(
      "INSERT INTO mcp_calls (role, tool, arguments, ok, result, at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(role, tool, '{"card_id":1}', ok ? 1 : 0, ok ? "{}" : '{"error":"<bad>"}', at);
}

describe("Activity", () => {
  it("lists card events, MCP calls, and notifications, newest first", async () => {
    dashboard = await startDashboard();
    const card = runningCard(dashboard.h);
    recordCall(dashboard, "lead", "start_work", true, "2026-11-25T13:00:00.000Z");
    recordCall(dashboard, "planner", "file_issue", false, "2026-11-25T14:00:00.000Z");
    dashboard.h.db
      .prepare("INSERT INTO notifications (at, card_id, text) VALUES (?, ?, ?)")
      .run("2026-11-25T15:00:00.000Z", card, "Card <1> needs you");

    const { status, html } = await dashboard.get("/activity");

    expect(status).toBe(200);
    expect(html).toContain(`href="/work/${String(card)}"`);
    expect(html).toContain("Moved to Implementing");
    expect(html).toContain("lead called start_work");
    expect(html).toContain("planner called file_issue");
    expect(html).toContain("Card &lt;1&gt; needs you");
    const order = [
      "Card &lt;1&gt; needs you",
      "planner called file_issue",
      "lead called start_work",
    ];
    const positions = order.map((text) => html.indexOf(text));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("filters to the MCP calls of one role", async () => {
    dashboard = await startDashboard();
    runningCard(dashboard.h);
    recordCall(dashboard, "lead", "start_work", true, "2026-11-25T13:00:00.000Z");
    recordCall(dashboard, "planner", "file_issue", true, "2026-11-25T14:00:00.000Z");

    const { html } = await dashboard.get("/activity?show=mcp&role=lead");

    expect(html).toContain("lead called start_work");
    expect(html).not.toContain("planner called file_issue");
    expect(html).not.toContain("Moved to Implementing");
  });

  it("says when nothing has happened", async () => {
    dashboard = await startDashboard();

    expect((await dashboard.get("/activity")).html).toContain("Nothing has happened yet.");
  });

  it("shows the store error banner when the store cannot be read", async () => {
    dashboard = await startDashboard();
    dashboard.h.db.close();

    const { status, html } = await dashboard.get("/activity");

    expect(status).toBe(200);
    expect(html).toContain("Hephaestus could not read its store");
  });
});
