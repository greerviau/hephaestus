import { skillDescription } from "../config/agents.js";
import { ConfigValidationError, type FactoryConfig } from "../config/document.js";
import {
  POLICY_SETTING_NAMES,
  PRESETS,
  PRESET_NAMES,
  resolvePolicy,
  type Policy,
  type PolicySettings,
  type PresetName,
} from "../config/policy.js";
import type { ConfigVersion } from "../config/store.js";
import type { Task } from "../factory/tasks.js";
import { ACTIVE_STAGES, STORE_ERROR, read, type FactoryPages } from "./factory.js";
import {
  callout,
  checkbox,
  dialog,
  dialogButton,
  empty,
  escapeHtml,
  externalLink,
  fold,
  input,
  layout,
  lookup,
  menu,
  pageHead,
  rowList,
  saveBar,
  section,
  selectControl,
  setting,
  statusText,
  type Crumb,
  type Shell,
} from "./html.js";
import { readBody, redirect, sendHtml, type Route, type RouteContext } from "./http.js";
import { publishVersion } from "./versions.js";

const MAX_FORM_BYTES = 64 * 1024;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

type SettingName = (typeof POLICY_SETTING_NAMES)[number];

/** How each policy setting reads on the form, in the order the form shows them. */
const SETTINGS: { name: SettingName; label: string; help: string }[] = [
  {
    name: "autoMerge",
    label: "Merge on its own",
    help: "Hephaestus merges a PR itself once every other condition holds.",
  },
  {
    name: "requireReview",
    label: "Require a review from the other provider",
    help: "An approving review of the exact head commit, from the provider that did not write it.",
  },
  {
    name: "ownerApprovesEveryMerge",
    label: "You approve every merge",
    help: "Every PR waits under Needs you before it merges.",
  },
  {
    name: "escalationPaths",
    label: "Paths that need you",
    help: "A PR that touches a matching path waits for you. One glob per line, such as .github/workflows/**.",
  },
  {
    name: "requiredChecks",
    label: "Checks that must pass",
    help: "Check names that must have passed on the PR's head, besides every check that ran. One per line.",
  },
  {
    name: "allowNoChecks",
    label: "Allow merging with no checks",
    help: "For a repo without CI. Without it, a PR with no checks waits for you.",
  },
  {
    name: "autoRevert",
    label: "Revert a merge whose checks fail",
    help: "Hephaestus opens, reviews, and merges a revert PR, then reopens the issue.",
  },
  {
    name: "maxReviewRounds",
    label: "Review rounds before the lead steps in",
    help: "How often review findings go back to the implementer before the task escalates.",
  },
  {
    name: "openIssueCap",
    label: "Factory-filed issues waiting for work",
    help: "More issues the factory files than this wait for you to admit them.",
  },
];

const LIST_SETTINGS = new Set<SettingName>(["escalationPaths", "requiredChecks"]);
const NUMBER_SETTINGS = new Set<SettingName>(["maxReviewRounds", "openIssueCap"]);

/** What each preset does, as the form describes it. */
const PRESET_TEXT: Record<PresetName, string> = {
  strict: "Every merge waits for you, after checks and a review.",
  standard:
    "Merges when checks pass and the other provider approved the head. Workflow changes wait for you.",
  yolo: "Merges on green checks with no review. For throwaway repos.",
};

/** The presets in the order the form offers them, each with what it does. */
const PRESET_CHOICES: readonly (readonly [PresetName, string])[] = PRESET_NAMES.map(
  (name) => [name, PRESET_TEXT[name]] as const,
);

const ADD_DIALOG = "add-project";

const NOTICES: Record<string, { kind: "info" | "err"; title: string; text: string }> = {
  added: {
    kind: "info",
    title: "Project added",
    text: "The new version is deploying; intake reads the repo's issues on its next poll.",
  },
  saved: {
    kind: "info",
    title: "Policy saved",
    text: "The new version is deploying; it applies to the next merge decision.",
  },
  skills: {
    kind: "info",
    title: "Skills saved",
    text: "The new version is deploying; the project's next factory threads load them.",
  },
  removed: {
    kind: "info",
    title: "Project removed",
    text: "The new version is deploying; no new work starts on the repo.",
  },
};

