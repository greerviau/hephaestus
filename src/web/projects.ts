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
import type { Card } from "../factory/cards.js";
import { ACTIVE_STAGES, STORE_ERROR, read, type FactoryPages } from "./factory.js";
import {
  banner,
  card,
  empty,
  escapeHtml,
  externalLink,
  layout,
  pageHead,
  pill,
  postButton,
  table,
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
    help: "How often review findings go back to the implementer before the card escalates.",
  },
  {
    name: "openIssueCap",
    label: "Factory-filed issues waiting for work",
    help: "More issues the factory files than this wait for you to admit them.",
  },
];

const LIST_SETTINGS = new Set<SettingName>(["escalationPaths", "requiredChecks"]);
const NUMBER_SETTINGS = new Set<SettingName>(["maxReviewRounds", "openIssueCap"]);

const PRESET_TEXT: Record<PresetName, string> = {
  yolo: "Merges on green checks with no review. For throwaway repos.",
  standard:
    "Merges when checks pass and the other provider approved the head; workflow changes wait for you.",
  strict: "Every merge waits for you, after checks and a review.",
};

const NOTICES: Record<string, { kind: "info" | "err"; title: string; text: string }> = {
  added: {
    kind: "info",
    title: "Project added",
    text: "The new version is deployed; intake reads the repo's issues on its next poll.",
  },
  saved: {
    kind: "info",
    title: "Policy saved",
    text: "The new version is deployed; it applies to the next merge decision.",
  },
  removed: {
    kind: "info",
    title: "Project removed",
    text: "The new version is deployed; no new work starts on the repo.",
  },
  drafted: {
    kind: "info",
    title: "Saved as a draft",
    text: "Nothing changes until you approve the draft on Settings.",
  },
  "hermes-failed": {
    kind: "err",
    title: "The factory Hermes root was not updated",
    text: "The version is deployed to the workers, but applying it to the factory Hermes root failed. The service log has the error.",
  },
  "deploy-failed": {
    kind: "err",
    title: "Approved, but not deployed",
    text: "Deploying the version failed. Check that the config repo is named on the Workers page, then deploy it from Settings. The service log has the error.",
  },
};

