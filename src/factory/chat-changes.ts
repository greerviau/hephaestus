import type { Database } from "better-sqlite3";
import { setAt } from "../config/diff.js";
import {
  ConfigValidationError,
  ROLE_NAMES,
  isSafeRelativePath,
  validateConfig,
  type FactoryConfig,
  type RoleName,
} from "../config/document.js";
import type { ConfigStore } from "../config/store.js";
import { currentRoleName } from "../legacy-planner.js";
import { unifiedDiff } from "../config/text-diff.js";

/** Publishes an approved version and deploys it. */
export type Deploy = (id: number) => Promise<{ hermesError?: string }>;

/** A proposal that is not approved within this long is dropped. */
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * The fewest milliseconds between a proposal and its approval. A person cannot
 * read a diff and answer in less, so an approval that comes sooner was most
 * likely the agent's own. It is a guard, not proof of what the person said.
 */
export const MIN_REVIEW_MS = 5000;
/** The largest text a change may write. */
export const MAX_CHANGE_BYTES = 256 * 1024;

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The settings chat may change, by name, and where each lives in the config. */
const SETTINGS: Record<string, string[]> = {
  autoStartMinutes: ["factory", "autoStartMinutes"],
  threadSkills: ["factory", "threadSkills"],
  "models.claude": ["factory", "models", "claude"],
  "models.codex": ["factory", "models", "codex"],
  "limits.tasksPerWorker": ["factory", "limits", "tasksPerWorker"],
  "limits.threadsPerWorker": ["factory", "limits", "threadsPerWorker"],
  "limits.threads": ["factory", "limits", "threads"],
  "limits.startsPerDay": ["factory", "limits", "startsPerDay"],
};

/** A skill file whose name says it holds a secret. */
const SECRET_PATH =
  /(^|[/._-])(env|secrets?|credentials?|tokens?|id_rsa|id_ed25519)([/._-]|$)|\.(pem|key|p12|pfx)$/i;

/** Text that looks like a credential. A match refuses the change; the text is never echoed. */
const SECRET_TEXT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /\b(api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{16,}/i,
];

/** A target the allowlist does not cover, or that may hold a secret. */
export class RefusedTargetError extends Error {}

/** A change that is not allowed to go on: wrong state, wrong conversation, stale, or invalid. */
export class ChangeError extends Error {}

type Target =
  | { kind: "skill"; skill: string; file: string }
  | { kind: "instruction"; name: string }
  | { kind: "persona"; role: RoleName }
  | { kind: "setting"; name: string };

/** What chat may edit, for the agent to list and for the docs. */
export const TARGET_FORMS = [
  "skill:<skill>/<file>",
  "instruction:<name>",
  "persona:<role> (the owner's own instructions for a role, which follow the shipped ones)",
  `setting:<${Object.keys(SETTINGS).join("|")}>`,
] as const;

function parseTarget(text: string): Target {
  const refuse = (reason: string): never => {
    throw new RefusedTargetError(
      `${JSON.stringify(text)} cannot be changed from chat: ${reason}. Editable targets: ${TARGET_FORMS.join(", ")}.`,
    );
  };
  const colon = text.indexOf(":");
  if (colon < 0) return refuse("it is not in the allowlist");
  const kind = text.slice(0, colon);
  const rest = text.slice(colon + 1);
  if (kind === "skill") {
    const slash = rest.indexOf("/");
    const skill = slash < 0 ? rest : rest.slice(0, slash);
    const file = slash < 0 ? "" : rest.slice(slash + 1);
    if (!NAME.test(skill) || file === "" || !isSafeRelativePath(file)) {
      return refuse("a skill file is named skill:<skill>/<relative path>");
    }
    if (SECRET_PATH.test(file) || SECRET_PATH.test(skill)) {
      return refuse("its name says it may hold a secret or credential");
    }
    return { kind, skill, file };
  }
  if (kind === "instruction") {
    return NAME.test(rest) ? { kind, name: rest } : refuse("that is not an instruction name");
  }
  if (kind === "persona") {
    const role = currentRoleName(rest);
    return (ROLE_NAMES as readonly string[]).includes(role)
      ? { kind, role: role as RoleName }
      : refuse("that is not a role");
  }
  if (kind === "setting") {
    return Object.hasOwn(SETTINGS, rest)
      ? { kind, name: rest }
      : refuse("that setting is not editable");
  }
  return refuse("it is not in the allowlist");
}

