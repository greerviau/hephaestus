import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { UNCHANGED_SCRIPT } from "../../src/web/unchanged.js";

const WHY = "Nothing to save: this is the same as version 1.";

interface Field {
  name: string;
  type: string;
  value: string;
  defaultValue: string;
  checked: boolean;
  defaultChecked: boolean;
  disabled: boolean;
  options?: { value: string; selected: boolean; defaultSelected: boolean }[];
}

class FakeButton {
  disabled = false;
  readonly attributes = new Map<string, string>();
  form: FakeForm | null = null;
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
}

class FakeForm {
  readonly listeners: Record<string, (() => void)[]> = {};
  constructor(readonly elements: Field[]) {}
  addEventListener(type: string, listener: () => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  fire(type: string): void {
    for (const listener of this.listeners[type] ?? []) listener();
  }
}

function text(name: string, value: string): Field {
  return {
    name,
    type: "text",
    value,
    defaultValue: value,
    checked: false,
    defaultChecked: false,
    disabled: false,
  };
}

function box(name: string, checked: boolean): Field {
  return { ...text(name, "on"), type: "checkbox", checked, defaultChecked: checked };
}

function boot(fields: Field[], options: { title?: string; marked?: boolean } = {}) {
  const form = new FakeForm(fields);
  const button = new FakeButton();
  button.form = form;
  if (options.marked !== false) {
    button.setAttribute("data-unchanged", WHY);
    button.setAttribute("data-unchanged-ignore", "deploy message");
  }
  if (options.title !== undefined) button.setAttribute("title", options.title);
  const windowListeners: Record<string, ((event: unknown) => void)[]> = {};
  const context = {
    document: {
      querySelectorAll: (selector: string) =>
        selector === "button[data-unchanged]" && button.hasAttribute("data-unchanged")
          ? [button]
          : [],
    },
    window: {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        (windowListeners[type] ??= []).push(listener);
      },
    },
  };
  runInNewContext(UNCHANGED_SCRIPT, context);
  const pageshow = (persisted: boolean): void => {
    for (const listener of windowListeners.pageshow ?? []) listener({ persisted });
  };
  return { form, button, pageshow };
}

describe("the script that turns a save button off until something changes", () => {
  it("turns the button off, with the reason as its tooltip, while the form is as the page loaded it", () => {
    const { button } = boot([text("limits.threads", "4")]);

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(WHY);
  });

  it("turns it on once a field changes, and off again when the change is undone", () => {
    const threads = text("limits.threads", "4");
    const { form, button } = boot([threads]);

    threads.value = "6";
    form.fire("input");
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("title")).toBe(false);

    threads.value = "4";
    form.fire("input");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(WHY);
  });

  it("counts a ticked or unticked box and a changed choice as a change", () => {
    const on = box("cron.improver.nightly.on", true);
    const select: Field = {
      ...text("provider", "claude"),
      type: "select-one",
      options: [
        { value: "claude", selected: true, defaultSelected: true },
        { value: "codex", selected: false, defaultSelected: false },
      ],
    };
    const { form, button } = boot([on, select]);

    on.checked = false;
    form.fire("change");
    expect(button.disabled).toBe(false);

    on.checked = true;
    select.options = [
      { value: "claude", selected: false, defaultSelected: true },
      { value: "codex", selected: true, defaultSelected: false },
    ];
    select.value = "codex";
    form.fire("change");
    expect(button.disabled).toBe(false);
  });

  it("does not count Deploy now or the message as a change to the config", () => {
    const deploy = box("deploy", true);
    const message = text("message", "");
    const { form, button } = boot([text("text", "Lead."), deploy, message]);

    deploy.checked = false;
    message.value = "Why";
    form.fire("input");

    expect(button.disabled).toBe(true);
  });

  it("compares with the values the page was rendered with, not ones the browser restored", () => {
    const threads = text("limits.threads", "4");
    threads.value = "6";

    const { button } = boot([threads]);

    expect(button.disabled).toBe(false);
  });

  it("checks again when the browser brings the page back from its cache", () => {
    const threads = text("limits.threads", "4");
    const { button, pageshow } = boot([threads]);

    threads.value = "6";
    pageshow(true);

    expect(button.disabled).toBe(false);
  });

  it("gives back a title the button had of its own", () => {
    const threads = text("limits.threads", "4");
    const { form, button } = boot([threads], { title: "Saves a version" });

    expect(button.getAttribute("title")).toBe(WHY);
    threads.value = "6";
    form.fire("input");
    expect(button.getAttribute("title")).toBe("Saves a version");
  });

  it("leaves alone a button that is not marked", () => {
    const { button } = boot([text("limits.threads", "4")], { marked: false });

    expect(button.disabled).toBe(false);
  });
});
