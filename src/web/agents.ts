import {
  INSTRUCTION_SETS,
  instructionSet,
  isInstructionSet,
  skillDescription,
  skillFiles,
  skillUsers,
  withInstructionSet,
  withNewSkill,
  withSkillFile,
  withSkillRenamed,
  withoutSkill,
  type InstructionSetName,
} from "../config/agents.js";
import {
  ConfigValidationError,
  isSafeRelativePath,
  type FactoryConfig,
} from "../config/document.js";
import type { ConfigVersion } from "../config/store.js";
import {
  STALE,
  baseOf,
  configPage,
  configTab,
  deployChoice,
  formText,
  problems,
  readForm,
  saveVersion,
  savedNotice,
  versionSaveBar,
} from "./config-page.js";
import type { FactoryPages } from "./factory.js";
import {
  dialog,
  dialogButton,
  empty,
  escapeHtml,
  field,
  input,
  menu,
  pageHead,
  rowList,
  section,
  segmented,
  type Crumb,
} from "./html.js";
import { redirect, sendHtml, type Route, type RouteContext } from "./http.js";

const SETS: Record<InstructionSetName, { title: string; does: string }> = {
  planner: { title: "Planner", does: "Turns requests into GitHub issues on factory projects." },
  lead: {
    title: "Lead",
    does: "Starts work on admitted tasks with a brief, and handles escalations.",
  },
  improver: {
    title: "Improver",
    does: "Reads the day's factory threads each night and proposes config changes.",
  },
  threads: {
    title: "Coding threads",
    does: "Instructions every implement and review thread starts with.",
  },
};

const SEP = " &middot; ";
const AGENTS = "/config/agents";
const SKILL_NAME = "[A-Za-z0-9][A-Za-z0-9_.-]*";
const SKILL_FILE = "SKILL.md";
/** Room for the largest skill file a folder import takes, form-encoded, and the rest of the form. */
const MAX_TEXT_FORM_BYTES = 1024 * 1024;

function count(n: number, one: string): string {
  return `${String(n)} ${one}${n === 1 ? "" : "s"}`;
}

