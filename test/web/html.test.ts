import { describe, expect, it } from "vitest";
import {
  buttonLink,
  callout,
  checkbox,
  dialog,
  dialogButton,
  empty,
  externalLink,
  field,
  fold,
  gridRowList,
  input,
  keyValues,
  layout,
  menu,
  pageHead,
  rowList,
  saveBar,
  section,
  segmented,
  select,
  setting,
  statusText,
  tabs,
  textarea,
  type Shell,
} from "../../src/web/html.js";

const SHELL: Shell = {
  paused: false,
  runningThreads: 2,
  needsYou: 3,
  proposals: 1,
  projects: ["octo/app", "octo/site"],
  project: "octo/site",
  back: "/work?tab=active",
};

/** The nav link for `href`, up to its closing tag. */
function navLink(html: string, href: string): string {
  return new RegExp(`<a href="${href}"[^>]*>.*?</a>`).exec(html)?.[0] ?? "";
}

describe("layout", () => {
  it("shows the commit the service runs, and how to update when origin/main is ahead", () => {
    const command = "node /opt/hephaestus/dist/cli.js update";
    const current = layout("Home", "<h1>Home</h1>", {
      shell: { ...SHELL, version: { commit: "abcdef1234567890", command } },
    });
    expect(current).toContain("Version <code>abcdef1</code>");
    expect(current).not.toContain("update");

    const behind = layout("Home", "<h1>Home</h1>", {
      shell: { ...SHELL, version: { commit: "abcdef1234567890", behind: 3, command } },
    });
    expect(behind).toContain("3 new commits on origin/main");
    expect(behind).toContain(`<code>${command}</code>`);
  });

  it("groups the pages under Factory and Setup, at the new paths", () => {
    const html = layout("Work", "<h1>Work</h1>", { section: "/work", shell: SHELL });

    const factory = html.indexOf(">Factory<");
    const setup = html.indexOf(">Setup<");
    expect(factory).toBeGreaterThan(-1);
    expect(setup).toBeGreaterThan(factory);
    const order = ["/", "/work", "/activity", "/analytics"].map((href) =>
      html.indexOf(`<a href="${href}"`, factory),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((at) => at > factory && at < setup)).toBe(true);
    for (const href of ["/projects", "/workers", "/chat", "/proposals", "/config"]) {
      expect(html.indexOf(`<a href="${href}"`, setup)).toBeGreaterThan(setup);
    }
    for (const old of ["/pipeline", "/improvement", "/messaging", "/model", "/environments"]) {
      expect(html).not.toContain(`href="${old}"`);
    }
    expect(html).not.toContain('href="/settings"');
  });

  it("marks only the current page", () => {
    const html = layout("Work", "", { section: "/work", shell: SHELL });

    expect(navLink(html, "/work")).toContain('aria-current="page"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("marks no page when the section is not given", () => {
    expect(layout("Not found", "", { shell: SHELL })).not.toContain("aria-current");
  });

  it("shows how many things need the owner on Home and how many proposals wait", () => {
    const html = layout("Work", "", { section: "/work", shell: SHELL });

    expect(navLink(html, "/")).toContain(
      '<span class="count">3<span class="sr-only"> need you</span></span>',
    );
    expect(navLink(html, "/proposals")).toContain(
      '<span class="count">1<span class="sr-only"> waiting</span></span>',
    );
  });

  it("shows no badge for a count of zero", () => {
    const html = layout("Work", "", { shell: { ...SHELL, needsYou: 0, proposals: 0 } });

    expect(html).not.toContain('class="count"');
  });

  it("offers the project picker with the current project selected, returning to this page", () => {
    const html = layout("Work", "", { section: "/work", shell: SHELL });

    const form = /<form class="scope".*?<\/form>/s.exec(html)?.[0] ?? "";
    expect(form).toContain('method="post" action="/project-filter"');
    expect(form).toContain('<input type="hidden" name="back" value="/work?tab=active">');
    expect(form).toContain('<label class="nav-label" for="shell-project">Project</label>');
    expect(form).toContain('<option value="">All projects</option>');
    expect(form).toContain('<option value="octo/app">app</option>');
    expect(form).toContain('<option value="octo/site" selected>site</option>');
    expect(form).toContain('<button type="submit">Apply</button>');
  });

  it("names the owner in the picker when two projects share a repo name", () => {
    const html = layout("Work", "", {
      shell: { ...SHELL, projects: ["octo/app", "acme/app"], project: undefined },
    });

    expect(html).toContain('<option value="octo/app">octo/app</option>');
    expect(html).toContain('<option value="acme/app">acme/app</option>');
  });

  it("leaves the picker out when the factory has no project", () => {
    const html = layout("Work", "", { shell: { ...SHELL, projects: [], project: undefined } });

    expect(html).not.toContain('class="scope"');
  });

  it("says the factory is running and asks before it pauses", () => {
    const html = layout("Work", "", { section: "/work", shell: SHELL });

    expect(html).toContain('<span class="st t-run"><span class="dot"></span>Running</span>');
    expect(html).toContain('<button type="button" popovertarget="pause-dialog">Pause</button>');
    const popover = /<div class="dlg" id="pause-dialog" popover.*?<\/div>\s*<\/form><\/div>/s.exec(
      html,
    )?.[0];
    expect(popover).toContain('<form method="post" action="/factory/pause">');
    expect(popover).toContain('<input type="hidden" name="back" value="/work?tab=active">');
    expect(popover).toContain("The 2 running threads finish.");
    expect(popover).toContain('<button type="submit" class="primary">Pause factory</button>');
    expect(html).not.toContain('action="/factory/resume"');
  });

  it("says the factory is paused and resumes it with one click", () => {
    const html = layout("Work", "", { shell: { ...SHELL, paused: true } });

    expect(html).toContain("Paused</span>");
    expect(html).toContain(
      '<form class="inline" method="post" action="/factory/resume"><input type="hidden" name="back" value="/work?tab=active"><button type="submit">Resume</button></form>',
    );
    expect(html).not.toContain("pause-dialog");
  });

  it("turns the pause control off when the pause state could not be read", () => {
    const html = layout("Work", "", { shell: { ...SHELL, paused: undefined } });

    expect(html).toContain('<button type="button" disabled>Pause</button>');
    expect(html).not.toContain('action="/factory/pause"');
    expect(html).not.toContain('action="/factory/resume"');
  });

  it("signs out from the sidebar", () => {
    const html = layout("Work", "", { shell: SHELL });

    expect(html).toContain(
      '<form method="post" action="/logout"><button type="submit" class="link">Sign out</button></form>',
    );
  });

  it("starts with a skip link to the main region", () => {
    const html = layout("Work", "", { shell: SHELL });

    const body = html.slice(html.indexOf("<body>"));
    expect(body.trimStart().slice("<body>".length).trimStart()).toMatch(
      /^<a class="skip" href="#main">Skip to content<\/a>/,
    );
    expect(html).toContain('<main id="main" tabindex="-1">');
  });

  it("opens the pages on a small screen from a menu button, without a script", () => {
    const html = layout("Work", "", { shell: SHELL });

    expect(html).toContain('<aside class="side" id="side" popover>');
    expect(html).toMatch(/<header class="top">.*<button type="button" popovertarget="side">/s);
    expect(html).toContain(
      'popovertarget="side" popovertargetaction="hide" aria-label="Close menu"',
    );
    expect(html).not.toContain("<script");
  });

  it("shows breadcrumbs above the page, the last one as text", () => {
    const html = layout("octo/app", "<h1>octo/app</h1>", {
      section: "/projects",
      shell: SHELL,
      crumbs: [["Projects", "/projects"], ["octo/<app>"]],
    });

    expect(html).toContain(
      '<nav class="crumbs" aria-label="Breadcrumb"><a href="/projects">Projects</a><span aria-hidden="true">/</span><span>octo/&lt;app&gt;</span></nav>',
    );
    expect(html.indexOf('class="crumbs"')).toBeLessThan(html.indexOf("<h1>octo/app</h1>"));
  });

  it("renders the pages and Sign out without a shell context, and nothing that needs one", () => {
    const html = layout("Not found", "<h1>Not found</h1>");

    expect(html).toContain('<a href="/config"');
    expect(html).toContain('action="/logout"');
    expect(html).not.toContain('class="scope"');
    expect(html).not.toContain(">Pause<");
    expect(html).not.toContain('class="count"');
  });

  it("returns the picker to the section when the page has no address of its own", () => {
    const html = layout("Config", "", { section: "/config", shell: { ...SHELL, back: undefined } });

    expect(html).toContain('<input type="hidden" name="back" value="/config">');
  });
});

describe("externalLink", () => {
  it("opens in a new tab, and says so to a screen reader", () => {
    expect(externalLink("https://github.com/octo/app/pull/5?a=1&b=2", "#5 <fix>")).toBe(
      '<a href="https://github.com/octo/app/pull/5?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">#5 &lt;fix&gt;<svg class="ic" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5"/></svg><span class="sr-only"> (opens in a new tab)</span></a>',
    );
  });
});

describe("dialog", () => {
  const html = dialog({
    id: "abandon-7",
    title: "Abandon <task>",
    body: '<p class="muted">Why</p>',
    action: "/work/7/abandon",
    fields: { back: "/work/7", version: "3" },
    submit: "Abandon",
    danger: true,
  });

  it("is a popover that holds a POST form with its hidden fields", () => {
    expect(html).toMatch(
      /^<div class="dlg" id="abandon-7" popover role="dialog" aria-labelledby="abandon-7-title"><form method="post" action="\/work\/7\/abandon">/,
    );
    expect(html).toContain('<input type="hidden" name="back" value="/work/7">');
    expect(html).toContain('<input type="hidden" name="version" value="3">');
    expect(html).toContain('<h2 id="abandon-7-title">Abandon &lt;task&gt;</h2>');
    expect(html).toContain('<div class="dlg-body"><p class="muted">Why</p></div>');
    expect(html).toContain('<button type="submit" class="danger solid">Abandon</button>');
  });

  it("closes from the corner button and from Cancel without a script", () => {
    expect(html).toContain(
      '<button type="button" class="icon-btn" popovertarget="abandon-7" popovertargetaction="hide" aria-label="Close">',
    );
    expect(html).toContain(
      '<button type="button" popovertarget="abandon-7" popovertargetaction="hide">Cancel</button>',
    );
  });

  it("is opened by a button that names it", () => {
    expect(dialogButton("abandon-7", "Abandon <it>", { variant: "danger" })).toBe(
      '<button type="button" class="danger" popovertarget="abandon-7">Abandon &lt;it&gt;</button>',
    );
    expect(dialogButton("request", "Request work")).toBe(
      '<button type="button" popovertarget="request">Request work</button>',
    );
  });
});

describe("menu", () => {
  it("is a details element holding links, POST buttons, and dialog openers", () => {
    const html = menu([
      { label: "Open <thread>", href: "/threads/w1/t1" },
      { label: "Dismiss", action: "/notifications/4/dismiss", fields: { back: "/" } },
      { label: "Abandon", dialog: "abandon-7", danger: true },
    ]);

    expect(html).toMatch(
      /^<details class="menu" name="menu"><summary aria-label="More actions"><svg class="ic".*?<\/svg><\/summary><div class="pop">/,
    );
    expect(html).toContain('<a href="/threads/w1/t1">Open &lt;thread&gt;</a>');
    expect(html).toContain(
      '<form method="post" action="/notifications/4/dismiss"><input type="hidden" name="back" value="/"><button type="submit">Dismiss</button></form>',
    );
    expect(html).toContain(
      '<button type="button" class="danger" popovertarget="abandon-7">Abandon</button>',
    );
  });

  it("is nothing when it has no items", () => {
    expect(menu([])).toBe("");
  });
});

describe("page building blocks", () => {
  it("heads a page with its title, lede, and actions", () => {
    expect(
      pageHead({ title: "A & B", lede: "<b>2</b> things", actions: "<button>Go</button>" }),
    ).toBe(
      '<div class="head"><div><h1 id="page-title">A &amp; B</h1><p class="sub"><b>2</b> things</p></div><div class="acts"><button>Go</button></div></div>',
    );
    expect(pageHead({ title: "Plain" })).toBe(
      '<div class="head"><div><h1 id="page-title">Plain</h1></div></div>',
    );
  });

  it("heads a section with its count and right-side content", () => {
    expect(
      section({
        title: "Needs <you>",
        count: 8,
        right: '<a href="/work">Open work</a>',
        body: "<p>x</p>",
      }),
    ).toBe(
      '<section class="sec"><div class="sec-head"><h2>Needs &lt;you&gt;<span class="n">8</span></h2><a href="/work">Open work</a></div><p>x</p></section>',
    );
    expect(section({ title: "Plain", body: "" })).toBe(
      '<section class="sec"><div class="sec-head"><h2>Plain</h2></div></section>',
    );
  });

  it("shows a status as text with a dot or an icon in its tone", () => {
    expect(statusText("run", "Implementing")).toBe(
      '<span class="st t-run"><span class="dot"></span>Implementing</span>',
    );
    for (const tone of ["you", "wait", "done", "off", "bad", "back"] as const) {
      expect(statusText(tone, "<x>")).toMatch(
        new RegExp(`^<span class="st t-${tone}"><svg class="ic".*</svg>&lt;x&gt;</span>$`),
      );
    }
  });

  it("boxes a callout, as an alert only when it is an error", () => {
    expect(callout("warn", "Name the <repo>", "Do <b>it</b>.", "<button>Save</button>")).toMatch(
      /^<div class="box warn"><div class="box-title"><svg.*?<\/svg><span>Name the &lt;repo&gt;<\/span><\/div><p>Do <b>it<\/b>\.<\/p><div class="acts"><button>Save<\/button><\/div><\/div>$/,
    );
    expect(callout("err", "Not saved")).toMatch(/^<div class="box err" role="alert">/);
    expect(callout("info", "Saved")).not.toContain("role=");
    expect(callout("info", "Saved")).not.toContain("<p>");
  });

  it("lists rows with a title, a line under it, a kind, and content at the right", () => {
    const html = rowList([
      {
        kind: "merge",
        title: "#7 <Fix>",
        href: "/work/7",
        sub: "octo/app",
        aside: "<button>Go</button>",
      },
      { title: "#8 Cache", href: "/work/8", wholeRow: true, aside: "<span>Done</span>" },
      { title: "No link" },
    ]);

    expect(html).toBe(
      '<ul class="rows">' +
        '<li class="row kinded"><span class="kind">merge</span><div class="main"><a class="title" href="/work/7">#7 &lt;Fix&gt;</a><span class="subline">octo/app</span></div><div class="aside"><button>Go</button></div></li>' +
        '<li><a class="row" href="/work/8"><div class="main"><span class="title">#8 Cache</span></div><div class="aside"><span>Done</span></div></a></li>' +
        '<li class="row"><div class="main"><span class="title">No link</span></div></li>' +
        "</ul>",
    );
  });

  it("lists grid rows under a header that screen readers skip", () => {
    const html = gridRowList(
      [{ label: "Task" }, { label: "Stage" }, { label: "Updated", right: true }],
      [{ href: "/work/7", cells: ["<b>#7</b>", "Reviewing", "12:00"] }, { cells: ["a", "b", "c"] }],
    );

    expect(html).toBe(
      '<div class="grid-head" aria-hidden="true"><span>Task</span><span>Stage</span><span class="r">Updated</span></div>' +
        '<ul class="rows">' +
        '<li><a class="grid-row" href="/work/7"><span><b>#7</b></span><span>Reviewing</span><span class="r">12:00</span></a></li>' +
        '<li class="grid-row"><span>a</span><span>b</span><span class="r">c</span></li>' +
        "</ul>",
    );
    expect(gridRowList([{ label: "A" }], [], "minmax(0, 1fr) 96px")).toContain(
      'style="grid-template-columns:minmax(0, 1fr) 96px"',
    );
  });

  it("links tabs and marks the current one", () => {
    expect(
      tabs([
        { href: "/work", label: "In <progress>", count: 4, current: true },
        { href: "/work?tab=finished", label: "Finished" },
      ]),
    ).toBe(
      '<nav class="tabs" aria-label="Views"><a href="/work" aria-current="page">In &lt;progress&gt;<span class="n">4</span></a><a href="/work?tab=finished">Finished</a></nav>',
    );
  });

  it("links a segmented control as a labelled group", () => {
    expect(
      segmented("View", [
        { href: "/work", label: "List", current: true },
        { href: "/work?view=board", label: "Board" },
      ]),
    ).toBe(
      '<div class="seg" role="group" aria-label="View"><a href="/work" aria-current="true">List</a><a href="/work?view=board">Board</a></div>',
    );
  });

  it("folds content under a summary", () => {
    expect(fold("The <brief>", "<pre>x</pre>")).toBe(
      '<details class="fold"><summary>The &lt;brief&gt;</summary><div class="fold-body"><pre>x</pre></div></details>',
    );
    expect(fold("Open", "", true)).toContain('<details class="fold" open>');
  });

  it("lists keys and values", () => {
    expect(keyValues([["Repo <x>", "<code>octo/app</code>"]])).toBe(
      '<dl class="kv"><dt>Repo &lt;x&gt;</dt><dd><code>octo/app</code></dd></dl>',
    );
  });

  it("wraps a save bar and an empty state", () => {
    expect(saveBar("<button>Save</button>")).toBe(
      '<div class="savebar"><button>Save</button></div>',
    );
    expect(empty("Nothing <b>yet</b>.")).toBe('<p class="empty">Nothing <b>yet</b>.</p>');
  });
});

describe("buttonLink", () => {
  it("is a link that looks like a button, for a form that is a page of its own", () => {
    expect(buttonLink("/work/new?back=%2Fwork&x=1", "Request <work>", { variant: "primary" })).toBe(
      '<a class="btn primary" href="/work/new?back=%2Fwork&amp;x=1">Request &lt;work&gt;</a>',
    );
    expect(buttonLink("/workers", "Open workers")).toBe(
      '<a class="btn" href="/workers">Open workers</a>',
    );
  });
});

describe("form fields", () => {
  it("lays a setting out as a label and hint beside its control", () => {
    expect(
      setting("threads", "Threads <all>", "Across <b>every</b> worker.", '<input id="threads">'),
    ).toBe(
      '<div class="setting"><div><label for="threads">Threads &lt;all&gt;</label><span class="hint">Across <b>every</b> worker.</span></div><input id="threads"></div>',
    );
  });

  it("labels a control and ties its hint and error to it", () => {
    expect(
      field("note", "Note <1>", '<textarea id="note"></textarea>', { hint: "A <b>hint</b>." }),
    ).toBe(
      '<div class="field"><label for="note">Note &lt;1&gt;</label><textarea id="note"></textarea><span class="hint" id="note-hint">A <b>hint</b>.</span></div>',
    );
    expect(field("note", "Note", "<i></i>", { error: "Enter a <note>." })).toMatch(
      /<p class="err" id="note-err" role="alert"><svg.*?<\/svg>Enter a &lt;note&gt;\.<\/p><\/div>$/,
    );
  });

  it("builds a text input that is required unless told otherwise", () => {
    expect(
      input("title", "What to do", { hint: "Becomes the title.", value: "a<b", maxlength: 256 }),
    ).toBe(
      '<div class="field"><label for="title">What to do</label><input type="text" id="title" name="title" value="a&lt;b" maxlength="256" required aria-describedby="title-hint"><span class="hint" id="title-hint">Becomes the title.</span></div>',
    );
    const optional = input("key", "API key", {
      type: "password",
      required: false,
      autocomplete: "off",
      error: "Wrong.",
      id: "k1",
    });
    expect(optional).toContain(
      '<input type="password" id="k1" name="key" autocomplete="off" aria-invalid="true" aria-describedby="k1-err">',
    );
    expect(optional).not.toContain("required");
  });

  it("builds a labelled select with the current value selected", () => {
    expect(
      select(
        "repo",
        "Project",
        [
          ["", "All <projects>"],
          ["octo/app", "app"],
        ],
        "octo/app",
      ),
    ).toBe(
      '<div class="field"><label for="repo">Project</label><select id="repo" name="repo"><option value="">All &lt;projects&gt;</option><option value="octo/app" selected>app</option></select></div>',
    );
    expect(select("repo", "Project", [["a", "a"]], "a", { disabled: true })).toContain(
      '<select id="repo" name="repo" disabled>',
    );
  });

  it("builds a labelled textarea", () => {
    expect(textarea("details", "Details", { rows: 4, value: "<x>", required: false })).toBe(
      '<div class="field"><label for="details">Details</label><textarea id="details" name="details" rows="4">&lt;x&gt;</textarea></div>',
    );
  });

  it("builds a checkbox with its label around it", () => {
    expect(checkbox("deploy", "Deploy <now>", { checked: true })).toBe(
      '<label class="check"><input type="checkbox" name="deploy" value="1" checked>Deploy &lt;now&gt;</label>',
    );
    expect(checkbox("alerts", "Alerts", { value: "on" })).toBe(
      '<label class="check"><input type="checkbox" name="alerts" value="on">Alerts</label>',
    );
  });
});
