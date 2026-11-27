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

  it("knows every paragraph the running build ships, so a later build can leave out copies of it", () => {
    for (const role of ROLE_NAMES) {
      for (const paragraph of shippedInstructions(role).split(/\n\s*\n/)) {
        const hash = createHash("sha256")
          .update(paragraph.replace(/\s+/g, " ").trim())
          .digest("hex");
        expect(SHIPPED_PARAGRAPHS, `add ${hash} for a paragraph of ${role}`).toContain(hash);
      }
    }
  });
});
