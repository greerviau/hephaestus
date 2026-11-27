import { z } from "zod";
import type { ChatChange, ChatChanges } from "./chat-changes.js";

/** The tools for changing the factory's own config from a chat. Their logic is in {@link ChatChanges}. */
export const CHANGE_TOOLS = [
  "list_targets",
  "read_target",
  "propose_change",
  "apply_change",
  "decline_change",
  "list_changes",
  "revert_change",
] as const;

export type ChangeTool = (typeof CHANGE_TOOLS)[number];

export const CHANGE_SHAPES = {
  list_targets: {},
  read_target: { target: z.string().describe("for example skill:triage/SKILL.md") },
  propose_change: {
    target: z.string().describe("what to change, as list_targets shows"),
    content: z.string().describe("the whole new text; for a setting, its new JSON value"),
    summary: z.string().min(1).describe("one line: what changes and why"),
    conversation: z.string().min(1).describe("an id or link for this chat conversation"),
  },
  apply_change: {
    change_id: z.number().int(),
    conversation: z.string().min(1).describe("the conversation the diff was shown in"),
    approval: z.string().min(1).describe("the person's message approving the change, quoted"),
  },
  decline_change: { change_id: z.number().int(), conversation: z.string().min(1) },
  list_changes: {},
  revert_change: {
    change_id: z.number().int(),
    conversation: z.string().min(1),
    request: z.string().min(1).describe("the person's message asking for the revert, quoted"),
  },
} satisfies Record<ChangeTool, z.ZodRawShape>;

/**
 * What the call log keeps of a call's arguments. A proposed change's text is
 * kept with its change record only when it passed the secret check, so the log
 * keeps just its size.
 */
export function redactChangeArgs(tool: string, args: unknown): unknown {
  if (tool !== "propose_change" || typeof args !== "object" || args === null) return args;
  const { content, ...rest } = args as Record<string, unknown>;
  return typeof content === "string"
    ? { ...rest, content: `<${String(content.length)} characters>` }
    : args;
}

export type ChangeRegister = <T extends ChangeTool>(
  tool: T,
  description: string,
  run: (args: z.infer<z.ZodObject<(typeof CHANGE_SHAPES)[T]>>) => unknown,
) => void;

function present(change: ChatChange): Record<string, unknown> {
  return {
    change_id: change.id,
    target: change.target,
    summary: change.summary,
    state: change.state,
    conversation: change.conversation,
    proposed_at: change.proposedAt,
    approval: change.approval,
    applied_at: change.appliedAt,
    version: change.version,
    error: change.error,
    reverted_at: change.revertedAt,
    revert_version: change.revertVersion,
  };
}

/**
 * Registers the change tools. Their descriptions carry the flow, because they are
 * all the agent reads: propose, show the diff, wait for the person, then apply.
 */
export function registerChangeTools(register: ChangeRegister, changes: ChatChanges): void {
  register(
    "list_targets",
    "Use this when a person wants to change the factory's own skills, instructions, instructions for a role, or settings. Lists what can be changed from chat and the form of each target; nothing else can, and never a secret or credential, so refuse a request for anything else and say why. Do not file an issue for such a change.",
    () => changes.targets(),
  );
  register(
    "read_target",
    "The current text of one editable target, so the person can see it and you can edit it: a skill file, an instruction, a role's own instructions, or a setting (as JSON).",
    ({ target }) => changes.read(target),
  );
  register(
    "propose_change",
    "Propose a new text for one editable target. It writes nothing. It returns the exact diff. You must post that diff in the chat as given, in a code block, and ask the person whether to apply it. Never apply in the same turn that you propose.",
    ({ target, content, summary, conversation }) => {
      const { change, diff } = changes.propose({ target, content, summary, conversation });
      return {
        change_id: change.id,
        target: change.target,
        diff,
        next: "Post this diff exactly as given, in a code block, and ask the person whether to apply it. Call apply_change only after they approve in this conversation, and decline_change if they decline. If they say nothing, do nothing.",
      };
    },
  );
  register(
    "apply_change",
    "Apply a proposed change, but only after the person explicitly approved that diff in the same conversation; quote their message as the approval. It is checked, saved as a config version, and deployed. Tell the person the result, including any error it returns.",
    async ({ change_id, conversation, approval }) => {
      const { change, warning } = await changes.apply({ id: change_id, conversation, approval });
      return { ...present(change), ...(warning === undefined ? {} : { warning }) };
    },
  );
  register(
    "decline_change",
    "Record that the person declined a proposed change. Nothing is written.",
    ({ change_id, conversation }) => present(changes.decline({ id: change_id, conversation })),
  );
  register(
    "list_changes",
    "The changes proposed and applied from chat, newest first, with their state, conversation, and config version. Use it to find the change a person wants undone.",
    () => changes.list().map(present),
  );
  register(
    "revert_change",
    "Put an applied change back as it was, only when the person asks for that; quote their request. It is saved and deployed as a new config version, and refused when the target has changed since.",
    async ({ change_id, conversation, request }) => {
      const { change, diff, warning } = await changes.revert({
        id: change_id,
        conversation,
        request,
      });
      return { ...present(change), diff, ...(warning === undefined ? {} : { warning }) };
    },
  );
}
