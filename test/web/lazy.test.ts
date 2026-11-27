import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { LAZY_SCRIPT, LAZY_SCRIPT_PATH } from "../../src/web/lazy.js";

const URL_PATH = "/config/models/planning/summary";
const KEY = `hephaestus-lazy:${URL_PATH}`;

interface Node {
  innerHTML: string;
  attributes: Record<string, string>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

interface Harness {
  node: Node;
  storage: Map<string, string>;
  fetches: string[];
  click(target: Record<string, string>): void;
}

interface Options {
  /** Answers to fetch, in order; a string is a 200 body and an Error is a network failure. */
  answers: (string | Error | number)[];
  stored?: string;
  noStorage?: boolean;
  forget?: string;
  noNode?: boolean;
}

function boot(options: Options): Harness {
  const attributes: Record<string, string> = { "data-lazy-url": URL_PATH };
  const node: Node = {
    innerHTML: "<span>Loading...</span>",
    attributes,
    getAttribute: (name) => attributes[name] ?? null,
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
  };
  const storage = new Map<string, string>();
  if (options.stored !== undefined) storage.set(KEY, options.stored);
  const fetches: string[] = [];
  const queue = [...options.answers];
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const context = {
    document: {
      querySelectorAll: (selector: string) =>
        selector === "[data-lazy-url]" && options.noNode !== true ? [node] : [],
      querySelector: (selector: string) =>
        selector === "script[data-lazy-forget]" && options.forget !== undefined
          ? { getAttribute: () => options.forget }
          : null,
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        (listeners[type] ??= []).push(listener);
      },
    },
    window: {
      get sessionStorage() {
        if (options.noStorage === true) throw new Error("blocked");
        return {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
          removeItem: (key: string) => storage.delete(key),
        };
      },
    },
    fetch: (url: string) => {
      fetches.push(url);
      const next = queue.shift();
      if (next === undefined || next instanceof Error) {
        return Promise.reject(next ?? new Error("no more"));
      }
      if (typeof next === "number") {
        return Promise.resolve({ ok: false, status: next, text: () => Promise.resolve("") });
      }
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(next) });
    },
  };
  runInNewContext(LAZY_SCRIPT, context);
  return {
    node,
    storage,
    fetches,
    click: (target) => {
      const event = {
        target: {
          closest: (selector: string) => {
            const name = selector.replace(/^\[|\]$/g, "");
            return name in target ? { closest: () => node } : null;
          },
        },
      };
      for (const listener of listeners.click ?? []) listener(event);
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("the lazy script", () => {
  it("is served from a script address", () => {
    expect(LAZY_SCRIPT_PATH).toBe("/assets/lazy.js");
  });

  it("fills the placeholder with what the server answers and remembers it", async () => {
    const harness = boot({ answers: ["<b>model</b>"] });
    await settle();

    expect(harness.fetches).toEqual([URL_PATH]);
    expect(harness.node.innerHTML).toBe("<b>model</b>");
    expect(harness.storage.get(KEY)).toBe("<b>model</b>");
  });

  it("shows the remembered answer at once, then replaces it with a fresh one", async () => {
    const harness = boot({ answers: ["<b>new</b>"], stored: "<b>old</b>" });
    expect(harness.node.innerHTML).toBe("<b>old</b>");

    await settle();

    expect(harness.node.innerHTML).toBe("<b>new</b>");
    expect(harness.storage.get(KEY)).toBe("<b>new</b>");
  });

  it("shows an error inline when the fetch fails, and retries on request", async () => {
    const harness = boot({ answers: [new Error("offline"), "<b>model</b>"] });
    await settle();

    expect(harness.node.innerHTML).toContain("Could not load");
    expect(harness.node.innerHTML).toContain("data-lazy-retry");
    expect(harness.storage.has(KEY)).toBe(false);

    harness.click({ "data-lazy-retry": "" });
    await settle();

    expect(harness.fetches).toEqual([URL_PATH, URL_PATH]);
    expect(harness.node.innerHTML).toBe("<b>model</b>");
  });

  it("shows an error for an error status instead of storing it", async () => {
    const harness = boot({ answers: [500] });
    await settle();

    expect(harness.node.innerHTML).toContain("Could not load");
    expect(harness.storage.has(KEY)).toBe(false);
  });

  it("keeps the remembered answer when the fresh fetch fails", async () => {
    const harness = boot({ answers: [new Error("offline")], stored: "<b>old</b>" });
    await settle();

    expect(harness.node.innerHTML).toBe("<b>old</b>");
  });

  it("asks the server to read again on a refresh click", async () => {
    const harness = boot({ answers: ["<b>a</b>", "<b>b</b>"] });
    await settle();

    harness.click({ "data-lazy-refresh": "" });
    await settle();

    expect(harness.fetches).toEqual([URL_PATH, `${URL_PATH}?refresh=1`]);
    expect(harness.node.innerHTML).toBe("<b>b</b>");
  });

  it("works when the browser blocks storage", async () => {
    const harness = boot({ answers: ["<b>model</b>"], noStorage: true });
    await settle();

    expect(harness.node.innerHTML).toBe("<b>model</b>");
  });

  it("forgets the remembered answer on a page that names it, and fetches nothing", async () => {
    const harness = boot({ answers: [], stored: "<b>old</b>", forget: URL_PATH, noNode: true });
    await settle();

    expect(harness.storage.has(KEY)).toBe(false);
    expect(harness.fetches).toEqual([]);
  });
});