function targetId(target: Target): string {
  switch (target.kind) {
    case "skill":
      return `skill:${target.skill}/${target.file}`;
    case "instruction":
      return `instruction:${target.name}`;
    case "persona":
      return `persona:${target.role}`;
    case "setting":
      return `setting:${target.name}`;
  }
}

/** The target's current text, or undefined when it does not exist yet. */
function currentText(config: FactoryConfig, target: Target): string | undefined {
  switch (target.kind) {
    case "skill":
      return Object.hasOwn(config.skills, target.skill) &&
        Object.hasOwn(config.skills[target.skill] ?? {}, target.file)
        ? config.skills[target.skill]?.[target.file]
        : undefined;
    case "instruction":
      return Object.hasOwn(config.instructions, target.name)
        ? config.instructions[target.name]
        : undefined;
    case "persona":
      return config.roles[target.role].persona;
    case "setting": {
      const path = SETTINGS[target.name] ?? [];
      let value: unknown = config;
      for (const key of path) value = (value as Record<string, unknown> | undefined)?.[key];
      return JSON.stringify(value, null, 2);
    }
  }
}

/** A copy of the config with the target set to `text`, or removed when `text` is undefined. */
function withText(config: FactoryConfig, target: Target, text: string | undefined): FactoryConfig {
  const copy = structuredClone(config) as unknown as Record<string, unknown>;
  switch (target.kind) {
    case "skill": {
      setAt(copy, ["skills", target.skill, target.file], text);
      const files = config.skills[target.skill] ?? {};
      // A skill left with no files is gone.
      const remaining = Object.keys(files).filter((file) => file !== target.file);
      if (text === undefined && remaining.length === 0)
        setAt(copy, ["skills", target.skill], undefined);
      break;
    }
    case "instruction":
      setAt(copy, ["instructions", target.name], text);
      break;
    case "persona":
      setAt(copy, ["roles", target.role, "persona"], text);
      break;
    case "setting":
      setAt(copy, SETTINGS[target.name] ?? [], text === undefined ? undefined : JSON.parse(text));
      break;
  }
  return copy as unknown as FactoryConfig;
}

/** Checks the format of new text before anything is written. Throws ChangeError with what is wrong. */
function checkFormat(target: Target, text: string): string {
  if (Buffer.byteLength(text) > MAX_CHANGE_BYTES) {
    throw new ChangeError(`The text is over ${String(MAX_CHANGE_BYTES / 1024)} KB.`);
  }
  if (text.includes("\0")) throw new ChangeError("The text is not plain text.");
  if (SECRET_TEXT.some((pattern) => pattern.test(text))) {
    throw new RefusedTargetError(
      "The text looks like it holds a secret or credential, so it was refused. Secrets never go into skills, instructions, or settings.",
    );
  }
  if (target.kind === "setting") {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new ChangeError(
        `A setting is JSON, and this is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return JSON.stringify(value, null, 2);
  }
  if (target.kind === "skill") {
    if (target.file.endsWith(".json")) {
      try {
        JSON.parse(text);
      } catch (error) {
        throw new ChangeError(
          `${target.file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (target.file === "SKILL.md") {
      if (text.trim() === "") throw new ChangeError("SKILL.md cannot be empty.");
      checkFrontmatter(text);
    }
  }
  return text;
}

/** A leading `---` block must close and hold only YAML-looking lines: `key: value`, list items, comments, and indented continuations. */
function checkFrontmatter(text: string): void {
  const all = text.split("\n");
  if (all[0]?.trimEnd() !== "---") return;
  const end = all.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end < 0) throw new ChangeError("SKILL.md frontmatter starts with --- but never closes.");
  for (const [index, line] of all.slice(1, end).entries()) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\t/.test(line)) {
      throw new ChangeError(
        `SKILL.md frontmatter line ${String(index + 2)} is indented with a tab.`,
      );
    }
    if (/^\s/.test(line) || /^- /.test(line) || /^[A-Za-z_][\w.-]*:(\s|$)/.test(line)) continue;
    throw new ChangeError(
      `SKILL.md frontmatter line ${String(index + 2)} is not "key: value": ${line.slice(0, 60)}`,
    );
  }
}