/** "A", "A and B", or "A, B, and C". */
function sentenceList(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1) ?? ""}`;
}

function skillHref(name: string, file: string = SKILL_FILE): string {
  const path = `/config/skills/${encodeURIComponent(name)}`;
  return file === SKILL_FILE ? path : `${path}?file=${encodeURIComponent(file)}`;
}

/** A tall plain-text editor. The newline after the tag keeps a text's own first newline, which a browser would drop. */
function editor(id: string, label: string, text: string): string {
  return field(
    id,
    label,
    `<textarea id="${id}" class="config" name="text" spellcheck="false">\n${escapeHtml(text)}</textarea>`,
  );
}

/** The message and deploy choice of a dialog that saves a version. `id` keeps its fields apart from the page's own. */
function versionChoice(id: string, base: ConfigVersion): string {
  return `${input("message", "What changed", {
    id: `${id}-message`,
    required: false,
    hint: "Shown in the version list. Left empty, Hephaestus writes one.",
  })}${deployChoice(undefined)}<p class="hint">Creates a config version built from version ${String(base.id)}.</p>`;
}

/** What a refused form comes back with. */
interface Refused {
  errors: string[];
  form?: URLSearchParams;
}

/** Runs an edit of the config document; an edit the document refuses gives its reasons. */
function edit(run: () => FactoryConfig): { config: FactoryConfig } | { errors: string[] } {
  try {
    return { config: run() };
  } catch (error) {
    if (error instanceof ConfigValidationError) return { errors: error.problems };
    throw error;
  }
}

/** The Agents tab: each agent's instructions and the skills, with an editor for each. */
export function agentsRoutes(factory: FactoryPages): Route[] {
  const { store } = factory;
  const skill = `^/config/skills/(${SKILL_NAME})`;
  return [
    {
      method: "GET",
      path: /^\/config\/agents$/,
      handle: (context) => {
        list(context);
      },
    },
    {
      method: "GET",
      path: /^\/config\/agents\/([a-z]+)$/,
      handle: (context) => {
        showSet(context);
      },
    },
    { method: "POST", path: /^\/config\/agents\/([a-z]+)$/, handle: (context) => saveSet(context) },
    { method: "POST", path: /^\/config\/skills$/, handle: (context) => createSkill(context) },
    {
      method: "GET",
      path: new RegExp(`${skill}$`),
      handle: (context) => {
        showSkill(context);
      },
    },
    { method: "POST", path: new RegExp(`${skill}$`), handle: (context) => saveFile(context) },
    { method: "POST", path: new RegExp(`${skill}/files$`), handle: (context) => addFile(context) },
    {
      method: "POST",
      path: new RegExp(`${skill}/(rename|delete)$`),
      handle: (context) => renameOrDelete(context),
    },
  ];

  function notFound(context: RouteContext, what: string): void {
    const title = `No such ${what}`;
    sendHtml(
      context.response,
      404,
      configPage(
        context.shell,
        title,
        `${pageHead({ title })}${empty(`<a href="${AGENTS}">Back to agents</a>`)}`,
        crumbs("Not found"),
      ),
    );
  }

  function crumbs(last: string): Crumb[] {
    return [["Config", "/config"], ["Agents", AGENTS], [last]];
  }

  function list(context: RouteContext, refused?: Refused): void {
    const current = store.current();
    if (current === undefined) {
      sendHtml(
        context.response,
        200,
        configTab(factory, context, "agents", empty("No config version yet.")),
      );
      return;
    }
    const config = current.document;
    const sets = INSTRUCTION_SETS.map((name) => {
      const loaded = instructionSet(config, name).skills.length;
      return {
        title: SETS[name].title,
        href: `${AGENTS}/${name}`,
        wholeRow: true,
        sub: SETS[name].does,
        ...(loaded === 0 ? {} : { aside: `<span class="muted">${count(loaded, "skill")}</span>` }),
      };
    });
    const names = Object.keys(config.skills);
    const skills = names.map((name) => {
      const files = skillFiles(config, name) ?? {};
      const users = skillUsers(config, name).map((user) => SETS[user].title);
      const description = skillDescription(files);
      return {
        title: name,
        href: skillHref(name),
        wholeRow: true,
        ...(description === undefined ? {} : { sub: escapeHtml(description) }),
        aside: `<span class="muted">${users.length === 0 ? "not used" : `used by ${users.join(", ")}`}${SEP}${count(Object.keys(files).length, "file")}</span>`,
      };
    });
    const typed = refused?.form;
    const newSkill = dialog({
      id: "new-skill",
      title: "New skill",
      body: `${input("name", "Name", {
        id: "new-skill-name",
        value: typed?.get("name") ?? "",
        hint: "Letters, digits, hyphens, dots, and underscores, such as write-brief.",
        autofocus: true,
      })}${input("description", "When an agent should use it", {
        id: "new-skill-description",
        value: typed?.get("description") ?? "",
        required: false,
        hint: "One sentence. Agents read this to decide whether to load the skill.",
      })}${versionChoice("new-skill", current)}`,
      action: "/config/skills",
      fields: { parentId: String(current.id) },
      submit: "Create skill",
    });
    sendHtml(
      context.response,
      refused === undefined ? 200 : 400,
      configTab(
        factory,
        context,
        "agents",
        `${savedNotice(context.url)}${problems("Not saved", refused?.errors)}${section({
          title: "Instructions",
          count: sets.length,
          body: rowList(sets),
        })}${section({
          title: "Skills",
          count: skills.length,
          right: dialogButton("new-skill", "New skill"),
          body:
            skills.length === 0
              ? empty(
                  "No skills yet. A skill is a folder of instructions an agent loads when a job calls for it.",
                )
              : rowList(skills),
        })}${newSkill}`,
      ),
    );
  }

  function showSet(context: RouteContext, refused?: Refused): void {
    const name = context.params[0] ?? "";
    const current = store.current();
    if (!isInstructionSet(name) || current === undefined) {
      notFound(context, "agent");
      return;
    }
    const { title, does } = SETS[name];
    const config = current.document;
    const saved = instructionSet(config, name);
    const typed = refused?.form;
    const loaded = typed === undefined ? saved.skills : typed.getAll("skills");
    const choices = Object.keys(config.skills)
      .map((skill) => {
        const description = skillDescription(skillFiles(config, skill) ?? {});
        return `<label class="check"><input type="checkbox" name="skills" value="${escapeHtml(skill)}"${loaded.includes(skill) ? " checked" : ""}><span><strong>${escapeHtml(skill)}</strong>${description === undefined ? "" : ` <span class="muted">${escapeHtml(description)}</span>`}</span></label>`;
      })
      .join("");
    sendHtml(
      context.response,
      refused === undefined ? 200 : 400,
      configPage(
        context.shell,
        `${title} instructions`,
        `${pageHead({ title: `${title} instructions`, lede: does })}${savedNotice(context.url)}${problems("Not saved", refused?.errors)}<form class="form wide" method="post" action="${AGENTS}/${name}"><input type="hidden" name="parentId" value="${String(current.id)}">${editor(
          "instructions",
          "Instructions",
          typed === undefined ? saved.text : formText(typed, "text"),
        )}<fieldset class="sec"><legend>Skills it loads</legend><div class="checks">${
          choices === ""
            ? `<p class="hint">No skills yet. Add one on <a href="${AGENTS}">Agents</a>.</p>`
            : choices
        }</div></fieldset>${input("message", "What changed", {
          value: typed?.get("message") ?? "",
          hint: "Shown in the version list.",
        })}${versionSaveBar("Save instructions", current, typed)}</form>`,
        crumbs(title),
      ),
    );
  }

  async function saveSet(context: RouteContext): Promise<void> {
    const name = context.params[0] ?? "";
    if (!isInstructionSet(name) || store.current() === undefined) {
      notFound(context, "agent");
      return;
    }
    const form = await readForm(context, MAX_TEXT_FORM_BYTES);
    if (form === undefined) return;
    const base = baseOf(factory, form);
    if (base === undefined) {
      showSet(context, { errors: [STALE], form });
      return;
    }
    const errors = await saveVersion(factory, context, {
      document: withInstructionSet(base.document, name, {
        text: formText(form, "text"),
        skills: form.getAll("skills"),
      }),
      message:
        form.get("message")?.trim() || `Change the ${SETS[name].title.toLowerCase()} instructions`,
      base,
      form,
      saved: `${AGENTS}/${name}`,
    });
    if (errors !== undefined) showSet(context, { errors, form });
  }

  /** The current version when it has the skill the route names, else undefined after a 404. */
  function withSkill(context: RouteContext): { current: ConfigVersion; name: string } | undefined {
    const name = context.params[0] ?? "";
    const current = store.current();
    if (current === undefined || skillFiles(current.document, name) === undefined) {
      notFound(context, "skill");
      return undefined;
    }
    return { current, name };
  }

  function showSkill(context: RouteContext, refused?: Refused, refusedFile?: string): void {
    const found = withSkill(context);
    if (found === undefined) return;
    const { current, name } = found;
    const config = current.document;
    const files = skillFiles(config, name) ?? {};
    const file = refusedFile ?? context.url.searchParams.get("file") ?? SKILL_FILE;
    const isNew = !Object.hasOwn(files, file);
    if (isNew && !isSafeRelativePath(file)) {
      notFound(context, "file");
      return;
    }
    const users = skillUsers(config, name).map((user) => SETS[user].title);
    const description = skillDescription(files);
    const typed = refused?.form;
    // Only the editor's own form carries the file's text; a refused dialog leaves the editor as saved.
    const editing = typed?.has("text") === true ? typed : undefined;
    const picker = segmented(
      "File",
      [...Object.keys(files), ...(isNew ? [file] : [])].map((path) => ({
        href: skillHref(name, path),
        label: path === file && isNew ? `${path} (new)` : path,
        current: path === file,
      })),
    );
    const here = `/config/skills/${encodeURIComponent(name)}`;
    const parent = { parentId: String(current.id) };
    const dialogs = [
      dialog({
        id: "add-file",
        title: "Add file",
        body: input("path", "File path", {
          id: "add-file-path",
          placeholder: "examples/good.md",
          hint: "A path inside the skill folder. The file is created when you save its text.",
          autofocus: true,
        }),
        action: `${here}/files`,
        submit: "Add file",
      }),
      dialog({
        id: "rename-skill",
        title: `Rename ${name}`,
        body: `${input("name", "New name", {
          id: "rename-skill-name",
          value: typed?.get("name") ?? name,
          hint: "Every instruction set that loads the skill loads it under the new name.",
          autofocus: true,
        })}${versionChoice("rename-skill", current)}`,
        action: `${here}/rename`,
        fields: parent,
        submit: "Rename skill",
      }),
      dialog({
        id: "delete-skill",
        title: `Delete ${name}`,
        body: `<p>Delete the skill ${escapeHtml(name)} and its ${count(Object.keys(files).length, "file")}? ${
          users.length === 0
            ? "No instruction set loads it."
            : `${escapeHtml(sentenceList(users))} ${users.length === 1 ? "loads" : "load"} it; deleting it unloads it from ${users.length === 1 ? escapeHtml(users[0] ?? "") : "them"}.`
        }</p>${versionChoice("delete-skill", current)}`,
        action: `${here}/delete`,
        fields: parent,
        submit: "Delete skill",
        danger: true,
      }),
    ].join("");
    sendHtml(
      context.response,
      refused === undefined ? 200 : 400,
      configPage(
        context.shell,
        name,
        `${pageHead({
          title: name,
          lede: `${description === undefined ? "" : `${escapeHtml(description)} `}${users.length === 0 ? "No instruction set loads it yet." : `Used by ${escapeHtml(sentenceList(users))}.`}`,
          actions: menu(
            [
              { label: "Rename", dialog: "rename-skill" },
              { label: "Delete skill", dialog: "delete-skill", danger: true },
            ],
            "Skill actions",
          ),
        })}${savedNotice(context.url)}${problems("Not saved", refused?.errors)}<div class="bar"><div class="files">${picker}</div>${dialogButton("add-file", "Add file")}</div><form class="form wide" method="post" action="${here}"><input type="hidden" name="parentId" value="${String(current.id)}"><input type="hidden" name="file" value="${escapeHtml(file)}">${editor(
          "skill-text",
          file,
          editing === undefined ? (isNew ? "" : (files[file] ?? "")) : formText(editing, "text"),
        )}${input("message", "What changed", {
          value: editing?.get("message") ?? "",
          hint: "Shown in the version list.",
        })}${versionSaveBar("Save skill", current, editing)}</form>${dialogs}`,
        crumbs(name),
      ),
    );
  }

  async function saveFile(context: RouteContext): Promise<void> {
    const found = withSkill(context);
    if (found === undefined) return;
    const { name } = found;
    const form = await readForm(context, MAX_TEXT_FORM_BYTES);
    if (form === undefined) return;
    const file = form.get("file") ?? SKILL_FILE;
    const base = baseOf(factory, form);
    const files = skillFiles(found.current.document, name) ?? {};
    // A path the page could not show is refused on the SKILL.md page, with the reason.
    const shown = Object.hasOwn(files, file) || isSafeRelativePath(file) ? file : SKILL_FILE;
    if (base === undefined) {
      showSkill(context, shown === file ? { errors: [STALE], form } : { errors: [STALE] }, shown);
      return;
    }
    const isNew = !Object.hasOwn(files, file);
    const edited = edit(() => withSkillFile(base.document, name, file, formText(form, "text")));
    const errors =
      "errors" in edited
        ? edited.errors
        : await saveVersion(factory, context, {
            document: edited.config,
            message:
              form.get("message")?.trim() ||
              (isNew ? `Add ${file} to the skill ${name}` : `Change ${file} of the skill ${name}`),
            base,
            form,
            saved: skillHref(name, file),
          });
    // Text sent for a path the page cannot show is not put in another file's editor.
    if (errors !== undefined)
      showSkill(context, shown === file ? { errors, form } : { errors }, shown);
  }

  async function addFile(context: RouteContext): Promise<void> {
    const found = withSkill(context);
    if (found === undefined) return;
    const form = await readForm(context, 4096);
    if (form === undefined) return;
    const path = (form.get("path") ?? "").trim();
    if (!isSafeRelativePath(path)) {
      showSkill(context, {
        errors: [
          `${JSON.stringify(path)} must be a relative path inside the skill folder, such as examples/good.md.`,
        ],
      });
      return;
    }
    // Nothing is saved yet: the editor opens on the new path, and saving its text creates the file.
    redirect(context.response, skillHref(found.name, path));
  }

  async function createSkill(context: RouteContext): Promise<void> {
    const form = await readForm(context);
    if (form === undefined) return;
    const base = baseOf(factory, form);
    if (base === undefined) {
      list(context, { errors: [STALE], form });
      return;
    }
    const name = (form.get("name") ?? "").trim();
    const edited = edit(() => withNewSkill(base.document, name, form.get("description") ?? ""));
    const errors =
      "errors" in edited
        ? edited.errors
        : await saveVersion(factory, context, {
            document: edited.config,
            message: form.get("message")?.trim() || `Add the skill ${name}`,
            base,
            form,
            saved: `/config/skills/${encodeURIComponent(name)}`,
          });
    if (errors !== undefined) list(context, { errors, form });
  }

  async function renameOrDelete(context: RouteContext): Promise<void> {
    const found = withSkill(context);
    if (found === undefined) return;
    const { name } = found;
    const form = await readForm(context);
    if (form === undefined) return;
    const base = baseOf(factory, form);
    if (base === undefined) {
      showSkill(context, { errors: [STALE], form });
      return;
    }
    const renaming = context.params[1] === "rename";
    const to = (form.get("name") ?? "").trim();
    const edited = edit(() =>
      renaming ? withSkillRenamed(base.document, name, to) : withoutSkill(base.document, name),
    );
    const errors =
      "errors" in edited
        ? edited.errors
        : await saveVersion(factory, context, {
            document: edited.config,
            message:
              form.get("message")?.trim() ||
              (renaming ? `Rename the skill ${name} to ${to}` : `Delete the skill ${name}`),
            base,
            form,
            saved: renaming ? `/config/skills/${encodeURIComponent(to)}` : AGENTS,
          });
    if (errors !== undefined) showSkill(context, { errors, form });
  }
}
