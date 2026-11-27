import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FactoryConfig } from "../../src/config/document.js";
import { sampleConfig } from "../config/fixtures.js";
import { startDashboard, type Dashboard } from "./dashboard.js";

let dashboard: Dashboard;
let base: number;

/** A config with two skills: `triage` loaded by the planner and by coding threads, `brief` by nothing. */
function agentsConfig(): FactoryConfig {
  const config = sampleConfig();
  config.skills = {
    triage: {
      "SKILL.md":
        "---\nname: triage\ndescription: Decide whether an issue is <ready>.\n---\n\n# Triage\n",
      "examples/good.md": "A good one.\n",
    },
    brief: { "SKILL.md": "# Brief\n" },
  };
  config.factory.threadSkills = ["triage"];
  return config;
}

beforeEach(async () => {
  dashboard = await startDashboard({
    configRepo: "octo/hephaestus-config",
    deploy: (id) => {
      dashboard.store.markDeployed(id);
      return Promise.resolve({});
    },
  });
  const version = dashboard.store.createVersion({
    document: agentsConfig(),
    author: "owner",
    message: "Two skills",
    parentId: 1,
  });
  dashboard.store.approve(version.id);
  dashboard.store.markDeployed(version.id);
  base = version.id;
});

afterEach(async () => {
  await dashboard.close();
});

function post(path: string, fields: Record<string, string | string[]>): Promise<Response> {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) body.append(name, one);
  }
  return fetch(`${dashboard.base}${path}`, {
    method: "POST",
    headers: { cookie: dashboard.cookie, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
  });
}

function newest(): { id: number; state: string; message: string; document: FactoryConfig } {
  const version = dashboard.store.list()[0];
  if (version === undefined) throw new Error("no version");
  return version;
}

function unescape(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** What a browser sends when the owner presses Save on the editor form of a page, as the page came back. */
function editorFields(html: string, action: string): Record<string, string | string[]> {
  const form =
    new RegExp(`<form class="form wide" method="post" action="${action}">(.*?)</form>`, "s").exec(
      html,
    )?.[1] ?? "";
  const fields: Record<string, string | string[]> = {};
  for (const [, name, value] of form.matchAll(
    /<input type="hidden" name="([^"]*)" value="([^"]*)">/g,
  )) {
    fields[name ?? ""] = unescape(value ?? "");
  }
  fields.text = unescape(
    /<textarea[^>]* name="text"[^>]*>\n(.*?)<\/textarea>/s.exec(form)?.[1] ?? "no editor",
  );
  fields.message = unescape(/ name="message" value="([^"]*)"/.exec(form)?.[1] ?? "");
  fields.skills = [
    ...form.matchAll(/<input type="checkbox" name="skills" value="([^"]*)" checked>/g),
  ].map(([, skill]) => unescape(skill ?? ""));
  if (form.includes('name="deploy" value="on" checked')) fields.deploy = "on";
  return fields;
}

/** Another edit that lands while a form is open: a deployed version on top of `base`. */
function editMeanwhile(change: (config: FactoryConfig) => void): number {
  const document = agentsConfig();
  change(document);
  const version = dashboard.store.createVersion({
    document,
    author: "owner",
    message: "Meanwhile",
    parentId: base,
  });
  dashboard.store.approve(version.id);
  dashboard.store.markDeployed(version.id);
  return version.id;
}