export type ChangeState =
  "proposed" | "declined" | "applying" | "applied" | "failed" | "expired" | "reverted";

interface Row {
  id: number;
  target: string;
  summary: string;
  conversation: string;
  state: ChangeState;
  before_text: string | null;
  after_text: string;
  proposed_at: string;
  approval: string | null;
  applied_at: string | null;
  version_id: number | null;
  error: string | null;
  revert_conversation: string | null;
  revert_request: string | null;
  reverted_at: string | null;
  revert_version_id: number | null;
}

export interface ChatChange {
  id: number;
  target: string;
  summary: string;
  state: ChangeState;
  conversation: string;
  proposedAt: string;
  approval: string | null;
  appliedAt: string | null;
  /** The config version the change created. */
  version: number | null;
  error: string | null;
  revertedAt: string | null;
  revertVersion: number | null;
}

function view(row: Row): ChatChange {
  return {
    id: row.id,
    target: row.target,
    summary: row.summary,
    state: row.state,
    conversation: row.conversation,
    proposedAt: row.proposed_at,
    approval: row.approval,
    appliedAt: row.applied_at,
    version: row.version_id,
    error: row.error,
    revertedAt: row.reverted_at,
    revertVersion: row.revert_version_id,
  };
}

export interface ChatChangesOptions {
  db: Database;
  store: ConfigStore;
  /** Absent when nothing can deploy a version; a change then stops at an approved version. */
  deploy?: Deploy | undefined;
  now?: () => Date;
}

/**
 * Changes to the factory's own skills, instructions, personas, and settings
 * that the owner agrees to in a chat. A change is proposed with its exact
 * diff, written only after the same conversation approves it, checked against
 * the config's rules before it is written, and kept as a config version with a
 * record, so it can be reverted. Only the allowlisted targets can change, and
 * never anything that looks like a secret.
 */
export class ChatChanges {
  private readonly now: () => Date;

