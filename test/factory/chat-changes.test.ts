import { beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import {
  ChangeError,
  ChatChanges,
  MIN_REVIEW_MS,
  PROPOSAL_TTL_MS,
  RefusedTargetError,
} from "../../src/factory/chat-changes.js";
import { openStore } from "../../src/store.js";
import { sampleConfig } from "../config/fixtures.js";

const CHAT = "discord:thread-1";

interface Setup {
  store: ConfigStore;
  changes: ChatChanges;
  clock: { now: number };
  deployed: number[];
  /** Makes the next deploy fail with this message. */
  failDeploy: { message?: string; hermesError?: string };
  /** The age a proposal needs before the person could have answered. */
  wait: () => void;
}

function setup(withDeploy = true): Setup {
  const db = openStore(":memory:");
  const clock = { now: Date.parse("2026-11-27T10:00:00Z") };
  const store = new ConfigStore(db, () => new Date(clock.now));
  const first = store.createVersion({
    document: sampleConfig(),
    author: "owner",
    message: "first",
  });
  store.approve(first.id);
  store.markDeployed(first.id);
  const deployed: number[] = [];
  const failDeploy: Setup["failDeploy"] = {};
  const changes = new ChatChanges({
    db,
    store,
    now: () => new Date(clock.now),
    deploy: withDeploy
      ? (id) => {
          if (failDeploy.message !== undefined)
            return Promise.reject(new Error(failDeploy.message));
          store.markDeployed(id);
          deployed.push(id);
          return Promise.resolve(
            failDeploy.hermesError === undefined ? {} : { hermesError: failDeploy.hermesError },
          );
        }
      : undefined,
  });
  return {
    store,
    changes,
    clock,
    deployed,
    failDeploy,
    wait: () => {
      clock.now += MIN_REVIEW_MS + 1000;
    },
  };
}

function deployedConfig(s: Setup): ReturnType<ConfigStore["list"]>[number]["document"] {
  const version = s.store.list().find((item) => item.state === "deployed");
  if (version === undefined) throw new Error("none deployed");
  return version.document;
}

const TRIAGE = "skill:triage/SKILL.md";

describe("ChatChanges", () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });

  describe("reading", () => {
    it("shows the current content of a skill, an instruction, a persona, and a setting", () => {
      expect(s.changes.read(TRIAGE)).toEqual({
        target: TRIAGE,
        exists: true,
        content: "# Triage\n",
      });
      expect(s.changes.read("instruction:factory").content).toBe("# Factory instructions\n");
      expect(s.changes.read("persona:planner").content).toBe("Plan the work.");
      expect(s.changes.read("setting:autoStartMinutes").content).toBe("10");
      expect(JSON.parse(s.changes.read("setting:models.claude").content ?? "")).toHaveProperty(
        "model",
      );
    });

    it("lists what can be changed, and none of it is a secret", () => {
      const { existing } = s.changes.targets();
      expect(existing).toContain(TRIAGE);
      expect(existing).toContain("setting:limits.threads");
      expect(existing).toContain("persona:improver");
      expect(existing.join("\n")).not.toMatch(/secret|projects/);
    });

    it("says a skill file that does not exist yet does not exist", () => {
      expect(s.changes.read("skill:triage/notes.md")).toMatchObject({
        exists: false,
        content: null,
      });
    });
  });

  describe("approve", () => {
    it("proposes without writing, then applies after approval", async () => {
      const { change, diff } = s.changes.propose({
        target: TRIAGE,
        content: "# Triage\nAsk for logs.\n",
        summary: "Ask for logs",
        conversation: CHAT,
      });

      expect(diff).toContain("+Ask for logs.");
      expect(diff).toContain("--- before/skill:triage/SKILL.md");
      expect(change.state).toBe("proposed");
      // Nothing is written before approval.
      expect(s.store.count()).toBe(1);
      expect(deployedConfig(s).skills.triage?.["SKILL.md"]).toBe("# Triage\n");

      s.wait();
      const applied = await s.changes.apply({
        id: change.id,
        conversation: CHAT,
        approval: "yes, do it",
      });

      expect(applied.change).toMatchObject({
        state: "applied",
        approval: "yes, do it",
        conversation: CHAT,
        version: 2,
        appliedAt: new Date(s.clock.now).toISOString(),
      });
      expect(s.store.get(2)).toMatchObject({
        author: "chat",
        state: "deployed",
        parentId: 1,
        message: "Chat change 1: Ask for logs",
      });
      expect(deployedConfig(s).skills.triage?.["SKILL.md"]).toBe("# Triage\nAsk for logs.\n");
      expect(s.deployed).toEqual([2]);
    });

    it("changes a setting from JSON and a persona from text", async () => {
      const limits = s.changes.propose({
        target: "setting:limits.threads",
        content: "7",
        summary: "More threads",
        conversation: CHAT,
      });
      const persona = s.changes.propose({
        target: "persona:lead",
        content: "Lead the work, briefly.",
        summary: "Shorter lead",
        conversation: CHAT,
      });
      s.wait();
      await s.changes.apply({ id: limits.change.id, conversation: CHAT, approval: "ok" });
      // The second change is checked against the version the first created.
      await s.changes.apply({ id: persona.change.id, conversation: CHAT, approval: "ok" });

      const config = deployedConfig(s);
      expect(config.factory.limits.threads).toBe(7);
      expect(config.roles.lead.persona).toBe("Lead the work, briefly.");
      expect(config.roles.planner.persona).toBe("Plan the work.");
    });

    it("creates a new file in a skill", async () => {
      const { change, diff } = s.changes.propose({
        target: "skill:triage/checklist.md",
        content: "- logs\n",
        summary: "Add a checklist",
        conversation: CHAT,
      });
      expect(diff).toContain("--- /dev/null");
      s.wait();
      await s.changes.apply({ id: change.id, conversation: CHAT, approval: "yes" });
      expect(deployedConfig(s).skills.triage?.["checklist.md"]).toBe("- logs\n");
    });

    it("applies a change once", async () => {
      const { change } = s.changes.propose({
        target: "instruction:factory",
        content: "# New\n",
        summary: "s",
        conversation: CHAT,
      });
      s.wait();
      const first = s.changes.apply({ id: change.id, conversation: CHAT, approval: "yes" });
      await expect(
        s.changes.apply({ id: change.id, conversation: CHAT, approval: "yes" }),
      ).rejects.toThrow(/applying/);
      await first;
      await expect(
        s.changes.apply({ id: change.id, conversation: CHAT, approval: "yes" }),
      ).rejects.toThrow(/is applied/);
      expect(s.store.count()).toBe(2);
    });

    it("refuses an approval without the person's words, from another conversation, or too soon", async () => {
      const { change } = s.changes.propose({
        target: "instruction:factory",
        content: "# New\n",
        summary: "s",
        conversation: CHAT,
      });
      await expect(
        s.changes.apply({ id: change.id, conversation: CHAT, approval: "yes" }),
      ).rejects.toThrow(/moments ago/);
      s.wait();
      await expect(
        s.changes.apply({ id: change.id, conversation: CHAT, approval: "  " }),
      ).rejects.toThrow(/approval/);
      await expect(
        s.changes.apply({ id: change.id, conversation: "discord:other", approval: "yes" }),
      ).rejects.toThrow(/another conversation/);
      expect(s.store.count()).toBe(1);
      expect(s.changes.get(change.id).state).toBe("proposed");
    });

    it("reports a deploy that fails, and keeps the error on the record", async () => {
      const { change } = s.changes.propose({
        target: "instruction:factory",
        content: "# New\n",
        summary: "s",
        conversation: CHAT,
      });
      s.wait();
      s.failDeploy.message = "the config repo is down";
      await expect(
        s.changes.apply({ id: change.id, conversation: CHAT, approval: "yes" }),
      ).rejects.toThrow(/deploying it failed: the config repo is down/);
      expect(s.changes.get(change.id)).toMatchObject({ state: "failed", version: 2 });
      expect(s.store.get(2).state).toBe("approved");
    });

    it("passes on a warning when the factory Hermes could not take the version", async () => {
      const { change } = s.changes.propose({
        target: "instruction:factory",
        content: "# New\n",
        summary: "s",
        conversation: CHAT,
      });
      s.wait();
      s.failDeploy.hermesError = "hermes is busy";
      const result = await s.changes.apply({ id: change.id, conversation: CHAT, approval: "yes" });
      expect(result.warning).toContain("hermes is busy");
      expect(result.change.state).toBe("applied");
    });

    it("stops at an approved version when nothing can deploy it", async () => {
      const bare = setup(false);
      const { change } = bare.changes.propose({
        target: "instruction:factory",
        content: "# New\n",
        summary: "s",
        conversation: CHAT,
      });
      bare.wait();
      const result = await bare.changes.apply({
        id: change.id,
        conversation: CHAT,
        approval: "yes",
      });
      expect(result.warning).toContain("not deployed");
      expect(bare.store.get(2).state).toBe("approved");
    });
  });

  describe("decline or silence", () => {
    it("changes nothing when the person declines", () => {
      const { change } = s.changes.propose({
        target: TRIAGE,
        content: "# Other\n",
        summary: "s",
        conversation: CHAT,
      });
      expect(s.changes.decline({ id: change.id, conversation: CHAT }).state).toBe("declined");
      expect(s.store.count()).toBe(1);
      s.wait();
      return expect(
        s.changes.apply({ id: change.id, conversation: CHAT, approval: "actually yes" }),
      ).rejects.toThrow(/is declined/);
    });

    it("changes nothing when the person says nothing, and a late approval is refused", async () => {
      const { change } = s.changes.propose({
        target: TRIAGE,
        content: "# Other\n",
        summary: "s",
        conversation: CHAT,
      });
      expect(s.store.count()).toBe(1);
      expect(deployedConfig(s).skills.triage?.["SKILL.md"]).toBe("# Triage\n");
      s.clock.now += PROPOSAL_TTL_MS + 1000;
      await expect(
        s.changes.apply({ id: change.id, conversation: CHAT, approval: "yes" }),
      ).rejects.toThrow(/expired/);
      expect(s.changes.get(change.id).state).toBe("expired");
      expect(s.store.count()).toBe(1);
    });

    it("refuses to decline from another conversation", () => {
      const { change } = s.changes.propose({
        target: TRIAGE,
        content: "# Other\n",
        summary: "s",
        conversation: CHAT,
      });
      expect(() => s.changes.decline({ id: change.id, conversation: "x" })).toThrow(ChangeError);
    });
  });

  describe("validation", () => {
    it("refuses a setting that is not JSON, before anyone is asked to approve", () => {
      expect(() =>
        s.changes.propose({
          target: "setting:limits.threads",
          content: "seven",
          summary: "s",
          conversation: CHAT,
        }),
      ).toThrow(/not valid JSON/);
      expect(s.changes.list()).toEqual([]);
    });

    it("refuses a setting the config would reject", () => {
      expect(() =>
        s.changes.propose({
          target: "setting:limits.threads",
          content: "-1",
          summary: "s",
          conversation: CHAT,
        }),
      ).toThrow(/factory.limits.threads must be a whole number/);
      expect(() =>
        s.changes.propose({
          target: "setting:threadSkills",
          content: '["nope"]',
          summary: "s",
          conversation: CHAT,
        }),
      ).toThrow(/unknown skill nope/);
    });

    it("refuses broken frontmatter, bad JSON in a skill, and empty text", () => {
      const propose = (target: string, content: string): unknown =>
        s.changes.propose({ target, content, summary: "s", conversation: CHAT });
      expect(() => propose(TRIAGE, "---\nname: triage\n# no end\n")).toThrow(/never closes/);
      expect(() => propose(TRIAGE, "---\nname triage\n---\nbody")).toThrow(/not "key: value"/);
      expect(() => propose("skill:triage/data.json", "{oops")).toThrow(/not valid JSON/);
      expect(() => propose("instruction:factory", "  \n")).toThrow(/cannot be empty/);
      expect(() => propose("persona:lead", "")).toThrow(/cannot be empty/);
    });

    it("accepts frontmatter", () => {
      expect(
        s.changes.propose({
          target: TRIAGE,
          content: "---\nname: triage\ndescription: Sort issues\ntags:\n  - a\n---\n# Triage\n",
          summary: "s",
          conversation: CHAT,
        }).change.state,
      ).toBe("proposed");
    });

    it("refuses an unchanged text", () => {
      expect(() =>
        s.changes.propose({
          target: TRIAGE,
          content: "# Triage\n",
          summary: "s",
          conversation: CHAT,
        }),
      ).toThrow(/nothing to change/);
    });

    it("checks again at apply time and reports the config's error", async () => {
      const { change } = s.changes.propose({
        target: "setting:threadSkills",
        content: '["triage"]',
        summary: "Load triage",
        conversation: CHAT,
      });
      // The owner removes the skill, and drops it from the planner, before the person answers.
      const config = structuredClone(deployedConfig(s));
      config.skills = { other: { "SKILL.md": "# Other\n" } };
      config.roles.planner.skills = [];
      const owner = s.store.createVersion({
        document: config,
        author: "owner",
        message: "drop",
        parentId: 1,
      });
      s.store.approve(owner.id);
      s.store.markDeployed(owner.id);
      s.wait();

      await expect(
        s.changes.apply({ id: change.id, conversation: CHAT, approval: "yes" }),
      ).rejects.toThrow(/unknown skill triage/);
      expect(s.changes.get(change.id)).toMatchObject({ state: "failed" });
      expect(s.changes.get(change.id).error).toMatch(/unknown skill triage/);
      expect(s.store.count()).toBe(2);
    });

    it("refuses to apply over an edit made after the proposal", async () => {
      const { change } = s.changes.propose({
        target: "instruction:factory",
        content: "# Mine\n",
        summary: "s",
        conversation: CHAT,
      });
      const config = structuredClone(deployedConfig(s));
      config.instructions.factory = "# Owner's\n";
      const owner = s.store.createVersion({
        document: config,
        author: "owner",
        message: "edit",
        parentId: 1,
      });
      s.store.approve(owner.id);
      s.store.markDeployed(owner.id);
      s.wait();
      await expect(
        s.changes.apply({ id: change.id, conversation: CHAT, approval: "yes" }),
      ).rejects.toThrow(/changed after this was proposed/);
      expect(deployedConfig(s).instructions.factory).toBe("# Owner's\n");
    });
  });

  describe("revert", () => {
    async function applied(target = "instruction:factory", content = "# New\n"): Promise<number> {
      const { change } = s.changes.propose({ target, content, summary: "s", conversation: CHAT });
      s.wait();
      await s.changes.apply({ id: change.id, conversation: CHAT, approval: "yes" });
      return change.id;
    }

    it("restores the earlier text as a new version and records it", async () => {
      const id = await applied();
      s.clock.now += 60_000;
      const result = await s.changes.revert({
        id,
        conversation: "discord:later",
        request: "undo that",
      });

      expect(result.diff).toContain("-# New");
      expect(result.diff).toContain("+# Factory instructions");
      expect(deployedConfig(s).instructions.factory).toBe("# Factory instructions\n");
      expect(s.changes.get(id)).toMatchObject({
        state: "reverted",
        revertVersion: 3,
        revertedAt: new Date(s.clock.now).toISOString(),
      });
      expect(s.store.get(3)).toMatchObject({
        author: "chat",
        message: `Revert chat change ${String(id)}`,
      });
      await expect(s.changes.revert({ id, conversation: CHAT, request: "again" })).rejects.toThrow(
        /is reverted/,
      );
    });

    it("removes a file the change created", async () => {
      const id = await applied("skill:triage/checklist.md", "- logs\n");
      await s.changes.revert({ id, conversation: CHAT, request: "undo" });
      expect(deployedConfig(s).skills.triage).toEqual({ "SKILL.md": "# Triage\n" });
    });

    it("refuses when the target changed again, so a later edit is not overwritten", async () => {
      const id = await applied();
      await applied("instruction:factory", "# Newer\n");
      await expect(s.changes.revert({ id, conversation: CHAT, request: "undo" })).rejects.toThrow(
        /has changed since/,
      );
      expect(deployedConfig(s).instructions.factory).toBe("# Newer\n");
    });

    it("refuses a change that was never applied, and a revert with no request", async () => {
      const { change } = s.changes.propose({
        target: TRIAGE,
        content: "# Other\n",
        summary: "s",
        conversation: CHAT,
      });
      await expect(
        s.changes.revert({ id: change.id, conversation: CHAT, request: "undo" }),
      ).rejects.toThrow(/only an applied change/);
      const id = await applied();
      await expect(s.changes.revert({ id, conversation: CHAT, request: " " })).rejects.toThrow(
        /request/,
      );
    });
  });

  describe("targets outside the allowlist", () => {
    const propose = (target: string, content = "x"): unknown =>
      s.changes.propose({ target, content, summary: "s", conversation: CHAT });

    it.each([
      "projects:octo/app",
      "project:octo/app",
      "setting:setup",
      "setting:projects",
      "setting:__proto__",
      "setting:",
      "secrets.json",
      "secret:hermes-mcp-token-planner",
      "file:/home/owner/.hermes/.env",
      "persona:owner",
      "instruction:../escape",
      "skill:triage",
      "skill:triage/",
      "skill:triage/../../etc/passwd",
      "skill:../x/SKILL.md",
      "",
    ])("refuses %j", (target) => {
      expect(() => propose(target)).toThrow(RefusedTargetError);
      expect(() => s.changes.read(target)).toThrow(RefusedTargetError);
    });

    it.each([
      "skill:triage/.env",
      "skill:triage/secrets.json",
      "skill:triage/credentials",
      "skill:triage/keys/id_rsa",
      "skill:triage/cert.pem",
      "skill:secrets/SKILL.md",
      "skill:triage/api-token.txt",
    ])("refuses %j because its name says it holds a secret", (target) => {
      expect(() => propose(target)).toThrow(/secret or credential/);
    });

    it.each([
      "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc",
      "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
      "API_KEY=abcdefghijklmnop1234",
      "aws AKIAABCDEFGHIJKLMNOP",
    ])("refuses text that looks like a credential: %j", (content) => {
      expect(() => propose("instruction:factory", content)).toThrow(RefusedTargetError);
      expect(() => propose(TRIAGE, content)).toThrow(/secret/);
      expect(s.changes.list()).toEqual([]);
    });

    it("never echoes the secret it refused", () => {
      try {
        propose("instruction:factory", "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789");
      } catch (error) {
        expect(String(error)).not.toContain("ghp_");
      }
    });

    it("allows prose that only mentions a token", () => {
      expect(() =>
        propose("instruction:factory", "Never print the token. Use the token name."),
      ).not.toThrow();
    });

    it("writes nothing for a refused target even when approved", async () => {
      expect(() => propose("projects:octo/app")).toThrow();
      await expect(
        s.changes.apply({ id: 99, conversation: CHAT, approval: "yes" }),
      ).rejects.toThrow(/no change 99/);
      expect(s.store.count()).toBe(1);
    });
  });
});
