/**
 * The dashboard stylesheet. The theme follows the browser's light or dark
 * preference.
 */
export const STYLESHEET = `:root {
  color-scheme: light;
  --bg: #f9f9f7; --panel: #fcfcfb; --sunk: #f0efec;
  --ink: #1b1b1a; --ink-2: #52514e; --muted: #6b6a66;
  --line: rgba(27,27,26,0.13); --ctl: #8a8984;
  --accent: #1c5cab; --accent-ink: #ffffff; --wash: rgba(28,92,171,0.08);
  --good: #006300; --warn: #8a5a00; --crit: #b42e2e; --crit-ink: #ffffff;
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #12996a; --series-muted: #8a8984;
  --grid: #e6e5df; --axis: #c3c2b7;
  --add: #e3f1e3; --del: #f8e3e1;
  --shadow: 0 16px 48px rgba(0,0,0,0.18);
  --r: 4px;
  --mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #0c0d0d; --panel: #121313; --sunk: #181919;
    --ink: #e8e7e2; --ink-2: #bdbcb5; --muted: #94938c;
    --line: rgba(232,231,226,0.12); --ctl: #7d7c76;
    --accent: #6da7ec; --accent-ink: #0b0b0b; --wash: rgba(109,167,236,0.10);
    --good: #4fc16a; --warn: #e5b045; --crit: #f07a7a; --crit-ink: #0b0b0b;
    --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-muted: #8a8984;
    --grid: #232423; --axis: #3a3b39;
    --add: #12301a; --del: #3a1717;
    --shadow: 0 16px 48px rgba(0,0,0,0.6);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--ink); font: 14px/1.55 var(--mono); font-variant-numeric: tabular-nums; }
a { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; }
.brand, .nav-group a, .tabs a, .seg a, a.row, a.grid-row, a.tile, a.btn, .crumbs a, .sec-head a, a.title, .more-link, details.menu .pop a { text-decoration: none; }
.crumbs a:hover, .sec-head a:hover, .more-link:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
[hidden] { display: none !important; }
h1 { font-size: 24px; line-height: 1.25; font-weight: 700; margin: 0; overflow-wrap: anywhere; }
h2 { font-size: 18px; line-height: 1.3; font-weight: 700; margin: 0; }
h3 { font-size: 14px; line-height: 1.4; font-weight: 700; margin: 0; }
p { margin: 0; max-width: 72ch; }
code, pre { font-family: var(--mono); font-size: 13px; }
code { overflow-wrap: anywhere; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.skip { position: absolute; left: 16px; top: -64px; background: var(--panel); padding: 8px 16px; z-index: 50; }
.skip:focus { top: 8px; }
.muted { color: var(--muted); }
.ic { width: 16px; height: 16px; flex: none; }
/* The gap is a margin, so the link's underline stops at its last letter. */
a[target="_blank"] > .ic { margin-left: 4px; vertical-align: -2px; }

/* shell */
.shell { display: grid; grid-template-columns: 224px minmax(0, 1fr); }
/* The sidebar is a popover so the Menu button can open it on a small screen. These rules undo the browser's popover box and keep it in place on a wide one. */
aside.side { position: sticky; inset: 0 auto auto auto; width: auto; height: auto; max-height: 100vh; margin: 0; border: 0; padding: 24px 16px; overflow-y: auto; color: inherit; background: transparent; display: flex; flex-direction: column; gap: 24px; align-self: start; }
aside.side::backdrop { display: none; }
.side-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.side-close { display: none; }
.brand { display: flex; align-items: center; gap: 8px; color: var(--ink); font-weight: 700; font-size: 14px; padding: 0 8px; }
.brand img { width: 24px; height: 24px; border-radius: 4px; }
.side-nav { display: grid; gap: 24px; }
.nav-group { display: grid; gap: 2px; }
.scope { display: grid; gap: 4px; padding: 0 8px; margin: 0; }
.scope .nav-label { padding: 0; }
.scope select { width: 100%; min-width: 0; }
.nav-label { color: var(--muted); font-size: 12px; padding: 0 8px 4px; }
.nav-group a { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-height: 32px; padding: 4px 8px; border-radius: var(--r); color: var(--ink-2); }
.nav-group a:hover { background: var(--sunk); color: var(--ink); }
.nav-group a[aria-current="page"] { background: var(--wash); color: var(--ink); font-weight: 500; }
.nav-group a[aria-current="page"]::before { content: ">"; color: var(--accent); margin-right: -2px; }
.nav-group a span.lbl { flex: 1; }
.count { font-size: 12px; color: var(--warn); border: 1px solid currentColor; border-radius: 999px; min-width: 22px; padding: 0 6px; text-align: center; line-height: 18px; }
.side-foot { margin-top: 24px; display: grid; gap: 12px; border-top: 1px solid var(--line); padding-top: 16px; }
.side-foot .row-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 8px; }
.side-foot form { margin: 0; }
/* The update hint is a bare paragraph, not a row-line, so it needs the same inset to line up with the lines around it. */
.side-foot .side-update { padding: 0 8px; }
.top { display: none; }
.shell > main { min-width: 0; border-left: 1px solid var(--line); min-height: 100vh; }
main:focus { outline: none; }
.page { max-width: 1040px; padding: 32px 48px 64px; }
.crumbs { font-size: 13px; color: var(--muted); margin-bottom: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
.head { display: flex; flex-wrap: wrap; gap: 16px 24px; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
.head > div:first-child { min-width: 0; flex: 1 1 320px; }
.head .sub { color: var(--ink-2); margin-top: 8px; }
.head .acts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.sec { margin-bottom: 48px; }
.sec-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
.sec-head .n { color: var(--muted); font-weight: 400; margin-left: 8px; font-size: 14px; }
.sec-head a, .sec-head .muted { font-size: 13px; }
.cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 48px; }
.cols .sec { margin-bottom: 0; }
/* The save bar ends the form, so it sits closer to the section it saves. */
.sec:has(+ .savebar) { margin-bottom: 16px; }
.sec + .savebar { padding-left: 8px; }
.cols + .sec, .cols { margin-bottom: 48px; }

/* buttons */
button, .btn { font: inherit; font-size: 13px; font-weight: 500; min-height: 32px; padding: 4px 12px; border-radius: var(--r); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px; white-space: nowrap; background: transparent; color: var(--ink); border: 1px solid var(--ctl); transition: opacity 120ms ease-out; }
button:hover, .btn:hover { border-color: var(--ink); text-decoration: none; }
button:active, .btn:active { opacity: 0.75; }
.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.primary:hover { border-color: var(--accent); opacity: 0.9; }
.danger { color: var(--crit); border-color: var(--crit); }
.danger.solid { background: var(--crit); color: var(--crit-ink); }
.link { border: 0; padding: 0 2px; min-height: 24px; color: var(--accent); font-weight: 400; }
.link:hover { text-decoration: underline; text-underline-offset: 3px; }
button[disabled] { opacity: 0.5; cursor: not-allowed; }
/* A pressed button whose form is on its way to the server: it stays readable and turns a ring beside its label. */
button[aria-disabled="true"] { cursor: progress; }
button.pending, button.pending[disabled] { opacity: 0.8; cursor: progress; }
button.pending::after { content: ""; display: inline-block; width: 0.8em; height: 0.8em; margin-left: 8px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; vertical-align: -0.1em; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.icon-btn { min-width: 32px; padding: 4px; }
form.inline { display: inline-flex; margin: 0; }

/* status */
/* The text gives the status its baseline, so it lines up with text beside it; the mark is centred on that line. */
.st { display: inline-flex; align-items: baseline; gap: 6px; font-size: 13px; white-space: nowrap; }
.st .ic, .st .dot { align-self: center; }
.st .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; margin: 0 4px; }
.t-run { color: var(--accent); } .t-you { color: var(--warn); } .t-wait { color: var(--ink-2); }
.t-done { color: var(--good); } .t-off { color: var(--muted); } .t-bad { color: var(--crit); }
.t-back { color: var(--warn); }
.t-run .dot { animation: pulse 1.6s ease-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 60% { opacity: 0.35; transform: scale(0.6); } }

/* rows */
ul.rows { list-style: none; margin: 0; padding: 0; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 16px; align-items: center; padding: 12px 8px; border-bottom: 1px solid var(--line); }
.row.kinded { grid-template-columns: 72px minmax(0, 1fr) auto; }
.row .kind { color: var(--muted); font-size: 13px; align-self: start; padding-top: 1px; }
.row .main, .grid-row .main { min-width: 0; }
.row .title, .grid-row .title { display: block; color: var(--ink); font-weight: 500; overflow-wrap: anywhere; }
.row .title a { color: inherit; text-decoration: none; }
a.title:hover, .row a.title:hover, .row .title a:hover { color: var(--accent); }
.row .subline, .grid-row .subline { display: block; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.row .aside { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: flex-end; }
/* A selector sizes to its longest option, so no level or model name is cut off, and shrinks to the row on a narrow screen. */
.row.job .aside select { width: auto; max-width: 100%; }
.row.job .aside select.model { min-width: 200px; }
.row.job .aside input { width: 200px; }
.grid-head, .grid-row { display: grid; grid-template-columns: minmax(0, 1fr) 144px 64px 72px; gap: 4px 16px; align-items: center; padding: 12px 8px; border-bottom: 1px solid var(--line); }
.grid-head { color: var(--muted); font-size: 13px; padding-top: 8px; padding-bottom: 8px; }
a.grid-row:hover, a.row:hover, details.xrow > summary:hover { background: var(--sunk); text-decoration: none; }
a.grid-row, a.row { color: inherit; }
.grid-row .r, .grid-head .r { text-align: right; }
.more-link { display: inline-block; padding: 12px 8px 0; font-size: 13px; }
.empty { color: var(--ink-2); padding: 24px 8px; }
.calm { display: flex; gap: 8px; align-items: center; color: var(--ink-2); padding: 24px 8px; }
.skel { display: grid; gap: 12px; padding: 24px 8px; }
.skel span { display: block; height: 12px; border-radius: 2px; background: var(--sunk); }
.skel span:nth-child(2) { width: 82%; } .skel span:nth-child(3) { width: 64%; }

/* tabs and filters */
.tabs { display: flex; gap: 24px; border-bottom: 1px solid var(--line); margin-bottom: 16px; overflow-x: auto; }
.tabs a { padding: 8px 0; color: var(--ink-2); border-bottom: 2px solid transparent; white-space: nowrap; margin-bottom: -1px; }
.tabs a:hover { color: var(--ink); }
.tabs a:focus-visible { outline-offset: -2px; }
.tabs a[aria-current] { color: var(--ink); border-bottom-color: var(--accent); font-weight: 500; }
.tabs .n { color: var(--muted); margin-left: 6px; font-weight: 400; }
.bar { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.bar .grp { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; min-width: 0; max-width: 100%; }
.seg { display: inline-flex; flex-wrap: wrap; max-width: 100%; border: 1px solid var(--ctl); border-radius: var(--r); overflow: hidden; }
.seg a { padding: 4px 12px; min-height: 30px; display: inline-flex; align-items: center; color: var(--ink-2); font-size: 13px; }
.seg a:hover { color: var(--ink); }
.seg a:focus-visible { outline-offset: -2px; }
.seg a[aria-current] { background: var(--wash); color: var(--ink); font-weight: 500; }
.seg a + a { border-left: 1px solid var(--ctl); }

/* forms */
select, input[type=text], input[type=number], input[type=password], input[type=url], input[type=search], input[type=email], input[type=file], textarea { font: inherit; font-size: 14px; color: var(--ink); background: var(--panel); border: 1px solid var(--ctl); border-radius: var(--r); min-height: 32px; padding: 4px 8px; max-width: 100%; }
input[type=text], input[type=password], input[type=url], input[type=search], input[type=email], textarea { width: 100%; }
input[type=number] { width: 96px; }
textarea { line-height: 1.5; padding: 8px; resize: vertical; }
.field { display: grid; gap: 4px; min-width: 0; }
.field > label { font-size: 13px; color: var(--ink-2); }
.hint { font-size: 13px; color: var(--muted); }
.err { font-size: 13px; color: var(--crit); display: flex; gap: 6px; align-items: center; }
.form { display: grid; gap: 16px; max-width: 560px; margin: 0; }
.check { display: flex; gap: 8px; align-items: center; font-size: 13px; min-height: 24px; }
.check input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
.inline-field { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-2); min-width: 0; max-width: 100%; }
.inline-field select { min-width: 0; flex: 1 1 auto; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
legend { padding: 0; font-weight: 700; margin-bottom: 12px; }
/* A fieldset that is a page section gets the section heading's look. */
fieldset.sec > legend { width: 100%; font-size: 18px; line-height: 1.3; padding-bottom: 8px; border-bottom: 1px solid var(--line); margin-bottom: 0; }
/* A section body that is not a list of rows: inset like rows, with room under the heading. */
.sec-body { display: grid; gap: 16px; padding: 16px 8px 0; margin: 0; }
.sec-body .savebar { padding-top: 0; }
.sec-body details.fold { margin-top: 0; }
.sec > details.fold { padding: 0 8px; }
.setting { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 24px; align-items: center; padding: 12px 8px; border-bottom: 1px solid var(--line); }
.setting label { font-weight: 500; }
.setting .hint { display: block; }
.choices { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.choices.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.access { display: grid; gap: 12px; }
.access:has(input[name=read_all][value="1"]:checked) .access-list { display: none; }
label.choice { display: grid; grid-template-columns: 16px 1fr; gap: 4px 8px; padding: 12px; border: 1px solid var(--line); border-radius: var(--r); cursor: pointer; align-content: start; }
label.choice:has(input:checked) { border-color: var(--accent); background: var(--wash); }
label.choice input { margin: 3px 0 0; accent-color: var(--accent); }
label.choice strong { font-weight: 700; }
label.choice .hint { grid-column: 2; }
.savebar { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: center; padding-top: 16px; }
.form.wide { max-width: none; }
input.w-220, textarea.w-220 { width: 220px; }
.schedule { display: grid; gap: 8px; justify-items: start; }
.schedule details.fold { margin-top: 0; }
.schedule .fold-body { display: grid; gap: 4px; max-width: 280px; }
.row.job .aside input.w-144 { width: 144px; }
.note { font-size: 13px; color: var(--ink-2); padding: 8px; margin: 12px 0 0; }
.repo-row { margin-bottom: 24px; }
.repo-form { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: end; margin: 0; flex: 1 1 auto; }
.repo-form .field { flex: 1 1 240px; max-width: 400px; }
.in-use { margin-bottom: 32px; }
.step { padding: 16px 8px 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
.step .field { grid-template-columns: minmax(0, 1fr); }
.step select { width: 100%; }
.checks { display: grid; gap: 8px; padding: 0 8px; }
.checks strong { font-weight: 500; }
.files { min-width: 0; max-width: 100%; }
.files .seg a { border-left: 1px solid var(--ctl); border-top: 1px solid var(--ctl); margin: -1px 0 0 -1px; overflow-wrap: anywhere; }
ol.steps { margin: 0; padding: 12px 0 0 24px; display: grid; gap: 8px; color: var(--ink-2); }

/* callouts */
.box { border: 1px solid var(--line); border-radius: var(--r); padding: 16px; margin-bottom: 24px; display: grid; gap: 8px; }
.box.warn { border-color: var(--warn); } .box.err { border-color: var(--crit); } .box.info { border-color: var(--accent); }
.box > * { min-width: 0; }
.box p { overflow-wrap: anywhere; }
.box .box-title { display: flex; gap: 8px; align-items: center; font-weight: 700; }
.box.warn .box-title .ic { color: var(--warn); } .box.err .box-title .ic { color: var(--crit); } .box.info .box-title .ic { color: var(--accent); }
.box .acts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.box ul { margin: 0; padding-left: 20px; }

/* details */
details.fold { margin-top: 16px; }
details.fold > summary, details.xrow > summary { cursor: pointer; list-style: none; }
details.fold > summary::-webkit-details-marker, details.xrow > summary::-webkit-details-marker, details.menu > summary::-webkit-details-marker { display: none; }
details.fold > summary { color: var(--ink-2); font-size: 13px; min-height: 24px; display: inline-flex; align-items: center; }
details.fold > summary::before { content: "+"; color: var(--accent); width: 16px; display: inline-block; }
details.fold[open] > summary::before { content: "-"; }
details.fold > .fold-body { padding-top: 12px; }
details.xrow { border-bottom: 1px solid var(--line); }
details.xrow > summary { display: grid; grid-template-columns: minmax(0, 1fr) 160px 200px 16px; gap: 4px 16px; align-items: center; padding: 12px 8px; }
details.xrow > summary::after { content: "+"; color: var(--accent); }
details.xrow[open] > summary::after { content: "-"; }
details.xrow .xbody { padding: 8px 8px 24px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
details.xrow > summary .title { color: var(--ink); font-weight: 500; overflow-wrap: anywhere; justify-self: start; }
details.xrow .xbody .box { margin-bottom: 0; }
details.xrow .xbody .savebar { padding-top: 0; gap: 8px; }
dl.kv .note { display: block; font-size: 13px; }
details.menu { position: relative; display: inline-block; }
details.menu > summary { list-style: none; cursor: pointer; min-width: 32px; min-height: 32px; border: 1px solid var(--ctl); border-radius: var(--r); display: inline-flex; align-items: center; justify-content: center; }
details.menu > summary:hover, details.menu[open] > summary { border-color: var(--ink); }
details.menu .pop { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 176px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--shadow); padding: 4px; display: grid; }
details.menu .pop form { display: grid; margin: 0; }
details.menu .pop button, details.menu .pop a { border: 0; border-radius: var(--r); display: flex; align-items: center; justify-content: flex-start; min-height: 32px; padding: 4px 12px; font-size: 13px; font-weight: 400; color: var(--ink); white-space: nowrap; }
details.menu .pop .danger { color: var(--crit); }
details.menu .pop button:hover, details.menu .pop a:hover { background: var(--sunk); }

dl.kv { display: grid; grid-template-columns: 136px minmax(0, 1fr); gap: 8px 16px; margin: 0; }
dl.kv dt { color: var(--muted); font-size: 13px; }
dl.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }

/* stage track */
/* One block for the tracker and its note keeps the gap above Details and Threads the same at every stage. */
.tracker { margin-bottom: 24px; }
ol.track { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: nowrap; font-size: 13px; color: var(--muted); }
ol.track li { display: flex; align-items: center; flex: 0 0 auto; white-space: nowrap; }
ol.track li + li { flex: 1 1 auto; min-width: 0; }
ol.track .pip { display: none; width: 8px; height: 8px; border: 1px solid var(--ctl); border-radius: 50%; }
ol.track .link { display: flex; flex: 1 1 auto; min-width: 16px; min-height: 24px; align-items: center; gap: 4px; margin: 0 8px; padding: 0; font-size: 12px; color: inherit; }
ol.track .link i { flex: 1 1 auto; min-width: 6px; height: 1px; background: var(--ctl); }
ol.track .link.loop { color: var(--warn); font-weight: 500; }
ol.track li.past .link i, ol.track li.now .link i, ol.track li.done .link i { background: var(--good); }
ol.track .lbl { display: inline-flex; align-items: center; gap: 4px; padding-bottom: 2px; border-bottom: 2px solid transparent; }
ol.track li.past .lbl { color: var(--ink-2); }
ol.track li.past .lbl .ic, ol.track li.done .lbl { color: var(--good); }
ol.track li.done .lbl { font-weight: 700; }
ol.track li.now .lbl { color: var(--ink); font-weight: 700; border-bottom-color: var(--accent); }
ol.track li.now.hold .lbl { border-bottom-color: var(--warn); }
ol.track li.now.stop .lbl { border-bottom-color: var(--crit); }
.track-note { max-width: none; margin: 8px 0 0; font-size: 13px; color: var(--muted); }
.track-note strong { color: var(--ink-2); font-weight: 500; }

/* timeline, transcript, diff */
ol.tl { list-style: none; margin: 0; padding: 0; }
ol.tl li { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 0 16px; padding: 8px; border-bottom: 1px solid var(--line); }
ol.tl .t { color: var(--muted); font-size: 13px; }
ol.tl .d { display: block; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
ol.tl li.bad strong { color: var(--warn); }
ol.tl strong { font-weight: 500; }
.term { background: var(--sunk); border: 1px solid var(--line); border-radius: var(--r); max-height: 560px; overflow: auto; }
ol.log { list-style: none; margin: 0; padding: 8px 0; font-size: 13px; }
ol.log li { display: grid; grid-template-columns: 40px 120px minmax(0, 1fr); gap: 0 12px; padding: 4px 16px; }
ol.log .n, ol.log .who { color: var(--muted); }
ol.log .agent .who { color: var(--accent); }
ol.log .what { overflow-wrap: anywhere; white-space: pre-wrap; }
ol.log .tool .what { color: var(--ink-2); }
.diff { border: 1px solid var(--line); border-radius: var(--r); overflow-x: auto; font-size: 13px; margin-top: 12px; }
.diff .path { background: var(--sunk); color: var(--ink-2); padding: 4px 12px; border-bottom: 1px solid var(--line); }
.diff .ln { white-space: pre; padding: 0 12px; min-width: max-content; }
.diff .add { background: var(--add); } .diff .del { background: var(--del); }
.diff .ctx { color: var(--muted); }
p.desc { margin: 0; max-width: 72ch; white-space: pre-wrap; overflow-wrap: anywhere; }
pre.block { background: var(--sunk); border: 1px solid var(--line); border-radius: var(--r); padding: 12px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
textarea.config { min-height: 420px; font-size: 13px; }
.code-big { font-size: 24px; font-weight: 700; letter-spacing: 0.08em; padding: 8px 16px; border: 1px dashed var(--ctl); border-radius: var(--r); display: inline-block; background: var(--sunk); }

/* board */
/* Lanes share the width equally from the same floor, and their tasks may shrink below their content, so no lane grows to fit a task and no task spills into the next lane. */
.board { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(120px, 1fr); gap: 12px; overflow-x: auto; padding-bottom: 8px; }
.lane { min-width: 0; }
.lane h2 { font-size: 14px; display: flex; justify-content: space-between; color: var(--ink-2); padding: 0 0 8px; border-bottom: 1px solid var(--line); margin-bottom: 8px; }
.lane h2 .n { color: var(--muted); font-weight: 400; }
.lane ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.lane .empty { padding: 4px 0; font-size: 13px; color: var(--muted); }
.tile { display: grid; gap: 8px; min-width: 0; padding: 12px; border: 1px solid var(--line); border-radius: var(--r); background: var(--panel); color: inherit; }
.tile:hover { border-color: var(--ctl); text-decoration: none; }
.tile .title { font-weight: 500; overflow-wrap: anywhere; }
.tile .subline { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.tile .st { white-space: normal; overflow-wrap: anywhere; }

/* charts */
.totals { display: flex; flex-wrap: wrap; gap: 8px 32px; margin: 0 0 32px; padding: 0; list-style: none; }
.totals li { display: grid; align-content: start; }
.totals b { font-size: 18px; font-weight: 700; }
.totals span { color: var(--muted); font-size: 13px; }
.legend { display: flex; flex-wrap: wrap; gap: 8px 24px; font-size: 13px; color: var(--ink-2); margin: 16px 0 8px; padding: 0; list-style: none; }
.legend li { display: inline-flex; gap: 8px; align-items: center; }
.key { width: 12px; height: 12px; border-radius: 2px; flex: none; display: inline-block; }
.chart { position: relative; }
.chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.chart text { font-size: 12px; fill: var(--muted); font-family: var(--mono); }
.chart .hit rect { fill: var(--ink); fill-opacity: 0; }
.chart .hit:hover rect { fill-opacity: 0.06; }
.chart .hit .pt { opacity: 0; }
.chart .hit:hover .pt { opacity: 1; }
.chart-tip { position: fixed; z-index: 60; pointer-events: none; max-width: 240px; background: var(--panel); color: var(--ink); border: 1px solid var(--ctl); border-radius: var(--r); box-shadow: var(--shadow); padding: 8px 12px; font-size: 13px; display: grid; gap: 2px; }
.chart-tip[hidden] { display: none; }
.chart-tip b { font-weight: 500; }
.chart-tip div { color: var(--ink-2); font-family: var(--mono); }
.minis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 32px; padding-top: 16px; }
.minis h3 { color: var(--ink-2); font-weight: 500; margin-bottom: 8px; }
.minis svg { max-width: 420px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 16px 6px 0; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 400; }
td.r, th.r { text-align: right; }
.table-region { overflow-x: auto; }
.table-region th, .table-region td { white-space: nowrap; }
.table-region tbody th { color: var(--ink); }
.row.act-row { grid-template-columns: 104px minmax(0, 1fr) auto; }
.act-row details.fold { margin: 0; }

/* dialog: a popover, which the browser centres and puts above a backdrop */
.dlg { background: var(--panel); color: var(--ink); border: 1px solid var(--ctl); border-radius: 6px; padding: 0; width: min(520px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; box-shadow: var(--shadow); }
.dlg::backdrop { background: rgba(0,0,0,0.6); }
.dlg form { margin: 0; }
.dlg-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 16px 24px; border-bottom: 1px solid var(--line); }
.dlg-body { padding: 24px; display: grid; gap: 16px; }
.dlg .choices { grid-template-columns: minmax(0, 1fr); }
.dlg-foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 16px 24px; border-top: 1px solid var(--line); }

/* setup checklist */
ol.setup { list-style: none; margin: 0; padding: 0; counter-reset: s; }
ol.setup li { counter-increment: s; display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; gap: 4px 8px; align-items: center; padding: 12px 8px; border-bottom: 1px solid var(--line); }
ol.setup li::before { content: counter(s); color: var(--muted); }
ol.setup li.done { color: var(--muted); }
ol.setup li.done::before { content: "ok"; color: var(--good); }
ol.setup li.next strong { color: var(--ink); }
ol.setup li.next::before { content: ">"; color: var(--accent); font-weight: 700; }
ol.setup .subline { display: block; color: var(--muted); font-size: 13px; }

/* login */
.login { max-width: 372px; margin: 96px auto 48px; padding: 0 16px; display: grid; gap: 24px; align-content: start; }
.login-head { display: flex; align-items: center; gap: 12px; }
.login-head img { width: 36px; height: 36px; border-radius: 6px; }
.login .form { max-width: none; }
.login .form button { width: 100%; }
.login .box { margin: 0; }

@media (max-width: 860px) {
  ol.track li:not(.now):not(.done) .name { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  ol.track .pip { display: block; }
  ol.track .link { margin: 0 6px; min-width: 8px; }
  ol.track .link i { min-width: 4px; }
  .shell { grid-template-columns: minmax(0, 1fr); }
  .top { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 30; }
  aside.side:not(:popover-open) { display: none; }
  aside.side:popover-open { position: fixed; inset: 0 auto 0 0; width: min(320px, 100vw); max-height: none; background: var(--bg); border-right: 1px solid var(--line); box-shadow: var(--shadow); }
  aside.side::backdrop { display: block; background: rgba(0,0,0,0.6); }
  .side-close { display: inline-flex; }
  .shell > main { border-left: 0; }
  .page { padding: 24px 16px 64px; }
  .login { margin-top: 48px; }
  .cols, .minis { grid-template-columns: minmax(0, 1fr); }
  .choices, .choices.two { grid-template-columns: minmax(0, 1fr); }
  button, .btn, .nav-group a, select, input[type=text], input[type=number], input[type=password], input[type=url], input[type=search], input[type=email], input[type=file], details.menu > summary, details.menu .pop a, details.menu .pop button { min-height: 44px; }
  .icon-btn, details.menu > summary { min-width: 44px; }
  .link, .seg a, .tabs a { min-height: 44px; }
  .tabs a { display: inline-flex; align-items: center; }
  select, input, textarea { font-size: 16px !important; }
  /* The chart's own width, so its labels keep their size and the region scrolls instead. */
  .chart svg.wide { min-width: 860px; }
  .minis svg { max-width: 320px; }
  .chart-scroll { overflow-x: auto; }
}
@media (max-width: 600px) {
  .row, .row.kinded { grid-template-columns: minmax(0, 1fr); }
  .row .kind { padding: 0; }
  .row .aside { justify-content: flex-start; }
  .grid-head { display: none; }
  .grid-row { grid-template-columns: minmax(0, 1fr) auto !important; }
  .grid-row .c-pr { display: none; }
  .grid-row > :first-child { grid-column: 1 / -1; }
  details.xrow > summary { grid-template-columns: minmax(0, 1fr) 16px; }
  details.xrow > summary > :nth-child(2), details.xrow > summary > :nth-child(3) { grid-column: 1; }
  dl.kv { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  dl.kv dd { margin-bottom: 8px; }
  ol.tl li { grid-template-columns: minmax(0, 1fr); }
  ol.log li { grid-template-columns: 32px minmax(0, 1fr); }
  ol.log .what { grid-column: 1 / -1; }
  .setting { grid-template-columns: minmax(0, 1fr); }
  ol.setup li { grid-template-columns: 32px minmax(0, 1fr); align-items: start; }
  ol.setup li .btn { grid-column: 2; justify-self: start; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }

`;