  constructor(private readonly options: ChatChangesOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private deployed(): { id: number; document: FactoryConfig } {
    const version = this.options.store.list().find((item) => item.state === "deployed");
    if (version === undefined) throw new ChangeError("No config version is deployed.");
    return version;
  }

  /** The targets that exist now, and the forms a new one may take. */
  targets(): { forms: readonly string[]; existing: string[] } {
    const config = this.deployed().document;
    const existing = [
      ...Object.entries(config.skills).flatMap(([skill, files]) =>
        Object.keys(files)
          .filter((file) => !SECRET_PATH.test(file) && !SECRET_PATH.test(skill))
          .map((file) => `skill:${skill}/${file}`),
      ),
      ...Object.keys(config.instructions).map((name) => `instruction:${name}`),
      ...ROLE_NAMES.map((role) => `persona:${role}`),
      ...Object.keys(SETTINGS).map((name) => `setting:${name}`),
    ];
    return { forms: TARGET_FORMS, existing };
  }

  /** The current text of a target. */
  read(target: string): { target: string; exists: boolean; content: string | null } {
    const parsed = parseTarget(target);
    const content = currentText(this.deployed().document, parsed);
    return { target: targetId(parsed), exists: content !== undefined, content: content ?? null };
  }

  /**
   * Records a proposed change and returns its exact diff. Nothing is written to
   * the config. The text is checked here, so nobody is asked to approve a
   * change the config would refuse.
   */
  propose(input: { target: string; content: string; summary: string; conversation: string }): {
    change: ChatChange;
    diff: string;
  } {
    const parsed = parseTarget(input.target);
    const id = targetId(parsed);
    const conversation = input.conversation.trim();
    if (conversation === "") throw new ChangeError("A conversation is required.");
    const text = checkFormat(parsed, input.content);
    const base = this.deployed();
    const before = currentText(base.document, parsed);
    if (before === text)
      throw new ChangeError(`${id} already has that content; nothing to change.`);
    this.validate(withText(base.document, parsed, text));
    const result = this.options.db
      .prepare(
        `INSERT INTO chat_changes (target, summary, conversation, state, before_text, after_text, proposed_at)
         VALUES (?, ?, ?, 'proposed', ?, ?, ?)`,
      )
      .run(id, input.summary, conversation, before ?? null, text, this.now().toISOString());
    return {
      change: this.get(Number(result.lastInsertRowid)),
      diff: unifiedDiff(before, text, id),
    };
  }

  /**
   * Writes a proposed change after the person approved it in the same
   * conversation: creates a config version from the deployed one, checks it,
   * approves it, and deploys it. Throws ChangeError with the reason when it
   * cannot, and the record keeps the error.
   */
  async apply(input: {
    id: number;
    conversation: string;
    approval: string;
  }): Promise<{ change: ChatChange; warning?: string }> {
    const row = this.row(input.id);
    const conversation = input.conversation.trim();
    if (row.state !== "proposed") {
      throw new ChangeError(`Change ${String(row.id)} is ${row.state}, so it cannot be applied.`);
    }
    if (conversation !== row.conversation) {
      throw new ChangeError(
        `Change ${String(row.id)} was proposed in another conversation. Only the conversation that saw the diff can approve it.`,
      );
    }
    if (input.approval.trim() === "") {
      throw new ChangeError("Applying needs the person's approval, quoted from the conversation.");
    }
    const age = this.now().getTime() - Date.parse(row.proposed_at);
    if (age > PROPOSAL_TTL_MS) {
      this.set(row.id, { state: "expired" });
      throw new ChangeError(`Change ${String(row.id)} expired. Propose it again.`);
    }
    if (age < MIN_REVIEW_MS) {
      throw new ChangeError(
        `Change ${String(row.id)} was proposed moments ago. Show the person the diff and wait for their answer before applying it.`,
      );
    }
    // Claimed before any await, so a second apply of the same change finds it taken.
    const claimed = this.options.db
      .prepare(
        "UPDATE chat_changes SET state = 'applying', approval = ? WHERE id = ? AND state = 'proposed'",
      )
      .run(input.approval, row.id);
    if (claimed.changes !== 1)
      throw new ChangeError(`Change ${String(row.id)} is already being applied.`);

    const target = parseTarget(row.target);
    const fail = (message: string, version?: number): never => {
      this.set(row.id, {
        state: "failed",
        error: message,
        ...(version === undefined ? {} : { version }),
      });
      throw new ChangeError(message);
    };
    const base = this.deployed();
    if ((currentText(base.document, target) ?? null) !== row.before_text) {
      return fail(
        `${row.target} changed after this was proposed. Read it again and propose the change again.`,
      );
    }
    let versionId: number;
    try {
      const next = withText(base.document, target, row.after_text);
      this.validate(next);
      versionId = this.options.store.createVersion({
        document: next,
        author: "chat",
        message: `Chat change ${String(row.id)}: ${row.summary}`,
        parentId: base.id,
      }).id;
    } catch (error) {
      return fail(error instanceof ChangeError ? error.message : String(error));
    }
    this.options.store.approve(versionId);
    return this.deploy(row.id, versionId, "applied");
  }

  /** Records that the person declined a proposal, so nothing is written. */
  decline(input: { id: number; conversation: string }): ChatChange {
    const row = this.row(input.id);
    if (row.state !== "proposed") {
      throw new ChangeError(`Change ${String(row.id)} is ${row.state}, so it cannot be declined.`);
    }
    if (input.conversation.trim() !== row.conversation) {
      throw new ChangeError(`Change ${String(row.id)} was proposed in another conversation.`);
    }
    this.set(row.id, { state: "declined" });
    return this.get(row.id);
  }

  /**
   * Puts an applied change's target back as it was, as a new config version.
   * Refused when the target has changed again since, so a later edit is never
   * overwritten.
   */
  async revert(input: {
    id: number;
    conversation: string;
    request: string;
  }): Promise<{ change: ChatChange; diff: string; warning?: string }> {
    const row = this.row(input.id);
    if (row.state !== "applied") {
      throw new ChangeError(
        `Change ${String(row.id)} is ${row.state}; only an applied change can be reverted.`,
      );
    }
    if (input.request.trim() === "" || input.conversation.trim() === "") {
      throw new ChangeError(
        "Reverting needs the person's request, quoted, and the conversation it came in.",
      );
    }
    const target = parseTarget(row.target);
    const base = this.deployed();
    const now = currentText(base.document, target);
    if (now !== row.after_text) {
      throw new ChangeError(
        `${row.target} has changed since change ${String(row.id)}, so reverting it would overwrite a later edit. Propose the edit you want instead.`,
      );
    }
    const before = row.before_text ?? undefined;
    const next = withText(base.document, target, before);
    this.validate(next);
    const diff = unifiedDiff(now, before, row.target);
    const versionId = this.options.store.createVersion({
      document: next,
      author: "chat",
      message: `Revert chat change ${String(row.id)}`,
      parentId: base.id,
    }).id;
    this.options.store.approve(versionId);
    this.options.db
      .prepare(
        "UPDATE chat_changes SET revert_conversation = ?, revert_request = ?, revert_version_id = ? WHERE id = ?",
      )
      .run(input.conversation.trim(), input.request, versionId, row.id);
    const done = await this.deploy(row.id, versionId, "reverted");
    return { ...done, diff };
  }

  /** Recent changes, newest first. */
  list(limit = 20): ChatChange[] {
    return (
      this.options.db
        .prepare("SELECT * FROM chat_changes ORDER BY id DESC LIMIT ?")
        .all(limit) as Row[]
    ).map(view);
  }

  get(id: number): ChatChange {
    return view(this.row(id));
  }

  private row(id: number): Row {
    const row = this.options.db.prepare("SELECT * FROM chat_changes WHERE id = ?").get(id) as
      Row | undefined;
    if (row === undefined) throw new ChangeError(`There is no change ${String(id)}.`);
    return row;
  }

  private validate(config: FactoryConfig): void {
    try {
      validateConfig(config);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        throw new ChangeError(`The config would be invalid: ${error.problems.join("; ")}`);
      }
      throw error;
    }
  }

