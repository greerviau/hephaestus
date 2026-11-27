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

  it("shows the factory thread instructions and the skills threads load", async () => {
    const { html } = await dashboard.get("/config/agents/threads");

    expect(html).toContain("Coding threads instructions</h1>");
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
