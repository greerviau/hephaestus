/**
 * The dashboard stylesheet, copied from the t3-factory dashboard mockup with
 * its mockup-only controls removed, plus the few rules that server-rendered
 * pages need.
 */
export const STYLESHEET = `:root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --sunk: #f0efec;
  --ink: #1b1b1a;
  --ink-2: #52514e;
  --muted: #6b6a66;
  --line: rgba(27,27,26,0.12);
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --accent: #1c5cab;
  --accent-ink: #ffffff;
  --accent-wash: rgba(28,92,171,0.08);
  --series-1: #2a78d6;
  --series-2: #eb6834;
  --series-3: #12996a;
  --series-muted: #8a8984;
  --good: #006300;
  --warn-ink: #8a5a00;
  --crit: #b42e2e;
  --crit-ink: #ffffff;
  --hatch: #807f7a;
  --add-bg: #e3f1e3;
  --run-bg: #e1ecfa; --run-ink: #1c5cab; --you-bg: #fbeed6; --done-bg: #e3f1e3; --bad-bg: #f8e3e1;
  --del-bg: #f8e3e1;
  --shadow: 0 8px 32px rgba(0,0,0,0.18);
  --radius: 8px;
  --radius-s: 6px;
  --font: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Cantarell, "Noto Sans", "Liberation Sans", Arial, system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --sunk: #232321; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #a3a29b;
    --line: rgba(240,239,236,0.13); --grid: #2c2c2a; --axis: #383835; --accent: #6da7ec; --accent-ink: #0b0b0b; --accent-wash: rgba(109,167,236,0.12);
    --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70;
    --good: #3fbf3f; --warn-ink: #f5b93a; --crit: #f07a7a; --crit-ink: #0b0b0b; --hatch: #7a7973; --series-muted: #8a8984;
    --add-bg: #12301a; --del-bg: #3a1717; --run-bg: #172a40; --run-ink: #8cbcf2; --you-bg: #352810; --done-bg: #12301a; --bad-bg: #3a1717; --shadow: 0 8px 32px rgba(0,0,0,0.6);
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --sunk: #232321; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #a3a29b;
  --line: rgba(240,239,236,0.13); --grid: #2c2c2a; --axis: #383835; --accent: #6da7ec; --accent-ink: #0b0b0b; --accent-wash: rgba(109,167,236,0.12);
  --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70;
  --good: #3fbf3f; --warn-ink: #f5b93a; --crit: #f07a7a; --crit-ink: #0b0b0b; --hatch: #7a7973; --series-muted: #8a8984;
  --add-bg: #12301a; --del-bg: #3a1717; --run-bg: #172a40; --run-ink: #8cbcf2; --you-bg: #352810; --done-bg: #12301a; --bad-bg: #3a1717; --shadow: 0 8px 32px rgba(0,0,0,0.6);
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--page); color: var(--ink); font: 16px/1.5 var(--font); }
a { color: var(--accent); text-underline-offset: 2px; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.num { font-variant-numeric: tabular-nums; }
.wrap { max-width: 1200px; margin: 0 auto; padding: 0 24px; }
code, pre, .mono { font-family: var(--mono); font-size: 14px; }
code { overflow-wrap: anywhere; }
.skip { position: absolute; left: 16px; top: -64px; background: var(--surface); padding: 8px 16px; border-radius: var(--radius-s); z-index: 10; }
.skip:focus { top: 8px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* header */
header.top { background: var(--surface); border-bottom: 1px solid var(--line); }
.top-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 16px; padding: 16px 0 8px; }
.brand { font-size: 20px; font-weight: 650; margin: 0 8px 4px 0; color: var(--ink); text-decoration: none; align-self: center; }
.field { min-width: 0; max-width: 100%; display: flex; flex-direction: column; gap: 4px; }
.field > label, .field > .label { font-size: 14px; color: var(--muted); }
select, input[type=text], input[type=number], input[type=search], input[type=url], input[type=email], input[type=password], input[type=file], textarea {
  max-width: 100%; font: inherit; font-size: 14px; color: var(--ink); background: var(--surface);
  border: 1px solid var(--muted); border-radius: var(--radius-s); min-height: 36px; padding: 4px 8px; }
textarea { line-height: 1.5; padding: 8px 12px; width: 100%; }
input[type=text], input[type=url], input[type=search], input[type=email], input[type=password] { width: 100%; }
.unit input[type=number] { width: 96px; }
input[type=file] { padding: 6px 8px; }
input[type=number] { width: 96px; }
.top-actions { margin-left: auto; display: flex; gap: 12px; align-items: center; }
nav.tabs { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: thin; }
nav.tabs a { display: inline-block; padding: 12px; font-size: 14px; color: var(--ink-2); text-decoration: none; border-bottom: 2px solid transparent; white-space: nowrap; }
nav.tabs a:hover { color: var(--ink); }
nav.tabs a:focus-visible, .subtabs button:focus-visible { outline-offset: -3px; }
nav.tabs a[aria-current="page"] { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }

/* buttons */
button, .btn { font: inherit; font-size: 14px; font-weight: 600; min-height: 40px; padding: 8px 16px; border-radius: var(--radius-s); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; white-space: nowrap; transition: opacity 150ms ease-out; }
button:active, .btn:active { opacity: 0.8; }
.btn-primary { background: var(--accent); color: var(--accent-ink); border: 1px solid var(--accent); }
.btn-secondary { background: transparent; color: var(--ink); border: 1px solid var(--muted); }
.btn-danger { background: var(--crit); color: var(--crit-ink); border: 1px solid var(--crit); }
.linkbtn { background: none; border: 0; padding: 0 2px; min-height: 24px; color: var(--accent); font-weight: 400; text-decoration: underline; text-underline-offset: 2px; }
.linkbtn.crit, a.crit { color: var(--crit); }
.btn-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }

/* page */
main.wrap { padding-top: 32px; padding-bottom: 64px; }
main:focus { outline: none; }
.crumbs { font-size: 14px; color: var(--muted); margin: 0 0 8px; display: flex; flex-wrap: wrap; gap: 8px; }
.crumbs a { display: inline-flex; min-height: 24px; align-items: center; }
.page-head { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: flex-start; justify-content: space-between; margin-bottom: 24px; }
.page-head > div:first-child { min-width: 0; flex: 1 1 480px; }
h1 { font-size: 28px; line-height: 1.25; margin: 0; font-weight: 650; overflow-wrap: anywhere; }
h1:focus { outline: none; }
.page-head .lede { margin: 8px 0 0; }
.page-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.filterbar { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: flex-end; margin: 0 0 24px; }
.filterbar .field { flex: 0 1 auto; }
.filterbar .grow { flex: 1 1 220px; }
.grid { display: grid; gap: 24px; grid-template-columns: repeat(12, minmax(0, 1fr)); align-items: stretch; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 24px; min-width: 0; }
.span-12 { grid-column: span 12; } .span-8 { grid-column: span 8; } .span-7 { grid-column: span 7; } .span-6 { grid-column: span 6; } .span-5 { grid-column: span 5; } .span-4 { grid-column: span 4; }
@media (max-width: 960px) { .span-8, .span-7, .span-6, .span-5, .span-4 { grid-column: span 12; } }
h2 { font-size: 20px; line-height: 1.3; margin: 0 0 8px; font-weight: 650; }
h3 { font-size: 16px; line-height: 1.4; margin: 0 0 4px; font-weight: 600; }
.lede { margin: 0 0 16px; color: var(--ink-2); max-width: 75ch; }
p { max-width: 75ch; }
.meta { font-size: 14px; color: var(--muted); }
.card-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; align-items: baseline; margin-bottom: 8px; }
.card-head h2 { margin: 0; }
.card-head a, .card-head .linkbtn { font-size: 14px; min-height: 24px; display: inline-flex; align-items: center; }
.note { font-size: 14px; color: var(--ink-2); margin: 12px 0 0; }
.chip { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; line-height: 1.3; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--ink-2); background: var(--page); white-space: nowrap; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip svg { width: 14px; height: 14px; }

/* tables */
.table-scroll { overflow-x: auto; margin: 0 -24px; padding: 0 24px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 8px 16px 8px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
th:last-child, td:last-child { padding-right: 0; }
th { color: var(--muted); font-weight: 500; white-space: nowrap; }
td.r, th.r { text-align: right; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
.title-cell { min-width: 240px; }
.nowrap { white-space: nowrap; }
.wrapcell { overflow-wrap: anywhere; min-width: 120px; }
tr.current td { background: var(--accent-wash); }
td .sub { display: block; color: var(--muted); font-size: 13px; }
@media (max-width: 600px) {
  table.stack thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  table.stack, table.stack tbody, table.stack tr, table.stack td { display: block; width: 100%; }
  table.stack tr { border-bottom: 1px solid var(--line); padding: 12px 0; }
  table.stack tbody tr:last-child { border-bottom: 0; }
  table.stack td { display: flex; gap: 12px; border: 0; padding: 2px 0; text-align: left; white-space: normal; min-width: 0; }
  table.stack td::before { content: attr(data-label); color: var(--muted); flex: 0 0 104px; }
  table.stack td > * { min-width: 0; max-width: 100%; }
  table.stack td > .cv { flex: 1 1 auto; }
  table.stack button { white-space: normal; text-align: left; }
  table.stack td select { width: 100%; }
  table.stack td.title-cell { display: block; padding-bottom: 4px; font-size: 16px; }
  table.stack td.title-cell::before { display: none; }
  table.stack .table-scroll, .table-scroll:has(table.stack) { overflow: visible; }
}

/* status */
.status { display: inline-flex; gap: 6px; align-items: flex-start; }
.status > .ic { margin-top: 3px; }
.status > span { min-width: 0; overflow-wrap: break-word; }
ol.steps li, ul.checks li > span { min-width: 0; overflow-wrap: break-word; }
.status svg, .ic { width: 16px; height: 16px; flex: none; }
.s-good { color: var(--good); }
.s-warn { color: var(--warn-ink); }
.s-crit { color: var(--crit); }
.s-neutral { color: var(--ink-2); }
.s-muted { color: var(--muted); }

/* lists */
ul.asks { list-style: none; margin: 0 0 16px; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); gap: 0 24px; }
.ask { border-top: 1px solid var(--line); padding: 16px 0; min-width: 0; }
.notice .status { align-items: flex-start; }
.notice .status .ic { margin-top: 3px; }
.ask p { margin: 4px 0 8px; }
blockquote { margin: 0 0 8px; padding: 8px 12px; background: var(--sunk); border-radius: var(--radius-s); font-size: 14px; color: var(--ink-2); }
.links { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 14px; margin: 0; }
.links a, .links .linkbtn { display: inline-flex; align-items: center; min-height: 24px; font-size: 14px; }
dl.kv { display: grid; grid-template-columns: minmax(96px, max-content) 1fr; gap: 8px 16px; margin: 0; font-size: 14px; }
dl.kv dt { color: var(--muted); }
dl.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }

/* timeline */
ol.timeline { list-style: none; margin: 0; padding: 0; }
ol.timeline li { display: grid; grid-template-columns: 88px 16px 1fr; gap: 0 12px; position: relative; padding-bottom: 16px; }
ol.timeline li:last-child { padding-bottom: 0; }
ol.timeline .t { font-size: 14px; color: var(--muted); text-align: right; padding-top: 1px; }
ol.timeline .dot { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--muted); background: var(--surface); margin-top: 5px; position: relative; z-index: 1; }
ol.timeline li::before { content: ""; position: absolute; left: 105px; top: 18px; bottom: -4px; width: 2px; background: var(--grid); }
ol.timeline li:last-child::before { display: none; }
ol.timeline li.now .dot { border-color: var(--accent); background: var(--accent); }
ol.timeline li.bad .dot { border-color: var(--crit); }
ol.timeline .ev { min-width: 0; font-size: 14px; overflow-wrap: anywhere; }
ol.timeline .ev strong { font-size: 16px; font-weight: 600; }
ol.timeline .ev p { margin: 2px 0 0; color: var(--ink-2); }

/* charts */
.legend { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 14px; color: var(--ink-2); margin: 0 0 12px; padding: 0; list-style: none; }
.legend li { display: inline-flex; gap: 6px; align-items: center; }
.key { width: 12px; height: 12px; border-radius: 3px; display: inline-block; flex: none; }
.key.lk { height: 2px; width: 14px; border-radius: 1px; }
.key.hatch { background: repeating-linear-gradient(45deg, var(--hatch) 0 2px, transparent 2px 6px); border: 1px solid var(--ink-2); }
.chart { position: relative; }
.chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.chart .mark { cursor: default; transition: opacity 120ms ease-out; }
.chart .mark:hover, .chart .mark:focus { opacity: 0.8; }
.chart .mark:focus, .chart .hit:focus { outline: none; }
.chart .mark:focus-visible { stroke: var(--ink); stroke-width: 2px; }
.chart .hit:focus-visible + .focusring { opacity: 1; }
.chart .focusring { opacity: 0; pointer-events: none; }
.tip { position: absolute; pointer-events: none; background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-s); padding: 8px 12px; font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.12); opacity: 0; transition: opacity 120ms ease-out; white-space: nowrap; z-index: 2; }
.tip.on { opacity: 1; }
.tip strong { font-variant-numeric: tabular-nums; }
.tip .row { display: flex; gap: 8px; align-items: center; }
.tip .line { width: 12px; height: 2px; display: inline-block; }
details.as-table { margin-top: 12px; font-size: 14px; }
details > summary { cursor: pointer; color: var(--accent); min-height: 24px; display: inline-flex; align-items: center; font-size: 14px; }
.mini-grid { gap: 16px 24px; }
.mini h3 { font-size: 14px; color: var(--ink-2); font-weight: 600; }
.page-actions .also { flex-basis: 100%; margin: 0; }
.hbars { display: grid; gap: 8px; font-size: 14px; }
.hrow { display: grid; grid-template-columns: minmax(96px, 38%) 1fr minmax(56px, max-content); gap: 12px; align-items: center; }
.hbars .lab { overflow-wrap: anywhere; }
.hbars .track { height: 12px; position: relative; }
.hbars .bar { position: absolute; left: 0; top: 0; bottom: 0; background: var(--series-1); border-radius: 0 4px 4px 0; }
.hbars .val { text-align: right; font-variant-numeric: tabular-nums; }
.hbars .grp { font-weight: 600; margin-top: 8px; }
@media (max-width: 600px) { .hrow { grid-template-columns: 1fr auto; gap: 4px 12px; } .hrow .track { grid-column: 1 / -1; order: 3; } }

/* segmented outcome bar */
.seg-thin { display: flex; gap: 2px; height: 8px; width: 120px; border-radius: 4px; overflow: hidden; background: var(--grid); }
.seg-thin span { display: block; height: 100%; }
.seg-thin span:first-child { border-radius: 4px 0 0 4px; } .seg-thin span:last-child { border-radius: 0 4px 4px 0; }

/* v2 components */
a.ext { display: inline-flex; gap: 4px; align-items: center; min-height: 24px; }
a.ext .ic { width: 12px; height: 12px; }
.spark { display: block; margin-top: 4px; }
.meter .floor { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--ink); }
.meter .mt { overflow: visible; }
.meter .mt .mf { overflow: hidden; }
ul.plain { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 2px; }
.acct-status { margin: 0 0 4px; font-size: 16px; }
ol.setup { margin: 0; padding-left: 24px; display: grid; gap: 8px; }
ol.steps.vertical { display: grid; gap: 8px; }
details.filediff { margin-top: 8px; }
details.filediff .diff { margin-top: 8px; }
.savebar { position: sticky; bottom: 0; background: var(--page); border-top: 1px solid var(--line); padding: 12px 0; z-index: 3; }
.outc { display: inline-grid; gap: 2px; min-width: 132px; }
.choice label.disabled span:not(.hint) { color: var(--muted); }
.unit { display: inline-flex; gap: 8px; align-items: center; font-size: 14px; }
.proj { white-space: normal; }
button[disabled] { opacity: 0.55; cursor: not-allowed; }

/* unattended */
.since .since-list { margin: 0; padding-left: 20px; display: grid; gap: 4px; max-width: 90ch; }
.also { display: flex; gap: 6px; align-items: flex-start; font-size: 14px; color: var(--ink-2); margin: 8px 0 0; }
.also .ic { margin-top: 3px; color: var(--muted); }
.notice { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 14px; margin: 0 0 8px; }
.meter { display: grid; gap: 2px; min-width: 112px; font-size: 14px; }
.meter .mt { height: 6px; border-radius: 3px; background: var(--grid); position: relative; overflow: hidden; }
.meter .mf { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ink-2); border-radius: 3px; }
.meter.low .mf { background: var(--crit); }
.digest { border: 1px solid var(--line); border-radius: var(--radius); background: var(--page); padding: 16px; font-size: 14px; }
.digest h3 { font-size: 14px; margin: 12px 0 4px; }
.digest h3:first-of-type { margin-top: 8px; }
.digest ul { margin: 0; padding-left: 20px; }
.digest .btn-row { margin-top: 12px; }

/* states */
.empty, .loading { color: var(--ink-2); max-width: 75ch; margin: 0; }
.skel { display: grid; gap: 8px; margin-top: 12px; }
.skel span { display: block; height: 12px; border-radius: 4px; background: var(--grid); }
.skel span:nth-child(2) { width: 82%; } .skel span:nth-child(3) { width: 64%; }
.banner { border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: 16px 24px; margin-bottom: 24px; }
.banner.err { border-color: var(--crit); }
.banner.info { border-color: var(--accent); }
.banner p { margin: 4px 0 0; }

/* forms */
.form-grid { display: grid; gap: 16px; max-width: 640px; }
.form-row { display: flex; flex-wrap: wrap; gap: 16px; }
.hint { font-size: 14px; color: var(--muted); margin: 0; }
.err-text { font-size: 14px; color: var(--crit); margin: 0; display: flex; gap: 6px; align-items: center; }
.warn-text { font-size: 14px; color: var(--warn-ink); margin: 0; display: flex; gap: 6px; align-items: flex-start; }
.warn-text[hidden] { display: none; }
.warn-text .ic { margin-top: 3px; }
.choice { display: grid; gap: 8px; border: 0; margin: 0; padding: 0; }
.choice legend { font-size: 14px; color: var(--muted); padding: 0; margin-bottom: 4px; }
.choice label { display: grid; grid-template-columns: 20px 1fr; gap: 0 8px; align-items: start; min-height: 24px; font-size: 14px; }
.choice label input { margin: 3px 0 0; width: 16px; height: 16px; }
.choice label .hint { grid-column: 2; }
.switch { display: inline-flex; gap: 8px; align-items: center; min-height: 24px; font-size: 14px; }
.switch input { width: 16px; height: 16px; margin: 0; }

/* diff */
.diff { font-family: var(--mono); font-size: 13px; line-height: 1.6; border: 1px solid var(--line); border-radius: var(--radius-s); overflow-x: auto; margin: 0; }
.diff div { white-space: pre; padding: 0 12px; min-width: max-content; }
.diff .add { background: var(--add-bg); }
.diff .del { background: var(--del-bg); }
.diff .hunk { color: var(--muted); background: var(--sunk); }
.diff .sign { display: inline-block; width: 16px; color: var(--ink-2); user-select: none; }

/* settings layout */
.with-side { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 32px; align-items: start; }
.side { position: sticky; top: 16px; display: grid; gap: 2px; font-size: 14px; }
.side a { padding: 8px 12px; border-radius: var(--radius-s); text-decoration: none; color: var(--ink-2); min-height: 36px; display: flex; align-items: center; }
.side a:hover { background: var(--accent-wash); color: var(--ink); }
.stack-24 { display: grid; gap: 24px; }
@media (max-width: 860px) { .with-side { grid-template-columns: 1fr; } .side { position: static; display: flex; flex-wrap: wrap; } }

/* stepper */
ol.steps { list-style: none; margin: 0 0 24px; padding: 0; display: flex; flex-wrap: wrap; gap: 8px 24px; font-size: 14px; }
ol.steps li { display: flex; gap: 8px; align-items: center; color: var(--muted); }
ol.steps li .n { width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--muted); display: inline-flex; align-items: center; justify-content: center; font-size: 13px; }
ol.steps li[aria-current="step"] { color: var(--ink); font-weight: 600; }
ol.steps li[aria-current="step"] .n { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
ol.steps li.done { color: var(--ink-2); }
ul.checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; font-size: 14px; }
ul.checks li { display: grid; grid-template-columns: 16px 1fr; gap: 8px; }
ul.checks li .status { padding-top: 2px; }

@media (max-width: 600px) {
  .wrap { padding: 0 16px; }
  .card { padding: 16px; }
  .table-scroll { margin: 0 -16px; padding: 0 16px; }
  .grid { gap: 16px; }
  .top-actions { margin-left: 0; }
  h1 { font-size: 24px; }
  select, input[type=text], input[type=number], input[type=search], input[type=url], input[type=email], input[type=password], input[type=file], textarea { font-size: 16px; min-height: 44px; }
  button, .btn { min-height: 44px; }
  .page-actions, .page-actions .btn, .page-actions button { width: 100%; }
  ol.timeline li { grid-template-columns: 56px 16px 1fr; gap: 0 8px; }
  ol.timeline li::before { left: 69px; }
  dl.kv { grid-template-columns: 1fr; gap: 2px; }
  dl.kv dd { margin-bottom: 8px; }
  .hbars { grid-template-columns: 1fr minmax(64px, max-content); }
  .hbars .track { grid-column: 1 / -1; order: 0; }
}


/* status pills: color says the category, the dot or icon repeats it, the label says it in words */
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px 2px 8px; border-radius: 999px; font-size: 13px; font-weight: 600; line-height: 20px; white-space: nowrap; }
.pill .ic { width: 14px; height: 14px; margin: 0; }
.pill .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
.p-run { background: var(--run-bg); color: var(--run-ink); }
.p-you { background: var(--you-bg); color: var(--warn-ink); }
.p-wait { background: var(--sunk); color: var(--ink-2); }
.p-done { background: var(--done-bg); color: var(--good); }
.p-off { background: transparent; color: var(--muted); box-shadow: inset 0 0 0 1px var(--line); }
.p-bad { background: var(--bad-bg); color: var(--crit); }
.p-run .dot { animation: pulse 1.6s ease-out infinite; }
.p-run .dot::after { content: none; }
@keyframes pulse { 0% { opacity: 1; transform: scale(1); } 60% { opacity: 0.35; transform: scale(0.6); } 100% { opacity: 1; transform: scale(1); } }
.status-cell .sub { margin-top: 4px; }
.chipbar { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
.chipbar button { min-height: 32px; padding: 4px 12px; font-size: 13px; font-weight: 600; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); color: var(--ink-2); display: inline-flex; gap: 6px; align-items: center; }
.chipbar button[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); color: var(--ink); }
.chipbar .num { font-weight: 400; color: var(--muted); }
.needs-grid ul.needs { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr)); gap: 0 32px; }
.needs-grid li.need { border-bottom: 0; border-top: 1px solid var(--line); }
.mini-list { list-style: none; margin: 0; padding: 0; }
.mini-list li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
.mini-list li:last-child { border-bottom: 0; }
/* calm layer: fewer, quieter elements */
.since-line { margin: 8px 0 0; color: var(--ink-2); max-width: 75ch; }
.calm { display: flex; gap: 8px; align-items: center; color: var(--ink-2); margin: 0; }
.btn-s { min-height: 36px; padding: 6px 14px; }
.also { display: block; font-size: 13px; color: var(--muted); margin: 6px 0 0; }
.also code { font-size: 13px; }
.rcpt { font-size: 14px; color: var(--muted); }
h3.group { font-size: 14px; font-weight: 600; color: var(--ink-2); margin: 16px 0 0; }
h3.group:first-child { margin-top: 0; }
ul.needs, ul.odd, ul.prog, ul.log { list-style: none; margin: 0; padding: 0; }
li.need { padding: 16px 0; border-bottom: 1px solid var(--line); }
li.need:last-child { border-bottom: 0; }
.need-title { font-weight: 600; }
.why { margin: 4px 0 2px; color: var(--ink-2); }
.need p.meta { margin: 0; }
.need-acts { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin-top: 10px; font-size: 14px; }
.needbox { border-color: var(--warn-ink); }
.needbox h2 { margin-bottom: 4px; }
ul.odd li { padding: 6px 0; }
ul.prog li { display: grid; grid-template-columns: 1fr auto; gap: 4px 16px; padding: 12px 0; border-bottom: 1px solid var(--line); }
ul.prog li:last-child { border-bottom: 0; }
.prog-main { min-width: 0; }
.doing { margin: 4px 0 0; font-size: 14px; }
.prog-when { text-align: right; white-space: nowrap; }
.prog-group + .prog-group, .prog-group + .group-fold { margin-top: 20px; }
.prog-group .hint { margin: 2px 0 0; }
ul.log li { display: grid; grid-template-columns: 96px 1fr auto; gap: 4px 16px; padding: 12px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
ul.log li:last-child { border-bottom: 0; }
ul.log .t { color: var(--muted); }
ul.log p.meta { margin: 2px 0 0; }
details.fold > summary, details.acct > summary { cursor: pointer; list-style: none; display: grid; grid-template-columns: 1fr auto; gap: 4px 16px; align-items: baseline; }
details.fold > summary::-webkit-details-marker, details.acct > summary::-webkit-details-marker { display: none; }
details.fold > summary, details.acct > summary, .group-fold > summary { color: var(--ink); min-height: 0; }
details.fold > summary h2 { margin: 0; }
details.fold > summary::after, details.acct > summary::after { content: "Show"; grid-column: 2; grid-row: 1; font-size: 14px; color: var(--accent); }
details.fold[open] > summary::after, details.acct[open] > summary::after { content: "Hide"; }
details.fold > summary .meta { grid-column: 1 / -1; }
details.fold[open] > summary { margin-bottom: 16px; }
details.fold-inline { margin-top: 12px; }
details.fold-inline > summary { font-size: 14px; }
.group-fold > summary { cursor: pointer; list-style: none; display: flex; gap: 12px; align-items: baseline; }
.group-fold > summary::-webkit-details-marker { display: none; }
.group-fold > summary::after { content: "Show"; font-size: 14px; color: var(--accent); }
.group-fold[open] > summary::after { content: "Hide"; }
.prog-when .sub, .need .sub, ul.plain .sub { display: block; color: var(--muted); font-size: 13px; }
.more-filters { flex-basis: 100%; }
.more-filters > summary { font-size: 14px; }
.filterbar.compact { margin-bottom: 8px; }
fieldset.seg { border: 0; padding: 0; margin: 0 0 16px; display: inline-flex; border: 1px solid var(--muted); border-radius: var(--radius-s); overflow: hidden; }
fieldset.seg label { display: inline-flex; }
fieldset.seg input { position: absolute; opacity: 0; width: 1px; height: 1px; }
fieldset.seg span { padding: 8px 16px; font-size: 14px; min-height: 36px; display: inline-flex; align-items: center; cursor: pointer; }
fieldset.seg input:checked + span { background: var(--accent); color: var(--accent-ink); font-weight: 600; }
fieldset.seg input:focus-visible + span { outline: 3px solid var(--accent); outline-offset: -3px; }
.accts { display: grid; }
details.acct { border-bottom: 1px solid var(--line); padding: 12px 0; }
details.acct:last-child { border-bottom: 0; }
details.acct > summary { grid-template-columns: minmax(0, 1fr) auto auto auto; align-items: center; }
details.acct > summary::after { grid-column: 4; }
.acct-name { display: grid; }
.acct-body { padding: 12px 0 0; }
.setsec .card-head { margin-bottom: 16px; }
.lede-doing { color: var(--ink-2); margin-left: 4px; }
@media (max-width: 600px) {
  ul.log li { grid-template-columns: 1fr; }
  ul.prog li { grid-template-columns: 1fr; }
  .prog-when { text-align: left; }
  details.acct > summary { grid-template-columns: 1fr auto; }
  details.acct > summary::after { grid-column: 2; grid-row: 1; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } .p-run .dot { animation: none; } }
@media (forced-colors: active) { .qbar .seg, .seg-thin span, .hbars .bar { forced-color-adjust: none; } }

/* round 5: one factory, live threads, login relay */
.factory-name { font-size: 14px; color: var(--ink-2); align-self: center; padding: 2px 10px; border: 1px solid var(--line); border-radius: 999px; margin-bottom: 4px; }
.danger-outline { color: var(--crit); border-color: var(--crit); }
.need-acts a, .mini-list a, ul.plain a, .lede a, .page-head a, td > a, .cv > a, .needbox a { display: inline-flex; align-items: center; min-height: 24px; }
.thread-box { max-height: 420px; overflow: auto; border: 1px solid var(--line); border-radius: var(--radius-s); background: var(--sunk); }
ol.thread { list-style: none; margin: 0; padding: 0; font-size: 14px; }
ol.thread li { display: grid; grid-template-columns: 48px 96px minmax(0, 1fr); gap: 0 12px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
ol.thread li:last-child { border-bottom: 0; }
ol.thread .t { color: var(--muted); }
ol.thread .who { color: var(--muted); font-size: 13px; }
ol.thread .what { overflow-wrap: anywhere; }
ol.thread .th-tool .what, ol.thread .th-ctx .what { font-family: var(--mono); font-size: 13px; }
ol.thread .th-agent .who { color: var(--ink); font-weight: 600; }
.devcode { font-family: var(--mono); font-size: 28px; font-weight: 600; letter-spacing: 0.08em; padding: 12px 16px; margin: 8px 0; border: 1px dashed var(--muted); border-radius: var(--radius-s); display: inline-block; background: var(--sunk); }
ol.relay { margin: 0 0 16px; padding-left: 20px; display: grid; gap: 12px; }
ol.prs { margin: 0; padding-left: 20px; display: grid; gap: 16px; }
ol.plain-ol { margin: 0; padding-left: 20px; display: grid; gap: 8px; }
ul.qa-list li { margin-bottom: 12px; }
ul.qa-list p { margin: 4px 0 0; }
.page-acts { display: grid; gap: 4px; justify-items: end; }
.page-acts .also { margin: 0; text-align: right; }
.filediff h4 { margin: 12px 0 4px; font-size: 14px; font-weight: 600; }
@media (max-width: 600px) { ol.thread li { grid-template-columns: 44px minmax(0, 1fr); } ol.thread .what { grid-column: 1 / -1; } .page-acts { justify-items: start; } .page-acts .also { text-align: left; } }
.chip-qa { color: var(--run-ink); background: var(--run-bg); border-color: transparent; font-weight: 600; }
.meter { height: 6px; border-radius: 3px; background: var(--sunk); overflow: hidden; max-width: 360px; margin: 4px 0 8px; }
.meter span { display: block; height: 100%; background: var(--accent); transition: width .4s ease; }
@media (prefers-reduced-motion: reduce) { .meter span { transition: none; } }
hr.sep { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
.gdiff { color: var(--warn-ink); }
ol.sync { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 4px; font-size: 14px; }
ol.sync li { display: flex; gap: 8px; align-items: flex-start; }
.graph-scroll { overflow-x: auto; width: 100%; max-width: 100%; margin: 0 0 8px; }
section.card { min-width: 0; }
td .sub, td .cv { overflow-wrap: anywhere; }
tr.row-child > td:first-child { padding-left: 28px; box-shadow: inset 3px 0 0 var(--line); }
@media (max-width: 360px) { .pill { white-space: normal; text-align: left; } .chip { white-space: normal; } }
@media (min-width: 900px) { code.rn { white-space: nowrap; } }
ul.need-rows { list-style: none; margin: 0 0 16px; padding: 0; border-top: 1px solid var(--line); }
ul.need-rows > li { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--line); }
ul.need-rows .nr-main { flex: 1 1 320px; min-width: 0; }
ul.need-rows .need-acts { margin: 0; }
ul.need-rows .nr-main .sub { display: block; margin-top: 2px; font-size: 14px; color: var(--ink-2); }
.gt2 { font: 600 13px var(--font); fill: var(--ink); } .gi { fill: none; stroke: var(--ink-2); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
nav.side a[aria-current] { color: var(--ink); font-weight: 600; box-shadow: inset 3px 0 0 var(--accent); }
@media (min-width: 900px) { td.nw { white-space: nowrap; } }
td .btn-s + .btn-s { margin-left: 8px; }
/* Progressive disclosure */
[hidden] { display: none !important; }
details.info, details.cli { display: inline-block; position: relative; vertical-align: middle; }
details.info > summary, details.cli > summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; min-width: 24px; min-height: 24px; border: 1px solid var(--line); border-radius: 999px; font-size: 12px; color: var(--ink-2); padding: 0 6px; background: var(--page); }
details.info > summary::-webkit-details-marker, details.cli > summary::-webkit-details-marker, details.more-inline > summary::-webkit-details-marker { display: none; }
details.cli > summary { font-family: var(--mono); }
details.info[open] > summary, details.cli[open] > summary { border-color: var(--accent); color: var(--ink); }
details.info .pop, details.cli .pop { position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; width: min(380px, 84vw); background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-s); box-shadow: var(--shadow); padding: 12px 14px; font-size: 14px; color: var(--ink); text-align: left; font-weight: 400; white-space: normal; }
details.info .pop p:first-child, details.cli .pop p:first-child { margin-top: 0; }
details.info .pop p:last-child, details.cli .pop p:last-child { margin-bottom: 0; }
.page-actions details.cli, .page-acts details.cli, .need-acts details.cli, .btn-row details.cli { margin-left: 4px; }
details.more-inline { display: block; }
details.more-inline > summary { list-style: none; cursor: pointer; color: var(--ink-2); font-size: 13px; }
details.more-inline > summary::after { content: " more"; color: var(--accent); }
details.more-inline[open] > summary::after { content: " less"; }
details.more-inline > div { font-size: 13px; color: var(--ink-2); margin-top: 2px; }
details.more, details.trend, details.ngroup { margin-top: 12px; }
details.more > summary, details.trend > summary, details.ngroup > summary { cursor: pointer; color: var(--ink-2); font-size: 14px; min-height: 24px; }
details.ngroup > summary { font-weight: 600; color: var(--ink); padding: 6px 0; }
ul.nrows { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
ul.nrows > li.nrow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 8px 0; border-bottom: 1px solid var(--line); }
.nr-ic { display: inline-flex; }
.nr-main { flex: 1 1 280px; min-width: 0; }
.nr-why { color: var(--ink-2); font-size: 14px; margin-left: 6px; }
.nr-acts { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.row-more { background: none; border: 1px solid var(--line); border-radius: var(--radius-s); min-width: 28px; min-height: 28px; padding: 0 6px; color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; }
.row-more:hover { border-color: var(--accent); color: var(--ink); }
tr[data-row-item], li.nrow { cursor: pointer; }
.ok-chips { display: contents; }
.ok-chips[hidden] { display: none !important; }
button.schip { cursor: pointer; font: inherit; font-size: 13px; }
.drawer-open { margin: 0 0 12px; }
.strip { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.schip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; font-size: 13px; background: var(--page); text-decoration: none; color: var(--ink); min-height: 28px; }
a.schip:hover { border-color: var(--accent); }
.schip .status { font-size: 13px; }
p.counts { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
p.bignum { margin: 0 0 8px; } p.bignum .num { font-size: 28px; font-weight: 600; }
ul.plain.mini li { padding: 4px 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: space-between; }
.sec-sum { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; }
dl.kv-row { display: flex; flex-wrap: wrap; gap: 4px 20px; margin: 0; }
dl.kv-row dt { color: var(--muted); font-weight: 400; margin: 0; } dl.kv-row dd { margin: 0 8px 0 -14px; }
.sec-body { margin-top: 16px; }
.ptabs > .subtabs { margin-bottom: 16px; }
details.more > summary, details.trend > summary, details.ngroup > summary { list-style: none; }
details.more > summary::-webkit-details-marker, details.trend > summary::-webkit-details-marker, details.ngroup > summary::-webkit-details-marker { display: none; }
details.more > summary::before, details.trend > summary::before, details.ngroup > summary::before { content: "+"; display: inline-block; width: 16px; font-family: var(--mono); color: var(--accent); }
details.more[open] > summary::before, details.trend[open] > summary::before, details.ngroup[open] > summary::before { content: "-"; }
@media (max-width: 600px) { details.info .pop, details.cli .pop { position: fixed; left: 12px; right: 12px; top: auto; bottom: 12px; width: auto; max-height: 420px; overflow-y: auto; } }
details.info .pop.flip, details.cli .pop.flip { right: auto; left: 0; }
td .row-more { margin-left: 6px; min-width: 24px; min-height: 24px; vertical-align: middle; }

/* Hephaestus: server-rendered pages without JavaScript */
.top-row form { margin: 0; }
form.inline { display: inline-flex; margin: 0; }
.need-acts form { margin: 0; }
details.act { display: inline-block; position: relative; }
details.act > summary { list-style: none; cursor: pointer; font-size: 14px; font-weight: 600; min-height: 36px; padding: 6px 14px; border-radius: var(--radius-s); border: 1px solid var(--muted); color: var(--ink); display: inline-flex; align-items: center; }
details.act > summary::-webkit-details-marker { display: none; }
details.act[open] > summary { border-color: var(--accent); }
details.act.crit > summary { color: var(--crit); border-color: var(--crit); }
details.act > form { display: grid; gap: 8px; margin-top: 8px; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-s); background: var(--page); min-width: min(320px, 80vw); }
details.act > form label { font-size: 14px; color: var(--muted); }
.login-wrap { max-width: 400px; margin: 64px auto; padding: 0 16px; }
.login-wrap .card { display: grid; gap: 12px; }
.login-wrap h1 { font-size: 24px; }
pre.block { background: var(--sunk); border-radius: var(--radius-s); padding: 12px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
td pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font-size: 13px; }
textarea.config { font-family: var(--mono); font-size: 14px; min-height: 420px; resize: vertical; }
.chart text { font-size: 12px; fill: var(--muted); font-family: var(--font); }
.chart .mark:hover { opacity: 0.8; }
.stage-group + .stage-group { margin-top: 20px; }
.kpis { display: flex; flex-wrap: wrap; gap: 8px 32px; margin: 0 0 16px; }
.kpis div { display: grid; }
.kpis .num { font-size: 28px; font-weight: 600; line-height: 1.2; }
.kpis .meta { font-size: 13px; }
.factory-state { align-self: center; margin-bottom: 4px; }
.top-actions .linkbtn { font-size: 14px; }
@media (max-width: 600px) {
  .top-row { padding-bottom: 0; }
  nav.tabs { margin: 0 -16px; padding: 0 4px; }
  details.act > form { min-width: 0; }
}
`;
