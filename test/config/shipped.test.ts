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

/** The chat agent's instructions as the builds that still called it the planner shipped them. */
const FIRST_PLANNER_TEXT =
  "You are the planner for a software factory run by Hephaestus.\n\n" +
  "Turn each request in your channel into one or more GitHub issues on a factory project. Each issue states the problem, the proposed approach when one is known, and numbered acceptance criteria that a reviewer can check.\n\n" +
  "File issues only with the `file_issue` tool. Ask the requester when the goal or scope is unclear, and do not guess. Check `get_status` before filing, so you do not file a duplicate or pass the project's cap on open factory issues.\n\n" +
  "When a request comes in a chat, reply in that conversation once you have filed its issues: link each issue, and include the `tracking` line that `file_issue` returns exactly as given, on a line of its own. Hephaestus finds the conversation by that line and posts the work's progress there, so you do not need to report progress yourself. Keep replies short, and never claim work is done before Hephaestus says so.\n";

/**
 * The rules that keep the communicator from filing issues it was not asked for. Each is one
 * sentence of the shipped instructions, checked with its whitespace collapsed.
 */
const FILING_RULES: Record<string, RegExp> = {
  conversationFilesNothing:
    /Open conversation, such as "what do you think about X\?" or a half-formed idea: discuss it and give your view\. File nothing\./,
  noIssueBecauseDiscussed: /Do not file an issue just because something was discussed\./,
  needsRequestOrAgreement:
    /File only when the person asked for the work to be done, or agreed when you offered to file it\./,
  asksWhenUnclear: /When it is unclear whether they want work filed, ask in one short line\./,
  noFilingQuestionForConversation: /Never ask about filing when the message is only conversation\./,
  workRequestBecomesIssues:
    /A request for work to be done on a project: turn it into one or more GitHub issues/,
  noTrackingWhenNothingFiled: /Do not add a `tracking` line to a reply that filed nothing\./,
};

const collapse = (text: string): string => text.replace(/\s+/g, " ");

/** The filing rules a version of the instructions no longer holds. */
function brokenRules(text: string): string[] {
  return Object.entries(FILING_RULES)
    .filter(([, rule]) => !rule.test(collapse(text)))
    .map(([name]) => name);
}