describe("A stale editor form", () => {
  it("comes back with the saved skill text, so saving again cannot undo a newer edit", async () => {
    const newer = editMeanwhile((config) => {
      const files = config.skills.triage;
      if (files !== undefined) files["SKILL.md"] = "# Triage, rewritten\n";
    });

    const refused = await post("/config/skills/triage", {
      parentId: String(base),
      file: "SKILL.md",
      text: "# Triage, my <stale> draft\n",
      message: "Mine",
      deploy: "on",
    });
    const html = await refused.text();

    expect(refused.status).toBe(400);
    expect(newest().id).toBe(newer);
    // The editor holds the saved text; what was typed is kept where it cannot be sent.
    const again = editorFields(html, "/config/skills/triage");
    expect(again.parentId).toBe(String(newer));
    expect(again.text).toBe("# Triage, rewritten\n");
    expect(html).toContain("The config changed since the page was loaded");
    expect(html).toContain(
      `Version ${String(newer)} is now the current one, and this form was built from version ${String(base)}`,
    );
    expect(html).toMatch(
      /<textarea id="typed-text" class="config" readonly[^>]*>\n# Triage, my &lt;stale&gt; draft\n<\/textarea>/,
    );
    expect(html).not.toMatch(/<textarea[^>]*name="text"[^>]*>\n# Triage, my/);

    await post("/config/skills/triage", again);

    expect(newest().document.skills.triage?.["SKILL.md"]).toBe("# Triage, rewritten\n");
    for (const version of dashboard.store.list()) {
      expect(version.document.skills.triage?.["SKILL.md"]).not.toContain("my <stale> draft");
    }
  });

  it("comes back with the saved instructions and skills, so saving again drops no skill a newer edit added", async () => {
    const newer = editMeanwhile((config) => {
      config.roles.lead.persona = "Lead, rewritten.";
      config.roles.lead.skills = ["brief"];
    });

    const refused = await post("/config/agents/lead", {
      parentId: String(base),
      text: "Lead, my stale draft.",
      skills: ["triage"],
      message: "Mine",
      deploy: "on",
    });
    const html = await refused.text();

    expect(refused.status).toBe(400);
    expect(html).toContain("The config changed since the page was loaded");
    const again = editorFields(html, "/config/agents/lead");
    expect(again).toMatchObject({
      parentId: String(newer),
      text: "Lead, rewritten.",
      skills: ["brief"],
    });
    expect(html).toMatch(
      /<textarea id="typed-text" class="config" readonly[^>]*>\nLead, my stale draft\.<\/textarea>/,
    );
    expect(html).toContain("You had ticked: triage.");

    await post("/config/agents/lead", again);

    expect(newest().document.roles.lead).toMatchObject({
      persona: "Lead, rewritten.",
      skills: ["brief"],
    });
  });

  it("keeps the version a form was built from when it is refused for another reason", async () => {
    const refused = await post("/config/agents/lead", {
      parentId: String(base),
      text: "Typed.",
      skills: ["ghost"],
      message: "m",
    });
    const again = editorFields(await refused.text(), "/config/agents/lead");
    expect(again).toMatchObject({ parentId: String(base), text: "Typed." });

    // An edit lands before the owner corrects the form; the corrected form is stale, not current.
    const newer = editMeanwhile((config) => {
      config.roles.lead.persona = "Lead, rewritten.";
    });
    const corrected = await post("/config/agents/lead", { ...again, skills: [] });

    expect(corrected.status).toBe(400);
    expect(newest().id).toBe(newer);
  });

  it("does not delete or rename a skill from a dialog built on an older version", async () => {
    const newer = editMeanwhile((config) => {
      config.roles.lead.skills = ["brief"];
    });

    const deleted = await post("/config/skills/brief/delete", { parentId: String(base) });
    const renamed = await post("/config/skills/brief/rename", {
      parentId: String(base),
      name: "briefing",
    });
    const created = await post("/config/skills", { parentId: String(base), name: "fresh" });

    expect([deleted.status, renamed.status, created.status]).toEqual([400, 400, 400]);
    expect(newest().id).toBe(newer);
    // The confirm that comes back describes the skill as it is now.
    expect(await deleted.text()).toContain("Lead loads it; deleting it unloads it from Lead.");
  });
});

describe("Text too large to save", () => {
  it("refuses text over the limit of a skill file, says the limit, and keeps the text", async () => {
    const text = "x".repeat(256 * 1024 + 1);

    const skill = await post("/config/skills/brief", {
      parentId: String(base),
      file: "SKILL.md",
      text,
      message: "Big",
      deploy: "on",
    });
    const html = await skill.text();
    expect(skill.status).toBe(400);
    expect(html).toContain("The text is larger than 256 KB, the most one file holds.");
    expect(html).toContain(`${text}</textarea>`);

    const set = await post("/config/agents/lead", { parentId: String(base), text, message: "Big" });
    expect(set.status).toBe(400);
    expect(await set.text()).toContain("The text is larger than 256 KB");
    expect(newest().id).toBe(base);
  });

  it("says a form larger than it reads holds too much text, with the limit", async () => {
    const response = await post("/config/skills/brief", {
      parentId: String(base),
      file: "SKILL.md",
      text: "x".repeat(2 * 1024 * 1024),
      message: "Huge",
    });
    const html = await response.text();

    expect(response.status).toBe(413);
    expect(html).toContain("One file holds at most 256 KB of text");
    expect(html).toContain('href="/config/skills/brief"');
    expect(newest().id).toBe(base);
  });
});

describe("Agents tab", () => {
  it("lists each instruction set with how many skills it loads", async () => {
    const { status, html } = await dashboard.get("/config/agents");

    expect(status).toBe(200);
    for (const [name, title] of [
      ["planner", "Planner"],
      ["lead", "Lead"],
      ["improver", "Improver"],
      ["threads", "Coding threads"],
    ]) {
      expect(html).toContain(`href="/config/agents/${name ?? ""}"`);
      expect(html).toContain(`<span class="title">${title ?? ""}</span>`);
    }
    expect(html).toContain("1 skill<");
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it("lists each skill with its description, which instruction sets load it, and its file count", async () => {
    const { html } = await dashboard.get("/config/agents");

    expect(html).toContain('href="/config/skills/triage"');
    expect(html).toContain("Decide whether an issue is &lt;ready&gt;.");
    expect(html).toContain("used by Planner, Coding threads &middot; 2 files");
    expect(html).toContain("not used &middot; 1 file<");
    expect(html).toContain('popovertarget="new-skill">New skill</button>');
    expect(html).toContain('action="/config/skills"');
  });

  it("says so when there are no skills", async () => {
    const none = agentsConfig();
    none.skills = {};
    none.roles.planner.skills = [];
    none.factory.threadSkills = [];
    await post("/config/json", {
      document: JSON.stringify(none),
      message: "No skills",
      parentId: String(base),
    });
    dashboard.store.approve(base + 1);
    dashboard.store.markDeployed(base + 1);

    expect((await dashboard.get("/config/agents")).html).toContain("No skills yet.");
  });
});

describe("Instructions editor", () => {
  it("shows a role's instructions and which skills it loads", async () => {
    const { status, html } = await dashboard.get("/config/agents/planner");

    expect(status).toBe(200);
    expect(html).toContain("Planner instructions</h1>");
    expect(html).toContain('<a href="/config/agents">Agents</a>');
    expect(html).toContain("Plan the work.</textarea>");
    expect(html).toContain('name="skills" value="triage" checked');
    expect(html).toContain('name="skills" value="brief">');
    expect(html).toContain(`name="parentId" value="${String(base)}"`);
    expect(html).toContain('name="message"');
    expect(html).toContain("Deploy now");
  });

  it("shows a role's shipped instructions read-only, and says which of the owner's paragraphs repeat them", async () => {
    editMeanwhile((config) => {
      config.roles.lead.persona =
        "You are the lead for a software factory run by Hephaestus.\n\nAsk for tests.\n";
    });
    const { html } = await dashboard.get("/config/agents/lead");

    expect(html).toContain("Shipped with Hephaestus");
    expect(html).toMatch(/<pre[^>]*>[^<]*`start_work`/);
    expect(html).toContain("Your instructions");
    expect(html).toContain("1 passage here repeats");
  });

  it("shows the factory thread instructions and the skills threads load", async () => {
    const { html } = await dashboard.get("/config/agents/threads");

    expect(html).toContain("Coding threads instructions</h1>");
    expect(html).toContain("Shipped with Hephaestus");
    expect(html).toContain("Nobody watches this thread");
    expect(html).toContain("Your instructions");
    expect(html).toContain("# Factory instructions\n</textarea>");
    expect(html).toContain('name="skills" value="triage" checked');
  });

  it("saves a role's instructions and skills as a deployed version with the message", async () => {
    const response = await post("/config/agents/lead", {
      parentId: String(base),
      text: "Lead <carefully>.\r\nWrite a brief.\r\n",
      skills: ["brief", "triage"],
      message: "Sharpen the lead",
      deploy: "on",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/config/agents/lead?saved=${String(base + 1)}`);
    const saved = newest();
    expect(saved).toMatchObject({ state: "deployed", message: "Sharpen the lead" });
    // A browser sends a textarea's lines with CRLF; the config keeps LF.
    expect(saved.document.roles.lead).toEqual({
      persona: "Lead <carefully>.\nWrite a brief.\n",
      skills: ["brief", "triage"],
    });
    expect(saved.document.roles.planner).toEqual(agentsConfig().roles.planner);
    const { html } = await dashboard.get(`/config/agents/lead?saved=${String(base + 1)}`);
    expect(html).toContain(`Version ${String(base + 1)} is deployed.`);
    expect(html).toContain("Lead &lt;carefully&gt;.");
  });

  it("saves the thread instructions and thread skills, as a draft when Deploy now is not ticked", async () => {
    const response = await post("/config/agents/threads", {
      parentId: String(base),
      text: "# New rules\n",
      message: "",
    });

    expect(response.headers.get("location")).toBe(`/config/versions/${String(base + 1)}`);
    const saved = newest();
    expect(saved.state).toBe("draft");
    expect(saved.message).toBe("Change the coding threads instructions");
    expect(saved.document.instructions.factory).toBe("# New rules\n");
    expect(saved.document.factory.threadSkills).toEqual([]);
    expect(saved.document.roles).toEqual(agentsConfig().roles);
  });

  it("refuses a skill the config does not have, and keeps what was typed", async () => {
    const response = await post("/config/agents/lead", {
      parentId: String(base),
      text: "Typed <text>.",
      skills: ["ghost"],
      message: "Typed message",
      deploy: "on",
    });
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("Not saved");
    expect(html).toContain("roles.lead.skills names unknown skill ghost");
    expect(html).toContain("Typed &lt;text&gt;.</textarea>");
    expect(html).toContain('value="Typed message"');
    expect(newest().id).toBe(base);
  });

  it("refuses a form built on an older version", async () => {
    const response = await post("/config/agents/lead", {
      parentId: "1",
      text: "Stale.",
      message: "m",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("The config changed since the page was loaded.");
    expect(newest().id).toBe(base);
  });

  it("answers 404 for an instruction set that does not exist", async () => {
    expect((await dashboard.get("/config/agents/nobody")).status).toBe(404);
    expect(
      (await post("/config/agents/nobody", { parentId: String(base), text: "x" })).status,
    ).toBe(404);
  });
});

describe("Skill editor", () => {
  it("shows SKILL.md, the other files as links, and who loads the skill", async () => {
    const { status, html } = await dashboard.get("/config/skills/triage");

    expect(status).toBe(200);
    expect(html).toContain(">triage</h1>");
    expect(html).toContain("Used by Planner and Coding threads.");
    expect(html).toContain('<a href="/config/skills/triage" aria-current="true">SKILL.md</a>');
    expect(html).toContain('<a href="/config/skills/triage?file=examples%2Fgood.md">');
    expect(html).toContain("# Triage\n</textarea>");
    expect(html).toContain('name="file" value="SKILL.md"');
    expect(html).toContain('action="/config/skills/triage/rename"');
    expect(html).toContain('action="/config/skills/triage/delete"');
    expect(html).toContain('action="/config/skills/triage/files"');
  });

  it("shows the file the link names", async () => {
    const { html } = await dashboard.get("/config/skills/triage?file=examples%2Fgood.md");

    expect(html).toContain("A good one.\n</textarea>");
    expect(html).toContain('name="file" value="examples/good.md"');
  });

  it("saves one file and leaves the others", async () => {
    const response = await post("/config/skills/triage", {
      parentId: String(base),
      file: "examples/good.md",
      text: "A better one.\r\n",
      message: "Better example",
      deploy: "on",
    });

    expect(response.headers.get("location")).toBe(
      `/config/skills/triage?file=examples%2Fgood.md&saved=${String(base + 1)}`,
    );
    const saved = newest();
    expect(saved.message).toBe("Better example");
    expect(saved.document.skills.triage).toEqual({
      ...agentsConfig().skills.triage,
      "examples/good.md": "A better one.\n",
    });
  });

  it("adds a file: the picker opens an empty editor for the new path, and saving creates it", async () => {
    const opened = await post("/config/skills/brief/files", { path: " examples/new.md " });
    expect(opened.headers.get("location")).toBe("/config/skills/brief?file=examples%2Fnew.md");
    expect(newest().id).toBe(base);

    const { html } = await dashboard.get("/config/skills/brief?file=examples%2Fnew.md");
    expect(html).toContain("examples/new.md (new)");
    expect(html).toContain('name="file" value="examples/new.md"');

    await post("/config/skills/brief", {
      parentId: String(base),
      file: "examples/new.md",
      text: "New.",
      message: "",
      deploy: "on",
    });
    const saved = newest();
    expect(saved.message).toBe("Add examples/new.md to the skill brief");
    expect(saved.document.skills.brief).toEqual({
      "SKILL.md": "# Brief\n",
      "examples/new.md": "New.",
    });
  });

  it("refuses a file path that leaves the skill folder", async () => {
    const opened = await post("/config/skills/brief/files", { path: "../escape.md" });
    expect(opened.status).toBe(400);
    expect(await opened.text()).toContain("must be a relative path");

    const saved = await post("/config/skills/brief", {
      parentId: String(base),
      file: "../escape.md",
      text: "x",
      message: "m",
    });
    expect(saved.status).toBe(400);
    expect(newest().id).toBe(base);
    expect((await dashboard.get("/config/skills/brief?file=..%2Fescape.md")).status).toBe(404);
  });

  it("refuses a file path that needs another file to be a folder, or the reverse", async () => {
    const inside = await post("/config/skills/brief/files", { path: "SKILL.md/notes.md" });
    expect(inside.status).toBe(400);
    expect(await inside.text()).toContain(
      "&quot;SKILL.md/notes.md&quot; is inside &quot;SKILL.md&quot;, which is a file, not a folder",
    );

    const above = await post("/config/skills/triage/files", { path: "examples" });
    expect(above.status).toBe(400);
    expect(await above.text()).toContain(
      "&quot;examples/good.md&quot; is inside &quot;examples&quot;, which is a file, not a folder",
    );

    const saved = await post("/config/skills/brief", {
      parentId: String(base),
      file: "SKILL.md/notes.md",
      text: "x",
      message: "m",
      deploy: "on",
    });
    expect(saved.status).toBe(400);
    expect(await saved.text()).toContain("which is a file, not a folder");
    expect(newest().id).toBe(base);
  });

  it("creates a skill with a SKILL.md that carries its name and description", async () => {
    const response = await post("/config/skills", {
      parentId: String(base),
      name: "write-brief",
      description: "Use when: a task needs a brief.",
      deploy: "on",
    });

    expect(response.headers.get("location")).toBe(
      `/config/skills/write-brief?saved=${String(base + 1)}`,
    );
    const saved = newest();
    expect(saved.message).toBe("Add the skill write-brief");
    expect(saved.document.skills["write-brief"]).toEqual({
      "SKILL.md":
        '---\nname: write-brief\ndescription: "Use when: a task needs a brief."\n---\n\n# write-brief\n',
    });
    expect((await dashboard.get("/config/agents")).html).toContain(
      "Use when: a task needs a brief.",
    );
  });

  it("refuses a new skill with a name that is taken or not a simple name", async () => {
    const taken = await post("/config/skills", {
      parentId: String(base),
      name: "triage",
      description: "Again.",
    });
    expect(taken.status).toBe(400);
    expect(await taken.text()).toContain("A skill named triage already exists.");

    const bad = await post("/config/skills", {
      parentId: String(base),
      name: "no spaces",
      description: "x",
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("has an invalid name");
    expect(newest().id).toBe(base);
  });

  it("renames a skill everywhere it is loaded, and in its SKILL.md", async () => {
    const response = await post("/config/skills/triage/rename", {
      parentId: String(base),
      name: "triage-issues",
      message: "",
      deploy: "on",
    });

    expect(response.headers.get("location")).toBe(
      `/config/skills/triage-issues?saved=${String(base + 1)}`,
    );
    const { document, message } = newest();
    expect(message).toBe("Rename the skill triage to triage-issues");
    expect(Object.keys(document.skills)).toEqual(["triage-issues", "brief"]);
    expect(document.skills["triage-issues"]?.["SKILL.md"]).toContain("name: triage-issues\n");
    expect(document.skills["triage-issues"]?.["examples/good.md"]).toBe("A good one.\n");
    expect(document.roles.planner.skills).toEqual(["triage-issues"]);
    expect(document.factory.threadSkills).toEqual(["triage-issues"]);
  });

  it("refuses to rename a skill onto another skill", async () => {
    const response = await post("/config/skills/triage/rename", {
      parentId: String(base),
      name: "brief",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("A skill named brief already exists.");
    expect(newest().id).toBe(base);
  });

  it("says in the delete confirm which instruction sets load the skill", async () => {
    expect((await dashboard.get("/config/skills/triage")).html).toContain(
      "Planner and Coding threads load it; deleting it unloads it from them.",
    );
    expect((await dashboard.get("/config/skills/brief")).html).toContain(
      "No instruction set loads it.",
    );
  });

  it("deletes a skill and unloads it from every instruction set that loads it", async () => {
    const response = await post("/config/skills/triage/delete", {
      parentId: String(base),
      message: "",
      deploy: "on",
    });

    expect(response.headers.get("location")).toBe(`/config/agents?saved=${String(base + 1)}`);
    const { document, message, state } = newest();
    expect(state).toBe("deployed");
    expect(message).toBe("Delete the skill triage");
    expect(Object.keys(document.skills)).toEqual(["brief"]);
    expect(document.roles.planner.skills).toEqual([]);
    expect(document.factory.threadSkills).toEqual([]);
    expect((await dashboard.get("/config/skills/triage")).status).toBe(404);
  });

  it("answers 404 for a skill that does not exist", async () => {
    expect((await dashboard.get("/config/skills/ghost")).status).toBe(404);
    for (const action of ["", "/rename", "/delete", "/files"]) {
      const response = await post(`/config/skills/ghost${action}`, { parentId: String(base) });
      expect(response.status).toBe(404);
    }
    expect((await dashboard.get("/config/skills/constructor")).status).toBe(404);
  });
});
