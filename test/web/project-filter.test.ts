import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { PROJECT_FILTER_SCRIPT, PROJECT_FILTER_SCRIPT_PATH } from "../../src/web/project-filter.js";

interface FakeSelect {
  disabled: boolean;
  form: { submits: number; requestSubmit(): void };
  hasAttribute(name: string): boolean;
}

function boot() {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const on = (type: string, listener: (event: unknown) => void): void => {
    (listeners[type] ??= []).push(listener);
  };
  const context = {
    document: { addEventListener: on, querySelectorAll: () => selects },
    window: { addEventListener: on },
  };
  const selects: FakeSelect[] = [];
  runInNewContext(PROJECT_FILTER_SCRIPT, context);
  const fire = (type: string, event: Record<string, unknown>): void => {
    for (const listener of listeners[type] ?? []) listener(event);
  };
  const select = (marked = true): FakeSelect => {
    const form = {
      submits: 0,
      requestSubmit: () => {
        form.submits += 1;
      },
    };
    const node: FakeSelect = {
      disabled: false,
      form,
      hasAttribute: (name) => marked && name === "data-submit-on-change",
    };
    selects.push(node);
    return node;
  };
  return { fire, select };
}

describe("the project filter script", () => {
  it("is served from a script address", () => {
    expect(PROJECT_FILTER_SCRIPT_PATH).toBe("/assets/project-filter.js");
  });

  it("submits the picker's form as soon as the project changes", () => {
    const page = boot();
    const picker = page.select();

    page.fire("change", { target: picker });

    expect(picker.form.submits).toBe(1);
  });

  it("sends one request for quick changes, so an older choice cannot land after a newer one", () => {
    const page = boot();
    const picker = page.select();

    page.fire("change", { target: picker });
    page.fire("change", { target: picker });

    expect(picker.form.submits).toBe(1);
    expect(picker.disabled).toBe(true);
  });

  it("lets the picker be used again when the browser restores the page from its cache", () => {
    const page = boot();
    const picker = page.select();
    page.fire("change", { target: picker });

    page.fire("pageshow", { persisted: true });
    expect(picker.disabled).toBe(false);
    page.fire("change", { target: picker });

    expect(picker.form.submits).toBe(2);
  });

  it("leaves other selects alone", () => {
    const page = boot();
    const other = page.select(false);

    page.fire("change", { target: other });

    expect(other.form.submits).toBe(0);
  });
});