describe("the communicator's shipped instructions", () => {
  it("keep every filing rule that the communicator needs", () => {
    expect(brokenRules(shippedInstructions("communicator"))).toEqual([]);
  });

  it("fail the filing rules when conversation is made to file, to ask about filing, or to file unasked", () => {
    const text = collapse(shippedInstructions("communicator"));
    const reversals: { from: string; to: string; breaks: string }[] = [
      // A conversational message must get an answer and no issue.
      {
        from: "discuss it and give your view. File nothing.",
        to: "discuss it and give your view. Then file an issue for it.",
        breaks: "conversationFilesNothing",
      },
      {
        from: "Do not file an issue just because something was discussed.",
        to: "File an issue whenever something was discussed.",
        breaks: "noIssueBecauseDiscussed",
      },
      // No filing question for a message that is only conversation.
      {
        from: "Never ask about filing when the message is only conversation.",
        to: "Always ask whether to file an issue, even when the message is only conversation.",
        breaks: "noFilingQuestionForConversation",
      },
      // An issue needs a work request or the person's agreement.
      {
        from: "File only when the person asked for the work to be done, or agreed when you offered to file it.",
        to: "File an issue for every message, whether or not the person asked for work.",
        breaks: "needsRequestOrAgreement",
      },
      {
        from: "File only when the person asked for the work to be done, or agreed when you offered to file it.",
        to: "File when you think the work is worth doing.",
        breaks: "needsRequestOrAgreement",
      },
    ];

    for (const { from, to, breaks } of reversals) {
      expect(text, from).toContain(from);
      expect(brokenRules(text.replace(from, to)), to).toContain(breaks);
    }
  });

  it("fail the filing rules when any one of them is removed", () => {
    const text = collapse(shippedInstructions("communicator"));

    for (const [name, rule] of Object.entries(FILING_RULES)) {
      const sentence = rule.exec(text)?.[0];
      expect(sentence, name).toBeDefined();
      expect(brokenRules(text.replace(sentence ?? "", "")), name).toContain(name);
    }
  });

  it("send a question about what a project is or its terms to the project context tool", () => {
    const text = collapse(shippedInstructions("communicator"));
    expect(text).toContain("A question about what a project is, its parts, or its terms");
    expect(text).toMatch(/answer from `get_project_context`/);
    expect(text).toMatch(/never say you lack a project's context before you have called it/);
    expect(text).toMatch(/when it does not cover the question, say so/);
  });

  it("describe a communicator that answers from its tools and still files by the same rules", () => {
    const text = shippedInstructions("communicator");

    expect(text).toContain("general communicator");
    expect(text).not.toMatch(/^Turn each request/m);
    for (const tool of ["get_status", "list_tasks", "read_thread"]) expect(text).toContain(tool);
    expect(text).toMatch(/say so/i);
    // Merge counts use the recorded merge time, never a task's last update, and admit when they are partial.
    expect(text).toContain("merged_at");
    expect(text).toMatch(/last update is not its merge date/);
    expect(text).toMatch(/at most 100 tasks/);
    expect(text).toMatch(/at least that many/);
    // The filing rules stay: file_issue only, a status check first, and the tracking line on its own.
    expect(text).toMatch(/use only the `file_issue` tool/);
    // Commenting on an existing issue uses its own tool, and only after a person asks for it.
    expect(text).toMatch(/use the `comment_issue` tool/);
    expect(text).toMatch(/Post a comment only after a person asks for it in the conversation/);
    expect(text).toMatch(/Check `get_status` before filing, so you do not file a duplicate/);
    expect(text).toMatch(/pass the project's cap on open factory issues/);
    expect(text).toMatch(
      /include the `tracking` line that `file_issue` returns exactly as given, on a line of its own/,
    );
  });

  it("tell the communicator to give the reason when a sent file could not be read, and the Slack scope it needs", () => {
    const text = collapse(shippedInstructions("communicator"));
    // Hermes puts a failed download in an attachment notice at the top of the message.
    expect(text).toMatch(/attachment notice/);
    expect(text).toMatch(/tell the requester which file and the reason the notice gives/);
    expect(text).toMatch(/HTTP 403[^.]*Slack[^.]*`files:read`/);
    expect(text).toMatch(/Do not file a path for a file that could not be read/);
  });

  it("tell the communicator to answer stats questions from the stats tools, without tables, and to say when data is missing", () => {
    const text = collapse(shippedInstructions("communicator"));

    for (const tool of ["get_factory_stats", "get_usage_stats", "get_host_health"]) {
      expect(text).toContain(`\`${tool}\``);
    }
    expect(text).toMatch(/answer from the stats tools and nothing else/);
    expect(text).toMatch(/Pass `window` \(such as `24h`, `7d`, or `30d`\) and `repo`/);
    expect(text).toMatch(/a chat has no tables/);
    expect(text).toMatch(
      /When a report says data is not recorded or not available, say that plainly/,
    );
    expect(text).toMatch(/Never fill a gap with a number a stats tool did not return/);
    expect(text).toMatch(/never estimate a cost yourself/);
    // Filing stays as it was: a stats question is not a request for work.
    expect(brokenRules(text)).toEqual([]);
  });

  it("tell the communicator to draw a chart with the chart tool when one is asked for, and to attach the PNG", () => {
    const text = collapse(shippedInstructions("communicator"));

    expect(text).toContain("`get_factory_chart`");
    for (const metric of ["merges_per_day", "tasks_by_stage", "review_rounds"]) {
      expect(text).toContain(`\`${metric}\``);
    }
    expect(text).toMatch(/chart, graph, or plot/);
    expect(text).toMatch(/instead of typing a bar chart by hand/);
    expect(text).toMatch(/attach the PNG to your reply with the `MEDIA:` line the tool returns/);
    expect(text).toMatch(
      /When the tool returns `no_data`, attach nothing and say there is no data/,
    );
    expect(text).toMatch(/Say how many Done tasks the caption says were left out/);
    expect(brokenRules(text)).toEqual([]);
  });

  it("reach an install whose persona still holds the old communicator text, which is left out of what the communicator gets", () => {
    expect(ownInstructions(FIRST_PLANNER_TEXT).text).toBe("");
    expect(rolePrompt("communicator", FIRST_PLANNER_TEXT)).toBe(
      `${shippedInstructions("communicator")}\n`,
    );
  });
});

describe("rolePrompt", () => {
  it("gives a role the shipped instructions alone when the owner adds none", () => {
    expect(rolePrompt("lead", "")).toBe(`${shippedInstructions("lead")}\n`);
    expect(rolePrompt("lead", "")).toContain("start_work");
    expect(rolePrompt("communicator", "")).toContain("file_issue");
    expect(rolePrompt("improver", "")).toContain("propose_version");
  });

  it("tell the improver to load a new skill in the same proposal and to say what loads it", () => {
    const improver = shippedInstructions("improver");
    expect(improver).toContain("`factory.threadSkills`");
    expect(improver).toContain("`roles.<role>.skills`");
    expect(improver).toContain("The message must say which loads it.");
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
