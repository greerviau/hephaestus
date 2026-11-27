import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { layout, page } from "../../src/web/html.js";
import { LIVE_SCRIPT, LIVE_SCRIPT_PATH } from "../../src/web/live.js";
import { PENDING_SCRIPT_TAG } from "../../src/web/pending.js";

describe("pages that refresh", () => {
  it("load the live script and keep a meta refresh for browsers without scripts", () => {
    const html = layout("Home", "<p>hi</p>", { refreshSeconds: 5 });

    expect(html).toContain(
      `<script src="${LIVE_SCRIPT_PATH}" data-live-seconds="5" defer></script>`,
    );
    expect(html).toContain('<noscript><meta http-equiv="refresh" content="5"></noscript>');
  });

  it("name the address to refresh in both the script and the meta refresh", () => {
    const html = page("Home", "<p>hi</p>", 10, "/work?tab=needs&x=1");

    expect(html).toContain('data-live-url="/work?tab=needs&amp;x=1"');
    expect(html).toContain('content="10;url=/work?tab=needs&amp;x=1"');
  });

  it("carry no refresh script and no refresh otherwise", () => {
    const html = layout("Home", "<p>hi</p>");

    expect(html).not.toContain(LIVE_SCRIPT_PATH);
    expect(html).not.toContain("http-equiv");
    expect(page("Sign in", "<p>hi</p>")).not.toContain(LIVE_SCRIPT_PATH);
  });

  it("all carry the script that shows a pressed button pending", () => {
    expect(layout("Home", "<p>hi</p>")).toContain(PENDING_SCRIPT_TAG);
    expect(page("Sign in", "<p>hi</p>")).toContain(PENDING_SCRIPT_TAG);
  });
});

interface Region {
  innerHTML: string;
  scrollTop: number;
}

interface Fetched {
  main?: string;
  side?: string;
  /** Present when the fetched page still asks for a refresh. */
  live?: { seconds: string; url?: string };
}

interface Options {
  responses: (() => Promise<unknown>)[];
  /** A field has focus. */
  typing?: boolean;
  /** A dialog is open. */
  dialog?: boolean;
  /** A form was submitted and the page waits for the answer. */
  sending?: boolean;
  hidden?: boolean;
}

interface Harness {
  main: Region;
  side: Region;
  timers: { callback: () => void; ms: number }[];
  reloads: number;
  scrolls: [number, number][];
  fetches: string[];
  replaced: string[];
}

function boot(options: Options): Harness {
  const harness: Harness = {
    main: { innerHTML: "<p>loading</p>", scrollTop: 0 },
    side: { innerHTML: "<a>nav</a>", scrollTop: 0 },
    timers: [],
    reloads: 0,
    scrolls: [],
    fetches: [],
    replaced: [],
  };
  const regions = {
    main: region(harness, "main"),
    side: region(harness, "side"),
  };
  const attributes: Record<string, string> = {
    "data-live-seconds": "5",
    "data-live-url": "/model?provider=x",
  };
  const tag = { getAttribute: (name: string) => attributes[name] ?? null };
  const queue = [...options.responses];
  const context = {
    document: {
      hidden: options.hidden === true,
      activeElement: options.typing === true ? { tagName: "INPUT" } : null,
      querySelector: (selector: string) => {
        if (selector === "dialog[open]") return options.dialog === true ? {} : null;
        if (selector === "form[data-pending]") return options.sending === true ? {} : null;
        return selector.startsWith("script") ? tag : null;
      },
      getElementById: (id: "main" | "side") => regions[id],
    },
    window: {
      scrollX: 0,
      scrollY: 300,
      scrollTo: (x: number, y: number) => harness.scrolls.push([x, y]),
    },
    history: { replaceState: (_: unknown, __: string, url: string) => harness.replaced.push(url) },
    location: {
      href: "http://dash/model?provider=x&notice=done",
      reload: () => {
        harness.reloads += 1;
      },
    },
    URL,
    setTimeout: (callback: () => void, ms: number) => harness.timers.push({ callback, ms }),
    fetch: (url: string) => {
      harness.fetches.push(url);
      const next = queue.shift();
      return next === undefined ? Promise.reject(new Error("no more")) : next();
    },
    DOMParser: class {
      parseFromString(text: string) {
        const fetched = JSON.parse(text) as Fetched;
        const live = fetched.live;
        return {
          getElementById: (id: "main" | "side") => {
            const html = fetched[id];
            return html === undefined ? null : { innerHTML: html };
          },
          querySelector: () =>
            live === undefined
              ? null
              : {
                  getAttribute: (name: string) =>
                    name === "data-live-seconds" ? live.seconds : (live.url ?? null),
                },
        };
      }
    },
  };
  runInNewContext(LIVE_SCRIPT, context);
  return harness;
}

