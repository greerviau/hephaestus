import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { PENDING_SCRIPT, PENDING_SCRIPT_PATH } from "../../src/web/pending.js";

class FakeElement {
  disabled = false;
  readonly attributes = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
  };
  constructor(readonly tagName: string) {}
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

class FakeForm extends FakeElement {
  readonly buttons: FakeElement[];
  constructor(method: string, labels: string[]) {
    super("FORM");
    this.setAttribute("method", method);
    this.buttons = labels.map(() => new FakeElement("BUTTON"));
  }
  querySelectorAll(): FakeElement[] {
    return this.buttons;
  }
}

interface SubmitEvent {
  target: FakeForm;
  submitter?: FakeElement;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function boot() {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const on = (type: string, listener: (event: unknown) => void): void => {
    (listeners[type] ??= []).push(listener);
  };
  const forms: FakeForm[] = [];
  const timers: (() => void)[] = [];
  const context = {
    document: {
      addEventListener: on,
      querySelectorAll: () => forms.filter((form) => form.hasAttribute("data-pending")),
    },
    window: { addEventListener: on },
    setTimeout: (run: () => void) => {
      timers.push(run);
      return timers.length;
    },
  };
  runInNewContext(PENDING_SCRIPT, context);
  const form = (method: string, labels = ["Admit"]): FakeForm => {
    const made = new FakeForm(method, labels);
    forms.push(made);
    return made;
  };
  const submit = (target: FakeForm, submitter = target.buttons[0]): SubmitEvent => {
    const event: SubmitEvent = {
      target,
      ...(submitter === undefined ? {} : { submitter }),
      defaultPrevented: false,
      preventDefault: () => {
        event.defaultPrevented = true;
      },
    };
    for (const listener of listeners.submit ?? []) listener(event);
    return event;
  };
  const restore = (persisted: boolean): void => {
    for (const listener of listeners.pageshow ?? []) listener({ persisted });
  };
  const tick = (): void => {
    for (const run of timers.splice(0)) run();
  };
  return { form, submit, restore, tick };
}

describe("the pending script", () => {
  it("keeps a button the page disabled itself disabled when the page comes back", () => {
    const page = boot();
    const form = page.form("post", ["Merge", "Other"]);
    const [merge, other] = form.buttons;
    if (other !== undefined) other.disabled = true;
    page.submit(form, merge);
    page.tick();

    page.restore(true);

    expect(merge?.disabled).toBe(false);
    expect(other?.disabled).toBe(true);
  });

  it("is served from a script address", () => {
    expect(PENDING_SCRIPT_PATH).toBe("/assets/pending.js");
  });

  it("marks the pressed button pending at once and disables the form's buttons", () => {
    const page = boot();
    const admit = page.form("post", ["Admit"]);
    const button = admit.buttons[0];

    const event = page.submit(admit);

    expect(event.defaultPrevented).toBe(false);
    expect(button?.classes.has("pending")).toBe(true);
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(admit.getAttribute("aria-busy")).toBe("true");
    // The pressed button still sends its own name and value with this submission.
    expect(button?.disabled).toBe(false);
    page.tick();
    expect(button?.disabled).toBe(true);
  });

  it("refuses a second submission of the same form while the first is under way", () => {
    const page = boot();
    const admit = page.form("post");
    page.submit(admit);

    const again = page.submit(admit);

    expect(again.defaultPrevented).toBe(true);
  });

  it("leaves a form alone that does not POST", () => {
    const page = boot();
    const filter = page.form("get", ["Apply"]);
    const dialog = page.form("dialog", ["Cancel"]);

    page.submit(filter);
    page.submit(dialog);
    page.tick();

    expect(filter.buttons[0]?.disabled).toBe(false);
    expect(dialog.buttons[0]?.classes.has("pending")).toBe(false);
  });

  it("makes the buttons usable again on a page the browser brings back from its cache", () => {
    const page = boot();
    const admit = page.form("post");
    const button = admit.buttons[0];
    page.submit(admit);
    page.tick();

    page.restore(true);

    expect(button?.disabled).toBe(false);
    expect(button?.classes.has("pending")).toBe(false);
    expect(button?.hasAttribute("aria-disabled")).toBe(false);
    expect(admit.hasAttribute("aria-busy")).toBe(false);
    expect(page.submit(admit).defaultPrevented).toBe(false);
  });
});
