import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { CHART_TIP_SCRIPT, CHART_TIP_SCRIPT_PATH } from "../../src/web/chart-tip.js";

interface FakeElement {
  className: string;
  hidden: boolean;
  textContent: string;
  children: FakeElement[];
  tag: string;
  style: Record<string, string>;
  attributes: Record<string, string>;
  offsetWidth: number;
  offsetHeight: number;
  setAttribute(name: string, value: string): void;
  appendChild(child: FakeElement): void;
  replaceChildren(): void;
}

function element(tag: string): FakeElement {
  const node: FakeElement = {
    tag,
    className: "",
    hidden: false,
    textContent: "",
    children: [],
    style: {},
    attributes: {},
    offsetWidth: 120,
    offsetHeight: 60,
    setAttribute: (name, value) => {
      node.attributes[name] = value;
    },
    appendChild: (child) => {
      node.children.push(child);
    },
    replaceChildren: () => {
      node.children = [];
    },
  };
  return node;
}

interface Target {
  tip: string;
  contains(other: unknown): boolean;
}

function boot() {
  const body = element("body");
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const context = {
    document: {
      body,
      createElement: element,
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        (listeners[type] ??= []).push(listener);
      },
    },
    window: { innerWidth: 800, innerHeight: 600 },
  };
  runInNewContext(CHART_TIP_SCRIPT, context);
  const fire = (type: string, event: Record<string, unknown>): void => {
    for (const listener of listeners[type] ?? []) listener(event);
  };
  const node = (target: Target | null) => ({
    closest: (selector: string) => (selector === "[data-tip]" ? target : null),
  });
  const hit = (tip: string): Target & { getAttribute(name: string): string | null } => {
    const self = {
      tip,
      getAttribute: (name: string) => (name === "data-tip" ? tip : null),
      contains: (other: unknown) => other === self,
    };
    return self;
  };
  return {
    tip: () => body.children[0],
    hit,
    over: (target: Target | null, x: number, y: number) => {
      fire("pointerover", { target: node(target), clientX: x, clientY: y });
    },
    move: (target: Target | null, x: number, y: number) => {
      fire("pointermove", { target: node(target), clientX: x, clientY: y });
    },
    out: (target: Target, to: unknown) => {
      fire("pointerout", { target: node(target), relatedTarget: to });
    },
    fire,
    node,
  };
}

describe("the chart tip script", () => {
  it("is served from a script address", () => {
    expect(CHART_TIP_SCRIPT_PATH).toBe("/assets/chart-tip.js");
  });

  it("shows the hovered day's numbers next to the pointer and hides them on leave", () => {
    const page = boot();
    const day = page.hit("Nov 2\nMerged 2\nReverted 0");

    page.over(day, 100, 100);
    const tip = page.tip();

    expect(tip?.hidden).toBe(false);
    expect(tip?.attributes.role).toBe("tooltip");
    expect(tip?.children.map((child) => [child.tag, child.textContent])).toEqual([
      ["b", "Nov 2"],
      ["div", "Merged 2"],
      ["div", "Reverted 0"],
    ]);
    expect(tip?.style.left).toBe("112px");
    expect(tip?.style.top).toBe("112px");

    page.move(day, 150, 120);
    expect(tip?.style.left).toBe("162px");

    page.out(day, null);
    expect(tip?.hidden).toBe(true);
  });

  it("keeps the tip shown while the pointer moves inside the same target", () => {
    const page = boot();
    const day = page.hit("Nov 2\nPRs 1");

    page.over(day, 100, 100);
    page.out(day, day);

    expect(page.tip()?.hidden).toBe(false);
  });

  it("switches to the next day's numbers when the pointer crosses to it", () => {
    const page = boot();
    const first = page.hit("Nov 1\nPRs 1");
    const second = page.hit("Nov 2\nPRs 4");

    page.over(first, 100, 100);
    page.out(first, page.node(second));
    page.over(second, 110, 100);

    expect(page.tip()?.hidden).toBe(false);
    expect(page.tip()?.children[1]?.textContent).toBe("PRs 4");
  });

  it("flips to the other side of the pointer at the right and bottom edges of the window", () => {
    const page = boot();

    page.over(page.hit("Nov 30\nPRs 1"), 790, 590);

    expect(page.tip()?.style.left).toBe(`${String(790 - 12 - 120)}px`);
    expect(page.tip()?.style.top).toBe(`${String(590 - 12 - 60)}px`);
  });

  it("never puts the tip past the left or top edge", () => {
    const page = boot();
    const tip = (): FakeElement | undefined => page.tip();

    page.over(page.hit("Nov 1\nPRs 1"), 5, 5);
    const node = tip();
    if (node === undefined) throw new Error("no tip");
    node.offsetWidth = 900;
    node.offsetHeight = 700;
    page.move(page.hit("Nov 1\nPRs 1"), 400, 300);

    expect(node.style.left).toBe("8px");
    expect(node.style.top).toBe("8px");
  });

  it("does nothing over parts of the page that are not charts", () => {
    const page = boot();

    page.over(null, 100, 100);
    page.move(null, 100, 100);

    expect(page.tip() === undefined || page.tip()?.hidden === true).toBe(true);
  });

  it("hides the tip when the page scrolls", () => {
    const page = boot();
    page.over(page.hit("Nov 1\nPRs 1"), 100, 100);

    page.fire("scroll", {});

    expect(page.tip()?.hidden).toBe(true);
  });
});