function region(harness: Harness, name: "main" | "side") {
  return {
    get innerHTML(): string {
      return harness[name].innerHTML;
    },
    set innerHTML(value: string) {
      harness[name].innerHTML = value;
      // A real element loses its scroll position when its children are replaced.
      harness[name].scrollTop = 0;
    },
    get scrollTop(): number {
      return harness[name].scrollTop;
    },
    set scrollTop(value: number) {
      harness[name].scrollTop = value;
    },
    querySelectorAll: () => [],
  };
}

const answer =
  (fetched: Fetched, url = "http://dash/model?provider=x") =>
  () =>
    Promise.resolve({
      ok: true,
      redirected: false,
      url,
      text: () => Promise.resolve(JSON.stringify(fetched)),
    });

const LIVE = { seconds: "5", url: "/model?provider=x" };

async function tick(harness: Harness): Promise<void> {
  const next = harness.timers.shift();
  if (next === undefined) throw new Error("no timer scheduled");
  next.callback();
  await new Promise((resolve) => setImmediate(resolve));
}

describe("the live script", () => {
  it("waits for the delay, then fetches the named address and swaps in what changed", async () => {
    const harness = boot({
      responses: [answer({ main: "<p>ready</p>", side: "<a>nav 2</a>", live: LIVE })],
    });
    expect(harness.fetches).toEqual([]);
    expect(harness.timers.map((timer) => timer.ms)).toEqual([5000]);
    harness.main.scrollTop = 40;
    harness.side.scrollTop = 120;

    await tick(harness);

    expect(harness.fetches).toEqual(["http://dash/model?provider=x"]);
    expect(harness.main.innerHTML).toBe("<p>ready</p>");
    expect(harness.side.innerHTML).toBe("<a>nav 2</a>");
    expect(harness.main.scrollTop).toBe(40);
    expect(harness.side.scrollTop).toBe(120);
    expect(harness.scrolls).toEqual([[0, 300]]);
    expect(harness.timers).toHaveLength(1);
  });

  it("drops the result notice from the address bar, as the meta refresh does", async () => {
    const harness = boot({ responses: [answer({ main: "<p>ready</p>", live: LIVE })] });

    await tick(harness);

    expect(harness.replaced).toEqual(["/model?provider=x"]);
  });

  it("leaves a region alone when its content is unchanged", async () => {
    const harness = boot({
      responses: [answer({ main: "<p>loading</p>", side: "<a>nav</a>", live: LIVE })],
    });
    harness.side.scrollTop = 120;

    await tick(harness);

    expect(harness.side.scrollTop).toBe(120);
    expect(harness.timers).toHaveLength(1);
  });

  it("uses the delay and address the fetched page names", async () => {
    const harness = boot({
      responses: [answer({ main: "<p>a</p>", live: { seconds: "10", url: "/model" } })],
    });

    await tick(harness);

    expect(harness.timers.map((timer) => timer.ms)).toEqual([10000]);
  });

  it("stops polling once the page no longer asks for a refresh", async () => {
    const harness = boot({ responses: [answer({ main: "<p>ready</p>" })] });

    await tick(harness);

    expect(harness.main.innerHTML).toBe("<p>ready</p>");
    expect(harness.timers).toHaveLength(0);
  });

  it.each([
    ["a field has focus", { typing: true }],
    ["a dialog is open", { dialog: true }],
    ["a form is on its way to the server", { sending: true }],
    ["the tab is hidden", { hidden: true }],
  ])("leaves the page alone and tries again while %s", async (_, options: Partial<Options>) => {
    const harness = boot({ responses: [answer({ main: "<p>ready</p>" })], ...options });

    await tick(harness);

    expect(harness.fetches).toEqual([]);
    expect(harness.main.innerHTML).toBe("<p>loading</p>");
    expect(harness.timers).toHaveLength(1);
  });

  it("reloads when the session ended and the fetch landed on the sign-in page", async () => {
    const harness = boot({
      responses: [
        () =>
          Promise.resolve({
            ok: true,
            redirected: true,
            url: "http://dash/login",
            text: () => Promise.resolve(""),
          }),
      ],
    });

    await tick(harness);

    expect(harness.reloads).toBe(1);
    expect(harness.timers).toHaveLength(0);
  });

  it("tries again after a failed fetch, a server error, or a page with no main region", async () => {
    const harness = boot({
      responses: [
        () => Promise.reject(new Error("offline")),
        () =>
          Promise.resolve({
            ok: false,
            redirected: false,
            url: "",
            text: () => Promise.resolve(""),
          }),
        answer({ side: "<a>x</a>", live: LIVE }),
      ],
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await tick(harness);
      expect(harness.timers).toHaveLength(1);
    }
    expect(harness.main.innerHTML).toBe("<p>loading</p>");
    expect(harness.side.innerHTML).toBe("<a>nav</a>");
  });
});
