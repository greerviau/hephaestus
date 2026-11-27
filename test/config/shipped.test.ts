import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROLE_NAMES } from "../../src/config/document.js";
import {
  SHIPPED_PARAGRAPHS,
  ownInstructions,
  rolePrompt,
  shippedInstructions,
} from "../../src/config/shipped.js";

/** The lead's instructions as the first builds shipped them, which install copied into config version 1. */
const FIRST_LEAD = `You are the lead for a software factory run by Hephaestus.

Pick up admitted cards and start work on them with \`start_work\`, giving the engineer a short brief: the issue, the parts of the code it touches, and anything the issue leaves open.

When Hephaestus escalates a card to you, read its threads with the read tools, decide the next step, and either start new work with a sharper brief or \`escalate\` it to the owner with the reason. Escalate to the owner whenever the decision belongs to them.
`;

/** The planner's instructions as the builds before the communicator shipped them. */
const FIRST_PLANNER =
  "You are the planner for a software factory run by Hephaestus.\n\n" +
  "Turn each request in your channel into one or more GitHub issues on a factory project. Each issue states the problem, the proposed approach when one is known, and numbered acceptance criteria that a reviewer can check.\n\n" +
  "File issues only with the `file_issue` tool. Ask the requester when the goal or scope is unclear, and do not guess. Check `get_status` before filing, so you do not file a duplicate or pass the project's cap on open factory issues.\n\n" +
  "When a request comes in a chat, reply in that conversation once you have filed its issues: link each issue, and include the `tracking` line that `file_issue` returns exactly as given, on a line of its own. Hephaestus finds the conversation by that line and posts the work's progress there, so you do not need to report progress yourself. Keep replies short, and never claim work is done before Hephaestus says so.\n";

describe("the planner's shipped instructions", () => {
  it("describe a communicator that talks beyond filing issues and files only on request", () => {
    const text = shippedInstructions("planner");

    expect(text).toContain("general communicator");
    expect(text).not.toMatch(/^Turn each request/m);
    // The conversations that file nothing, and the tools that answer them.
    for (const tool of ["get_status", "list_cards", "read_thread"]) expect(text).toContain(tool);
    expect(text).toMatch(/do not file an issue/i);
    expect(text).toMatch(/say so/i);
    // Merge counts use the recorded merge time, never a card's last update, and admit when they are partial.
    expect(text).toContain("merged_at");
    expect(text).toMatch(/last update is not its merge date/);
    expect(text).toMatch(/at most 100 cards/);
    expect(text).toMatch(/at least that many/);
    // The filing rules stay: file_issue only, a status check first, and the tracking line on its own.
    expect(text).toContain("file_issue");
    expect(text).toMatch(/duplicate/);
    expect(text).toMatch(/cap/);
    expect(text).toMatch(/`tracking` line/);
    expect(text).toMatch(/on a line of its own/);
  });

  it("reach an install whose persona still holds the old planner text, which is left out of what the planner gets", () => {
    expect(ownInstructions(FIRST_PLANNER).text).toBe("");
    expect(rolePrompt("planner", FIRST_PLANNER)).toBe(`${shippedInstructions("planner")}\n`);
  });
});

describe("rolePrompt", () => {
  it("gives a role the shipped instructions alone when the owner adds none", () => {
    expect(rolePrompt("lead", "")).toBe(`${shippedInstructions("lead")}\n`);
    expect(rolePrompt("lead", "")).toContain("start_work");
    expect(rolePrompt("planner", "")).toContain("file_issue");
    expect(rolePrompt("improver", "")).toContain("propose_version");
  });

  it("puts the owner's instructions after the shipped ones", () => {
    expect(rolePrompt("lead", "Always ask for tests.\n")).toBe(
      `${shippedInstructions("lead")}\n\n## The owner's instructions\n\nAlways ask for tests.\n`,
    );
  });

  it("leaves out an older build's copy of the shipped instructions, and keeps what the owner added or edited", () => {
    const persona = `${FIRST_LEAD.replace("Escalate to the owner whenever", "Escalate to me whenever")}\nAlways ask for tests.\n`;

    expect(ownInstructions(persona)).toEqual({
      text: "When Hephaestus escalates a card to you, read its threads with the read tools, decide the next step, and either start new work with a sharper brief or `escalate` it to the owner with the reason. Escalate to me whenever the decision belongs to them.\n\nAlways ask for tests.",
      dropped: 2,
    });
    expect(ownInstructions(FIRST_LEAD)).toEqual({ text: "", dropped: 3 });
    expect(rolePrompt("lead", FIRST_LEAD)).toBe(`${shippedInstructions("lead")}\n`);
  });

  it("leaves out an old copy when the owner typed a line straight under it", () => {
    expect(ownInstructions(`${FIRST_LEAD.trimEnd()}\nAlso require tests.\n`)).toEqual({
      text: "Also require tests.",
      dropped: 3,
    });
  });

  it("keeps the owner's text exactly as typed when it repeats nothing", () => {
    const persona = "Prefer small PRs.\n\n\n```ts\nfunction f() {\n\n    return a;\n}\n```\n";
    expect(ownInstructions(persona)).toEqual({ text: persona.trimEnd(), dropped: 0 });
  });

  it("knows every paragraph the running build ships, so a later build can leave out copies of it", () => {
    for (const role of ROLE_NAMES) {
      for (const paragraph of shippedInstructions(role).split(/\n\s*\n/)) {
        const hash = createHash("sha256")
          .update(paragraph.replace(/`/g, "").replace(/\s+/g, " ").trim())
          .digest("hex");
        expect(SHIPPED_PARAGRAPHS, `add ${hash} for a paragraph of ${role}`).toContain(hash);
      }
    }
  });
});