/** The Projects page: the repos the factory works on, and each one's merge policy. */
export function projectsRoutes(factory: FactoryPages): Route[] {
  return [
    { method: "GET", path: /^\/projects$/, handle: (context) => listPage(context) },
    { method: "GET", path: /^\/projects\/edit$/, handle: (context) => editPage(context) },
    { method: "POST", path: /^\/projects\/save$/, handle: (context) => save(context) },
    { method: "POST", path: /^\/projects\/remove$/, handle: (context) => remove(context) },
  ];

  function current(): ConfigVersion | undefined {
    return factory.store.current();
  }

  async function listPage({ response, url }: RouteContext, problem?: Problem): Promise<void> {
    const version = read("config", () => current());
    if (!version.ok) {
      sendHtml(response, 200, projectsPage("Projects", STORE_ERROR));
      return;
    }
    const config = version.value?.document;
    const projects = Object.entries(config?.projects ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const active = read("cards", () =>
      factory.cards.list().filter((card) => ACTIVE_STAGES.includes(card.stage)),
    );
    const notice = NOTICES[url.searchParams.get("notice") ?? ""];
    const rows = projects.map(([repo, project]) => {
      const settings = resolvePolicy(project.policy);
      const working = active.ok ? active.value.filter((card) => card.repo === repo).length : 0;
      return [
        externalLink(`https://github.com/${repo}`, repo),
        `${pill(project.policy.preset === "strict" ? "you" : project.policy.preset === "yolo" ? "off" : "run", project.policy.preset)}${Object.keys(project.policy.overrides).length === 0 ? "" : `<span class="sub">${String(Object.keys(project.policy.overrides).length)} changed</span>`}`,
        escapeHtml(summary(settings)),
        String(working),
        `<div class="btn-row"><a class="btn btn-secondary btn-s" href="/projects/edit?repo=${encodeURIComponent(repo)}">Edit</a></div>`,
      ];
    });
    const repos = await suggestions(projects.map(([repo]) => repo));
    const body = `${notice === undefined ? "" : banner(notice.kind, notice.title, notice.text)}${pending()}<div class="grid">${card(
      {
        title: "Factory projects",
        meta: `<span class="meta">${String(projects.length)} ${projects.length === 1 ? "repo" : "repos"}</span>`,
        body:
          rows.length === 0
            ? empty("No project yet. Add a repo below, and the factory starts reading its issues.")
            : table(
                [
                  { label: "Repo", className: "title-cell" },
                  { label: "Policy" },
                  { label: "What merges on its own" },
                  { label: "Active cards", right: true },
                  { label: "Actions" },
                ],
                rows,
              ),
      },
    )}${card({
      title: "Add a project",
      body: policyForm({
        mode: "add",
        repo: problem?.repo ?? "",
        policy: problem?.policy ?? { preset: "standard", overrides: {} },
        parentId: version.value?.id,
        repos,
        errors: problem?.errors ?? [],
        deploy: problem?.deploy,
      }),
    })}${presetCard()}</div>`;
    sendHtml(response, problem === undefined ? 200 : 400, projectsPage("Projects", body));
  }

  function editPage(context: RouteContext, problem?: Problem): Promise<void> {
    renderEdit(context, problem);
    return Promise.resolve();
  }

  function renderEdit({ response, url }: RouteContext, problem?: Problem): void {
    const repo = problem?.repo ?? url.searchParams.get("repo") ?? "";
    const version = read("config", () => current());
    if (!version.ok) {
      sendHtml(response, 200, projectsPage("Projects", STORE_ERROR));
      return;
    }
    const project = version.value?.document.projects[repo];
    if (project === undefined) {
      sendHtml(
        response,
        404,
        projectsPage("Not found", empty(`${escapeHtml(repo)} is not a factory project.`)),
      );
      return;
    }
    const active = read("cards", () =>
      factory.cards
        .list()
        .filter((card) => card.repo === repo && ACTIVE_STAGES.includes(card.stage)),
    );
    const working = active.ok ? active.value.length : 0;
    const inFlight = active.ok ? active.value.filter(mergeInFlight).length : 0;
    const body = `${pageHead({
      title: repo,
      crumbs: `<a href="/projects">Projects</a><span aria-hidden="true">/</span><span>${escapeHtml(repo)}</span>`,
      lede: `Saving creates a config version built from version ${String(version.value?.id ?? "none")}, and approves and deploys it unless you keep it as a draft.`,
    })}${pending()}<div class="grid">${card({
      title: "Merge policy",
      body: policyForm({
        mode: "edit",
        repo,
        policy: problem?.policy ?? project.policy,
        parentId: version.value?.id,
        repos: [],
        errors: problem?.errors ?? [],
        deploy: problem?.deploy,
      }),
    })}${card({
      title: "Remove the project",
      body: `<p class="lede">The factory stops reading the repo's issues and starts no new work on it.${working === 0 ? "" : ` ${String(working)} active ${working === 1 ? "card waits" : "cards wait"} until you add the repo again or abandon them.`}${inFlight === 0 ? "" : ` ${String(inFlight)} ${inFlight === 1 ? "card is" : "cards are"} merging, validating, or reverting a merge; ${inFlight === 1 ? "it comes" : "they come"} to you under Needs you, since Hephaestus will not finish a merge for a removed project.`} The repo itself is not changed.</p>${postButton(
        "/projects/remove",
        "Remove and deploy",
        {
          fields: { repo, parentId: String(version.value?.id ?? ""), deploy: "on" },
          variant: "danger",
          small: false,
        },
      )}`,
    })}${presetCard()}</div>`;
    sendHtml(
      response,
      problem === undefined ? 200 : 400,
      layout(repo, body, { section: "/projects" }),
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
    document.projects[repo] = { policy: parsed.policy };
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

  /** Creates a version from `document` on `parentId`, then approves and deploys it unless the owner kept it as a draft. */
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
      published = await publishVersion({
        store: factory.store,
        deploy: factory.deploy,
        document,
        message,
        parentId,
        deployNow: form.get("deploy") === "on",
      });
    } catch (error) {
      if (error instanceof ConfigValidationError) return back(error.problems);
      if (error instanceof Error) return back([error.message]);
      throw error;
    }
    if (published.state === "draft") {
      redirect(response, `/settings/versions/${String(published.id)}`);
    } else if (published.state === "deploy-failed") {
      redirect(response, "/projects?notice=deploy-failed");
    } else if (published.state === "deployed" && published.hermesError !== undefined) {
      redirect(response, "/projects?notice=hermes-failed");
    } else {
      redirect(response, `/projects?notice=${notice}`);
    }
  }

  async function fields({ request, response }: RouteContext): Promise<URLSearchParams | undefined> {
    const body = await readBody(request, MAX_FORM_BYTES);
    if (body === undefined) {
      sendHtml(
        response,
        413,
        projectsPage("Too large", banner("err", "Too large", "The form is too large.")),
      );
      return undefined;
    }
    return new URLSearchParams(body);
  }

  /** A note when a version newer than the one edits build on is waiting, naming both. */
  function pending(): string {
    const latest = read("versions", () => factory.store.list()[0]);
    const base = read("config", () => current());
    if (!latest.ok || !base.ok || latest.value === undefined) return "";
    const { id, state } = latest.value;
    if ((state !== "draft" && state !== "approved") || id === base.value?.id) return "";
    const what = state === "draft" ? "is a draft" : "is approved but not deployed";
    return `<div class="banner info"><strong class="status s-neutral">Version ${String(id)} ${what}</strong><p>Changes here build on version ${String(base.value?.id ?? "none")}, not on version ${String(id)}. <a href="/settings/versions/${String(id)}">Open version ${String(id)}</a>.</p></div>`;
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

/** A card whose merge may still need validating or reverting under its project's policy. */
function mergeInFlight(card: Card): boolean {
  return (
    card.stage === "Merging" ||
    card.stage === "Validating" ||
    card.stage === "Reverting" ||
    card.reverting
  );
}

interface Problem {
  repo: string;
  policy: Policy;
  errors: string[];
  /** Whether the owner asked to approve and deploy, so an error page keeps that choice. */
  deploy?: boolean;
}

function projectsPage(title: string, body: string): string {
  return layout(
    title,
    `${pageHead({
      title: "Projects",
      lede: "The repos the factory works on. Each change becomes a config version, approved and deployed in the same step unless you keep it as a draft.",
    })}${body}`,
    { section: "/projects" },
  );
}

/** The settings that let a PR merge without the owner, in a few words. */
function summary(settings: PolicySettings): string {
  if (!settings.autoMerge || settings.ownerApprovesEveryMerge)
    return "Nothing; every merge waits for you";
  const parts = [
    settings.requireReview ? "reviewed PRs with passing checks" : "PRs with passing checks",
  ];
  if (settings.escalationPaths.length > 0)
    parts.push(`except ${settings.escalationPaths.join(", ")}`);
  return parts.join(", ");
}

function presetCard(): string {
  const rows = PRESET_NAMES.map((name) => [
    `<strong>${name}</strong>`,
    escapeHtml(PRESET_TEXT[name]),
  ]);
  return card({
    title: "Presets",
    body: table([{ label: "Preset" }, { label: "What it does", className: "title-cell" }], rows),
  });
}

function presetValue(preset: PresetName, name: SettingName): string {
  const value = PRESETS[preset][name];
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ");
  return String(value);
}

/** What each preset sets, since the page cannot update the hint when the preset changes. */
function presetHint(name: SettingName): string {
  const values = PRESET_NAMES.map((preset) => presetValue(preset, name));
  return values.every((value) => value === values[0])
    ? `Preset (${values[0] ?? ""})`
    : `Preset (${PRESET_NAMES.map((preset, index) => `${preset}: ${values[index] ?? ""}`).join("; ")})`;
}

function policyForm(options: {
  mode: "add" | "edit";
  repo: string;
  policy: Policy;
  parentId: number | undefined;
  repos: string[];
  errors: string[];
  deploy?: boolean | undefined;
}): string {
  const { policy } = options;
  const errors =
    options.errors.length === 0
      ? ""
      : `<div class="banner err" role="alert"><strong class="status s-crit">Not saved</strong><ul>${options.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>`;
  const repoField =
    options.mode === "add"
      ? `<div class="field"><label for="repo">Repo</label><input type="text" id="repo" name="repo" value="${escapeHtml(options.repo)}" placeholder="owner/name" required${options.repos.length === 0 ? "" : ' list="repos"'} autocomplete="off">${options.repos.length === 0 ? "" : `<datalist id="repos">${options.repos.map((repo) => `<option value="${escapeHtml(repo)}"></option>`).join("")}</datalist>`}<span class="meta">The gh account on this host must be able to read and merge in it.</span></div>`
      : `<input type="hidden" name="repo" value="${escapeHtml(options.repo)}">`;
  const preset = `<div class="field"><label for="preset">Preset</label><select id="preset" name="preset">${PRESET_NAMES.map((name) => `<option value="${name}"${name === policy.preset ? " selected" : ""}>${name}</option>`).join("")}</select><span class="meta">Each setting below follows the preset unless you change it.</span></div>`;
  const settings = SETTINGS.map((setting) => settingField(setting, policy)).join("");
  return `${errors}<form method="post" action="/projects/save" class="form-grid">
<input type="hidden" name="mode" value="${options.mode}">
<input type="hidden" name="parentId" value="${escapeHtml(String(options.parentId ?? ""))}">
${repoField}${preset}
<details class="more"${Object.keys(policy.overrides).length > 0 ? " open" : ""}><summary>Change settings from the preset</summary><div class="form-grid">${settings}</div></details>
<label class="check"><input type="checkbox" name="deploy"${options.deploy === false ? "" : " checked"}> Approve and deploy now</label>
<div class="btn-row"><button type="submit" class="btn-primary">${options.mode === "add" ? "Add the project" : "Save the policy"}</button></div>
</form>`;
}

function settingField(setting: (typeof SETTINGS)[number], policy: Policy): string {
  const { name } = setting;
  const override = policy.overrides[name];
  const id = `s-${name}`;
  const fromPreset = escapeHtml(presetHint(name));
  const help = `<span class="meta">${escapeHtml(setting.help)}</span>`;
  if (LIST_SETTINGS.has(name)) {
    const custom = Array.isArray(override);
    const shown = custom ? override.join("\n") : "";
    return `<div class="field"><label for="${id}-mode">${escapeHtml(setting.label)}</label><select id="${id}-mode" name="${name}.mode"><option value="preset"${custom ? "" : " selected"}>${fromPreset}</option><option value="custom"${custom ? " selected" : ""}>The list below (empty for none)</option></select><textarea id="${id}" name="${name}" rows="3" aria-label="${escapeHtml(setting.label)}">${escapeHtml(shown)}</textarea><input type="hidden" name="${name}.shown" value="${escapeHtml(shown)}">${help}</div>`;
  }
  if (NUMBER_SETTINGS.has(name)) {
    return `<div class="field"><label for="${id}">${escapeHtml(setting.label)}</label><input type="number" id="${id}" name="${name}" min="0" step="1" value="${override === undefined ? "" : escapeHtml(String(override))}" placeholder="${fromPreset}">${help}</div>`;
  }
  const value = override === undefined ? "" : override === true ? "on" : "off";
  return `<div class="field"><label for="${id}">${escapeHtml(setting.label)}</label><select id="${id}" name="${name}"><option value=""${value === "" ? " selected" : ""}>${fromPreset}</option><option value="on"${value === "on" ? " selected" : ""}>On</option><option value="off"${value === "off" ? " selected" : ""}>Off</option></select>${help}</div>`;
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
          errors.push(
            `${label}: you changed the list but left it on the preset. Choose "The list below" to use the list, or clear your change.`,
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