  /** Deploys an approved version and records the outcome on the change. */
  private async deploy(
    id: number,
    versionId: number,
    done: "applied" | "reverted",
  ): Promise<{ change: ChatChange; warning?: string }> {
    const stamp = this.now().toISOString();
    const finish = (): void => {
      if (done === "applied") this.set(id, { state: "applied", version: versionId, at: stamp });
      else this.set(id, { state: "reverted", revertedAt: stamp });
    };
    const { deploy } = this.options;
    if (deploy === undefined) {
      finish();
      return {
        change: this.get(id),
        warning: `Saved as version ${String(versionId)}, approved but not deployed: nothing here can deploy it.`,
      };
    }
    try {
      const { hermesError } = await deploy(versionId);
      finish();
      return {
        change: this.get(id),
        ...(hermesError === undefined
          ? {}
          : { warning: `Deployed, but applying it to the factory Hermes failed: ${hermesError}` }),
      };
    } catch (error) {
      const message = `Version ${String(versionId)} is approved but deploying it failed: ${error instanceof Error ? error.message : String(error)}. The owner can deploy it from the dashboard.`;
      if (done === "applied") this.set(id, { state: "failed", error: message, version: versionId });
      else
        this.options.db.prepare("UPDATE chat_changes SET error = ? WHERE id = ?").run(message, id);
      throw new ChangeError(message);
    }
  }

  private set(
    id: number,
    fields: {
      state?: ChangeState;
      error?: string;
      version?: number;
      at?: string;
      revertedAt?: string;
    },
  ): void {
    this.options.db
      .prepare(
        `UPDATE chat_changes SET
           state = COALESCE(?, state),
           error = COALESCE(?, error),
           version_id = COALESCE(?, version_id),
           applied_at = COALESCE(?, applied_at),
           reverted_at = COALESCE(?, reverted_at)
         WHERE id = ?`,
      )
      .run(
        fields.state ?? null,
        fields.error ?? null,
        fields.version ?? null,
        fields.at ?? null,
        fields.revertedAt ?? null,
        id,
      );
  }
}