/** The Projects page: the repos the factory works on, and each one's merge policy. */
export function projectsRoutes(factory: FactoryPages): Route[] {
  return [
    { method: "GET", path: /^\/projects$/, handle: (context) => listPage(context) },
    {
      method: "GET",
      path: /^\/projects\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/,
      handle: (context) => editPage(context),
    },
    { method: "POST", path: /^\/projects\/save$/, handle: (context) => save(context) },
    { method: "POST", path: /^\/projects\/skills$/, handle: (context) => saveSkills(context) },
    { method: "POST", path: /^\/projects\/remove$/, handle: (context) => remove(context) },
  ];

  function current(): ConfigVersion | undefined {
    return factory.store.current();
  }

  async function listPage(
    { response, url, shell }: RouteContext,
    problem?: Problem,
  ): Promise<void> {
    const version = read("config", () => current());
    if (!version.ok) {
      sendHtml(response, 200, projectsPage(shell, "Projects", STORE_ERROR));
      return;
    }
    const config = version.value?.document;
    const projects = Object.entries(config?.projects ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const active = read("tasks", () =>
      factory.tasks.list().filter((task) => ACTIVE_STAGES.includes(task.stage)),
    );
    const notice = lookup(NOTICES, url.searchParams.get("notice"));
    const parentId = version.value?.id;
    const dialogs: string[] = [];
    const rows = projects.map(([repo, project], index) => {
      const mine = active.ok
        ? active.value.filter((task) => task.repo.toLowerCase() === repo.toLowerCase())
        : undefined;
      const changed = Object.keys(project.policy.overrides).length;
      const removeId = `remove-${String(index)}`;
      dialogs.push(removeDialog(removeId, repo, parentId, mine));
      return {
        title: repo,
        href: projectPath(repo),
        sub: `Merges on its own: ${escapeHtml(summary(resolvePolicy(project.policy)))}`,
        aside: `${mine === undefined ? "" : `<span class="muted">${String(mine.length)} active</span>`}${statusText(
          project.policy.preset === "strict"
            ? "you"
            : project.policy.preset === "yolo"
              ? "off"
              : "run",
          `${project.policy.preset}${changed === 0 ? "" : ` +${String(changed)}`}`,
        )}${externalLink(`https://github.com/${repo}`, "GitHub")}${menu(
          [{ label: "Remove project", dialog: removeId, danger: true }],
          `More actions for ${repo}`,
        )}`,
      };
    });
    const repos = await suggestions(projects.map(([repo]) => repo));
    const add = dialog({
      id: ADD_DIALOG,
      title: "Add project",
      body: `${input("repo", "Repo", {
        value: problem?.repo ?? "",
        placeholder: "owner/name",
        autocomplete: "off",
        autofocus: true,
        ...(repos.length === 0 ? {} : { list: "repos" }),
        hint: "As owner/name. The gh account on this host must be able to read and merge in it.",
      })}${
        repos.length === 0
          ? ""
          : `<datalist id="repos">${repos.map((repo) => `<option value="${escapeHtml(repo)}"></option>`).join("")}</datalist>`
      }${policyControls(problem?.policy ?? { preset: "standard", overrides: {} })}${deployChoice(problem?.deploy)}<span class="hint">${escapeHtml(savingHint(parentId))}</span>`,
      action: "/projects/save",
      fields: { mode: "add", parentId: String(parentId ?? "") },
      submit: "Add project",
    });
    const body = `${notice === undefined ? "" : callout(notice.kind, notice.title, escapeHtml(notice.text))}${notSaved(problem?.errors ?? [])}${pending()}${
      rows.length === 0
        ? empty("No project yet. Add a repo, and the factory starts reading its issues.")
        : rowList(rows)
    }${add}${dialogs.join("")}`;
    sendHtml(
      response,
      problem === undefined ? 200 : 400,
      projectsPage(
        shell,
        "Projects",
        body,
        dialogButton(ADD_DIALOG, "Add project", { variant: "primary" }),
      ),
    );
  }

  function editPage(context: RouteContext, problem?: Problem): Promise<void> {
    renderEdit(context, problem);
    return Promise.resolve();
  }

  function renderEdit({ response, params, shell }: RouteContext, problem?: Problem): void {
    const repo = problem?.repo ?? params[0] ?? "";
    const version = read("config", () => current());
    if (!version.ok) {
      sendHtml(response, 200, projectsPage(shell, "Projects", STORE_ERROR));
      return;
    }
    const project = version.value?.document.projects[repo];
    if (project === undefined) {
      sendHtml(
        response,
        404,
        layout(
          "No such project",
          `${pageHead({ title: "No such project" })}${empty(`${escapeHtml(repo)} is not a factory project.`)}`,
          { section: "/projects", shell, crumbs: [["Projects", "/projects"], ["Not found"]] },
        ),
      );
      return;
    }
    const active = read("tasks", () =>
      factory.tasks
        .list()
        .filter(
          (task) =>
            task.repo.toLowerCase() === repo.toLowerCase() && ACTIVE_STAGES.includes(task.stage),
        ),
    );
    const parentId = version.value?.id;
    const removeId = "remove-project";
    const body = `${pageHead({
      title: repo,
      lede: `${active.ok ? `${plural(active.value.length, "active task")}<span aria-hidden="true"> &middot; </span>` : ""}${externalLink(`https://github.com/${repo}`, "Open on GitHub")}`,
    })}${notSaved(problem?.errors ?? [])}${pending()}<form class="sec" method="post" action="/projects/save">
<input type="hidden" name="mode" value="edit">
<input type="hidden" name="parentId" value="${escapeHtml(String(parentId ?? ""))}">
<input type="hidden" name="repo" value="${escapeHtml(repo)}">
${policyControls(problem?.policy ?? project.policy)}${saveBar(
      `<button type="submit" class="primary">Save policy</button>${deployChoice(problem?.deploy)}<span class="hint">${escapeHtml(savingHint(parentId))}</span>`,
    )}</form>${section({
      title: "Skills",
      body: skillControls(
        version.value?.document,
        repo,
        parentId,
        problem?.skills ?? project.skills ?? [],
        problem?.deploy,
      ),
    })}${section({
      title: "Remove project",
      body: `<div class="row"><div class="main"><span class="subline">The factory stops reading the repo's issues and starts no new work on it. The repo itself is not changed.</span></div><div class="aside">${dialogButton(removeId, "Remove project", { variant: "danger" })}</div></div>`,
    })}${removeDialog(removeId, repo, parentId, active.ok ? active.value : undefined)}`;
    const crumbs: Crumb[] = [["Projects", "/projects"], [repo]];
    sendHtml(
      response,
      problem === undefined ? 200 : 400,
      layout(repo, body, { section: "/projects", shell, crumbs }),
    );
  }

  async function save(context: RouteContext): Promise<void> {
    const form = await fields(context);
    if (form === undefined) return;
    const mode = form.get("mode") === "edit" ? "edit" : "add";
    let repo = (form.get("repo") ?? "").trim();
    const parsed = parsePolicy(form);
    const back = (errors: string[], policy: Policy = parsed.policy): Promise<void> => {
      const problem = { repo, policy, errors, deploy: form.get("deploy") === "on" };
      return mode === "add" ? listPage(context, problem) : editPage(context, problem);
    };
    const base = current();
    const stale = (): Promise<void> => {
      // An edit form built on an older version comes back with the policy now in force, so a
      // second submit cannot overwrite a change made meanwhile.
      const now = current()?.document.projects[repo]?.policy;
      return back(
        [
          mode === "edit"
            ? "The config changed since the page was loaded. The form now shows the policy in force; make your change again."
            : "The config changed since the page was loaded. Check the projects and save again.",
        ],
        mode === "edit" && now !== undefined ? now : parsed.policy,
      );
    };
    if (base === undefined) return back(["There is no config version to build on yet."]);
    // Staleness first, so correcting another error cannot carry an old policy onto a newer version.
    if (String(base.id) !== (form.get("parentId") ?? "")) return stale();
    if (parsed.errors.length > 0) return back(parsed.errors);
    if (!REPO.test(repo)) return back([`Name the repo as owner/name, such as you/your-repo.`]);
    if (mode === "add" && factory.github !== undefined) {
      // GitHub's own spelling, so the same repo cannot be added twice under different casing.
      try {
        repo = await factory.github.canonicalName(repo);
      } catch {
        return back([
          `Hephaestus cannot read ${repo} with gh. Check the name, and that the gh account on this host can read it.`,
        ]);
      }
      // The lookup awaited; the version it checked must still be the one the change builds on.
      if (current()?.id !== base.id) return stale();
    }
    if (mode === "add") {
      // A repo added before keeps the spelling its tasks and issues were recorded under, so its
      // cap and issue records stay one.
      const known = [
        ...factory.tasks.list().map((task) => task.repo),
        ...factory.intake.issues().map((issue) => issue.repo),
      ].find((name) => name.toLowerCase() === repo.toLowerCase());
      if (known !== undefined) repo = known;
    }
    const document = structuredClone(base.document);
    const existing = Object.keys(document.projects).find(
      (name) => name.toLowerCase() === repo.toLowerCase(),
    );
    if (mode === "add" && existing !== undefined) {
      return back([`${existing} is already a factory project. Edit it from the list instead.`]);
    }
    if (mode === "edit" && document.projects[repo] === undefined) {
      return back([`${repo} is not a factory project any more.`]);
    }
    document.projects[repo] = { ...document.projects[repo], policy: parsed.policy };
    await publish(
      context,
      form,
      document,
      base.id,
      mode === "add" ? `Add the project ${repo}` : `Change the policy of ${repo}`,
      mode === "add" ? "added" : "saved",
      back,
    );
  }

  async function saveSkills(context: RouteContext): Promise<void> {
    const form = await fields(context);
    if (form === undefined) return;
    const repo = form.get("repo") ?? "";
    const skills = [...new Set(form.getAll("skills"))];
    const base = current();
    const back = (errors: string[], shown: string[] = skills): Promise<void> =>
      editPage(context, {
        repo,
        policy: current()?.document.projects[repo]?.policy ?? { preset: "standard", overrides: {} },
        skills: shown,
        errors,
        deploy: form.get("deploy") === "on",
      });
    if (base?.document.projects[repo] === undefined) {
      redirect(context.response, "/projects");
      return;
    }
    if (String(base.id) !== (form.get("parentId") ?? "")) {
      // The ticks come back as they are in force, so a second submit cannot undo a change made meanwhile.
      await back(
        [
          "The config changed since the page was loaded. The form now shows the skills in force; make your change again.",
        ],
        base.document.projects[repo].skills ?? [],
      );
      return;
    }
    const document = structuredClone(base.document);
    const project = document.projects[repo];
    if (project === undefined) return;
    // No skills leaves the project as a config without project skills has it.
    if (skills.length === 0) delete project.skills;
    else project.skills = skills;
    await publish(context, form, document, base.id, `Change the skills of ${repo}`, "skills", back);
  }

  async function remove(context: RouteContext): Promise<void> {
    const form = await fields(context);
    if (form === undefined) return;
    const repo = form.get("repo") ?? "";
    const base = current();
    const back = (errors: string[]): Promise<void> =>
      editPage(context, {
        repo,
        policy: base?.document.projects[repo]?.policy ?? { preset: "standard", overrides: {} },
        errors,
      });
    if (base?.document.projects[repo] === undefined) {
      redirect(context.response, "/projects");
      return;
    }
    if (String(base.id) !== (form.get("parentId") ?? "")) {
      await back([
        "The config changed since the page was loaded. Check the project and try again.",
      ]);
      return;
    }
    const document = structuredClone(base.document);
    document.projects = Object.fromEntries(
      Object.entries(document.projects).filter(([name]) => name !== repo),
    );
    await publish(context, form, document, base.id, `Remove the project ${repo}`, "removed", back);
  }

  /** Creates a version from `document` on `parentId`, then approves it and starts its deploy in the background unless the owner kept it as a draft. */
  async function publish(
    { response }: RouteContext,
    form: URLSearchParams,
    document: FactoryConfig,
    parentId: number,
    message: string,
    notice: string,
    back: (errors: string[]) => Promise<void>,
  ): Promise<void> {
    let published;
    try {
      published = publishVersion({
        store: factory.store,
        deploys: factory.deploys,
        document,
        message,
        parentId,
        deployNow: form.get("deploy") === "on",
      });
    } catch (error) {
      if (error instanceof Error) {
        await back(error instanceof ConfigValidationError ? error.problems : [error.message]);
        return;
      }
      throw error;
    }
    if (published.state === "draft") {
      redirect(response, `/config/versions/${String(published.id)}`);
    } else {
      redirect(response, `/projects?notice=${notice}`);
    }
  }

  async function fields(context: RouteContext): Promise<URLSearchParams | undefined> {
    const { request, response } = context;
    const body = await readBody(request, MAX_FORM_BYTES);
    if (body === undefined) {
      sendHtml(
        response,
        413,
        projectsPage(
          context.shell,
          "Too large",
          callout("err", "Too large", "The form is too large."),
        ),
      );
      return undefined;
    }
    return new URLSearchParams(body);
  }

  /**
   * A note when the projects shown are not the ones the factory works on: no version is deployed
   * yet, or a version newer than the one edits build on is waiting.
   */
  function pending(): string {
    const latest = read("versions", () => factory.store.list()[0]);
    const base = read("config", () => current());
    if (!latest.ok || !base.ok || latest.value === undefined) return "";
    if (base.value !== undefined && base.value.state !== "deployed") {
      const id = String(base.value.id);
      return callout(
        "err",
        "Not deployed yet",
        `Version ${id} is ${base.value.state}, and no version is deployed, so the factory works on none of these projects yet. Name the config repo at the top of <a href="/config">Config</a>, then deploy <a href="/config/versions/${id}">version ${id}</a> from its Versions tab.`,
      );
    }
    const { id, state } = latest.value;
    if ((state !== "draft" && state !== "approved") || id === base.value?.id) return "";
    const what = state === "draft" ? "is a draft" : "is approved but not deployed";
    return callout(
      "info",
      `Version ${String(id)} ${what}`,
      `Changes here build on version ${String(base.value?.id ?? "none")}, not on version ${String(id)}. <a href="/config/versions/${String(id)}">Open version ${String(id)}</a>.`,
    );
  }

  /** Repos the gh account can see, for the repo field's suggestions; none when gh cannot be read. */
  async function suggestions(taken: string[]): Promise<string[]> {
    if (factory.github === undefined) return [];
    try {
      return (await factory.github.repos()).filter((repo) => !taken.includes(repo));
    } catch {
      return [];
    }
  }
}

/** A task whose merge may still need validating or reverting under its project's policy. */
function mergeInFlight(task: Task): boolean {
  return (
    task.stage === "Merging" ||
    task.stage === "Validating" ||
    task.stage === "Reverting" ||
    task.reverting
  );
}

interface Problem {
  repo: string;
  policy: Policy;
  /** The skills the project's skills form held, when that form was refused. */
  skills?: string[];
  errors: string[];
  /** Whether the owner asked to approve and deploy, so an error page keeps that choice. */
  deploy?: boolean;
}

function projectsPage(
  shell: Shell | undefined,
  title: string,
  body: string,
  actions?: string,
): string {
  return layout(
    title,
    `${pageHead({
      title: "Projects",
      lede: "The repos the factory works on, each with its merge policy.",
      ...(actions === undefined ? {} : { actions }),
    })}${body}`,
    { section: "/projects", shell },
  );
}

/** The edit page of a project. A repo name holds only characters a path can carry as they are. */
function projectPath(repo: string): string {
  return `/projects/${repo}`;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function savingHint(parentId: number | undefined): string {
  return `Saving creates a config version built from version ${String(parentId ?? "none")}. Unticked, it stays a draft.`;
}

function deployChoice(deploy: boolean | undefined): string {
  return checkbox("deploy", "Deploy now", { value: "on", checked: deploy !== false });
}

/** Why the server refused a form, above the page it came from. */
function notSaved(errors: readonly string[]): string {
  return errors.length === 0
    ? ""
    : callout("err", "Not saved", errors.map((error) => escapeHtml(error)).join("<br>"));
}

/**
 * The dialog that removes a project. It says what happens to the tasks in
 * `active`, or leaves that out when the tasks could not be read.
 */
function removeDialog(
  id: string,
  repo: string,
  parentId: number | undefined,
  active: readonly Task[] | undefined,
): string {
  const working = active?.length ?? 0;
  const inFlight = active?.filter(mergeInFlight).length ?? 0;
  const tasks = `${working === 0 ? "" : ` ${String(working)} active ${working === 1 ? "task waits" : "tasks wait"} until you add the repo again or abandon ${working === 1 ? "it" : "them"}.`}${inFlight === 0 ? "" : ` ${String(inFlight)} ${inFlight === 1 ? "task is" : "tasks are"} merging, validating, or reverting a merge; ${inFlight === 1 ? "it finishes" : "they finish"} under the policy ${inFlight === 1 ? "it" : "they"} started with.`}`;
  return dialog({
    id,
    title: "Remove project",
    body: `<p>Remove <strong>${escapeHtml(repo)}</strong> from the factory?</p><p class="muted">The factory stops reading the repo's issues and starts no new work on it.${tasks} The repo itself is not changed.</p>`,
    action: "/projects/remove",
    fields: { repo, parentId: String(parentId ?? ""), deploy: "on" },
    submit: "Remove and deploy",
    danger: true,
  });
}

/**
 * The form that picks the skills a project's factory threads load. A skill every factory thread
 * loads is named rather than offered, unless the project loads it too, so saving keeps it.
 */
function skillControls(
  config: FactoryConfig | undefined,
  repo: string,
  parentId: number | undefined,
  loaded: readonly string[],
  deploy: boolean | undefined,
): string {
  const every = config?.factory.threadSkills ?? [];
  const names = Object.keys(config?.skills ?? {})
    .filter((name) => !every.includes(name) || loaded.includes(name))
    .sort((a, b) => a.localeCompare(b));
  const choices = names
    .map((name) => {
      const description = skillDescription(config?.skills[name] ?? {});
      return `<label class="check"><input type="checkbox" name="skills" value="${escapeHtml(name)}"${loaded.includes(name) ? " checked" : ""}><span><strong>${escapeHtml(name)}</strong>${description === undefined ? "" : ` <span class="muted">${escapeHtml(description)}</span>`}</span></label>`;
    })
    .join("");
  const shared =
    every.length === 0
      ? ""
      : ` Every factory thread loads ${escapeHtml(every.join(", "))} already.`;
  const intro = `<p class="hint">Factory threads for ${escapeHtml(repo)} load the skills ticked here, and threads for other projects do not.${shared} A worker gives a thread the skills of the version deployed when the thread starts.</p>`;
  if (names.length === 0) {
    return `${intro}<p class="hint">No other skills yet. Add one on <a href="/config/agents">Agents</a>.</p>`;
  }
  return `<form method="post" action="/projects/skills"><input type="hidden" name="parentId" value="${escapeHtml(String(parentId ?? ""))}"><input type="hidden" name="repo" value="${escapeHtml(repo)}">${intro}<fieldset><legend>Skills</legend>${choices}</fieldset>${saveBar(
    `<button type="submit" class="primary">Save skills</button>${deployChoice(deploy)}<span class="hint">${escapeHtml(savingHint(parentId))}</span>`,
  )}</form>`;
}

/** The settings that let a PR merge without the owner, in a few words. */
function summary(settings: PolicySettings): string {
  if (!settings.autoMerge || settings.ownerApprovesEveryMerge)
    return "nothing; every merge waits for you";
  const parts = [
    settings.requireReview ? "reviewed PRs with passing checks" : "PRs with passing checks",
  ];
  if (settings.escalationPaths.length > 0)
    parts.push(`except ${settings.escalationPaths.join(", ")}`);
  return parts.join(", ");
}

function presetValue(preset: PresetName, name: SettingName): string {
  const value = PRESETS[preset][name];
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ");
  return String(value);
}

/** What each preset sets, since the page cannot update the hint when the preset changes. */
function presetHint(name: SettingName): string {
  const values = PRESET_CHOICES.map(([preset]) => presetValue(preset, name));
  return values.every((value) => value === values[0])
    ? `Every preset: ${values[0] ?? ""}.`
    : `By preset: ${PRESET_CHOICES.map(([preset], index) => `${preset}: ${values[index] ?? ""}`).join("; ")}.`;
}

/** The preset choices, and each setting that can differ from the preset behind a fold. */
function policyControls(policy: Policy): string {
  const choices = PRESET_CHOICES.map(
    ([name, text]) =>
      `<label class="choice"><input type="radio" name="preset" value="${name}"${name === policy.preset ? " checked" : ""}><strong>${name}</strong><span class="hint">${escapeHtml(text)}</span></label>`,
  ).join("");
  const changed = Object.keys(policy.overrides).length;
  return `<fieldset><legend>Policy preset</legend><div class="choices">${choices}</div></fieldset>${fold(
    `Customize the preset${changed === 0 ? "" : ` (${String(changed)} changed)`}`,
    SETTINGS.map((entry) => settingRow(entry, policy)).join(""),
    changed > 0,
  )}`;
}

function settingRow(entry: (typeof SETTINGS)[number], policy: Policy): string {
  const { name } = entry;
  const override = policy.overrides[name];
  const id = `s-${name}`;
  const hint = `${escapeHtml(entry.help)} ${escapeHtml(presetHint(name))}`;
  if (LIST_SETTINGS.has(name)) {
    const custom = Array.isArray(override);
    const shown = custom ? override.join("\n") : "";
    // The list sits under the hint because no script is there to show it only for a custom list.
    return setting(
      `${id}-mode`,
      entry.label,
      `${hint}<textarea id="${id}" name="${name}" rows="2" aria-label="${escapeHtml(entry.label)}: custom list, one per line">${escapeHtml(shown)}</textarea><input type="hidden" name="${name}.shown" value="${escapeHtml(shown)}">`,
      selectControl(
        `${name}.mode`,
        [
          ["preset", "Preset"],
          ["custom", "Custom list"],
        ],
        custom ? "custom" : "preset",
        { id: `${id}-mode` },
      ),
    );
  }
  if (NUMBER_SETTINGS.has(name)) {
    return setting(
      id,
      entry.label,
      hint,
      `<input type="number" id="${id}" name="${name}" min="0" step="1" value="${override === undefined ? "" : escapeHtml(String(override))}" placeholder="Preset">`,
    );
  }
  return setting(
    id,
    entry.label,
    hint,
    selectControl(
      name,
      [
        ["", "Preset"],
        ["on", "On"],
        ["off", "Off"],
      ],
      override === undefined ? "" : override === true ? "on" : "off",
      { id },
    ),
  );
}

/** Reads the form's preset and overrides; a setting left on its preset is not an override. */
export function parsePolicy(form: URLSearchParams): { policy: Policy; errors: string[] } {
  const errors: string[] = [];
  const presetText = form.get("preset") ?? "standard";
  const preset = (PRESET_NAMES as readonly string[]).includes(presetText)
    ? (presetText as PresetName)
    : "standard";
  if (preset !== presetText) errors.push(`${presetText} is not a preset.`);
  const overrides: Partial<PolicySettings> = {};
  for (const { name, label } of SETTINGS) {
    if (LIST_SETTINGS.has(name)) {
      const text = form.get(name) ?? "";
      const items = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      // The selector decides. A list edited while the selector says preset is ambiguous, so the
      // owner is asked instead of either the edit or the selector being dropped.
      if (form.get(`${name}.mode`) !== "custom") {
        const shown = (form.get(`${name}.shown`) ?? "").replace(/\r\n/g, "\n").trim();
        if (text.replace(/\r\n/g, "\n").trim() !== shown) {
          // Nothing is saved; the form comes back with the typed list, so a resubmit keeps it.
          (overrides as Record<string, unknown>)[name] = items;
          errors.push(
            `${label}: you changed the list but left it on the preset. The form now uses your list; save again to keep it, or choose the preset.`,
          );
        }
        continue;
      }
      (overrides as Record<string, unknown>)[name] = items;
    } else if (NUMBER_SETTINGS.has(name)) {
      const text = (form.get(name) ?? "").trim();
      if (text === "") continue;
      const value = Number(text);
      if (!Number.isSafeInteger(value) || value < 0 || value > 1000) {
        errors.push(`${label}: give a whole number from 0 to 1000.`);
        continue;
      }
      (overrides as Record<string, unknown>)[name] = value;
    } else {
      const text = form.get(name) ?? "";
      if (text === "on" || text === "off") {
        (overrides as Record<string, unknown>)[name] = text === "on";
      } else if (text !== "") {
        errors.push(`${label}: choose the preset, on, or off.`);
      }
    }
  }
  return { policy: { preset, overrides }, errors };
}
