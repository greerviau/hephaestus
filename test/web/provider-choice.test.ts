import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { PROVIDER_CHOICE_SCRIPT } from "../../src/web/provider-choice.js";

interface FakeOption {
  value: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  selected: boolean;
  group: string | null;
  getAttribute(name: string): string | null;
}

interface FakeSelect {
  options: FakeOption[];
  readonly value: string;
  selectedIndex: number;
  attributes: Record<string, string>;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  closest(selector: string): unknown;
}

function option(value: string, group: string | null, chosen: string, shown: string): FakeOption {
  return {
    value,
    textContent: value === "" ? "placeholder" : value,
    hidden: group !== shown,
    disabled: group !== shown,
    selected: value === chosen && group === shown,
    group,
    getAttribute: (name) => (name === "data-for" ? group : null),
  };
}

/** A selector as the Models tab renders it: a placeholder, then each provider's values. */
function select(
  groups: Record<string, string[]>,
  chosen: string,
  shown: string,
  attributes: Record<string, string> = {},
): FakeSelect {
  const options = [
    option("", null, chosen, shown),
    ...Object.entries(groups).flatMap(([group, values]) =>
      values.map((value) => option(value, group, chosen, shown)),
    ),
  ];
  if (!options.some((each) => each.selected) && options[0] !== undefined)
    options[0].selected = true;
  const node: FakeSelect = {
    options,
    attributes,
    get value() {
      return options.find((each) => each.selected)?.value ?? "";
    },
    get selectedIndex() {
      return options.findIndex((each) => each.selected);
    },
    set selectedIndex(index: number) {
      options.forEach((each, at) => (each.selected = at === index));
    },
    hasAttribute: (name) => name in attributes,
    getAttribute: (name) => attributes[name] ?? null,
    closest: () => null,
  };
  return node;
}

/** The setup row, saved with a Claude instance, model, and effort, and the script running. */
function setupRow() {
  const instance = select(
    { "": [], claude: ["claudeAgent"], codex: ["codex"] },
    "claudeAgent",
    "claude",
  );
  const model = select(
    { claude: ["claude-sonnet-5-5", "claude-opus-5-5"], codex: ["gpt-6.2-sol", "gpt-6.1-sol"] },
    "claude-sonnet-5-5",
    "claude",
  );
  const effort = select(
    { claude: ["low", "high", "ultrathink"], codex: ["low", "high", "ultra"] },
    "high",
    "claude",
    { "data-placeholder": "Select effort", "data-placeholder-none": "No effort levels" },
  );
  const row = { querySelectorAll: () => [instance, model, effort] };
  const provider = {
    value: "claude",
    hasAttribute: (name: string) => name === "data-provider",
    closest: () => row,
  };
  let listener: ((event: unknown) => void) | undefined;
  runInNewContext(PROVIDER_CHOICE_SCRIPT, {
    document: {
      addEventListener: (_type: string, on: (event: unknown) => void) => {
        listener = on;
      },
    },
  });
  const choose = (value: string): void => {
    provider.value = value;
    listener?.({ target: provider });
  };
  const shown = (node: FakeSelect): string[] =>
    node.options
      .filter((each) => each.group !== null && !each.hidden && !each.disabled)
      .map((each) => each.value);
  return { instance, model, effort, choose, shown };
}

describe("the provider choice script", () => {
  it("shows only the new provider's instances, models, and levels when the provider changes", () => {
    const row = setupRow();

    row.choose("codex");

    expect(row.shown(row.instance)).toEqual(["codex"]);
    expect(row.shown(row.model)).toEqual(["gpt-6.2-sol", "gpt-6.1-sol"]);
    expect(row.shown(row.effort)).toEqual(["low", "high", "ultra"]);
  });

  it("clears an instance and model the new provider does not offer, and keeps a level it does", () => {
    const row = setupRow();

    row.choose("codex");

    expect(row.instance.value).toBe("");
    expect(row.model.value).toBe("");
    expect(row.effort.value).toBe("high");
    expect(row.effort.options[row.effort.selectedIndex]?.group).toBe("codex");
  });

  it("clears a level the new provider does not offer", () => {
    const row = setupRow();
    row.effort.selectedIndex = row.effort.options.findIndex((each) => each.value === "ultrathink");

    row.choose("codex");

    expect(row.effort.value).toBe("");
    expect(row.effort.options[0]?.textContent).toBe("Select effort");
  });

  it("says a provider with no levels has none", () => {
    const row = setupRow();

    row.choose("");

    expect(row.shown(row.effort)).toEqual([]);
    expect(row.effort.options[0]?.textContent).toBe("No effort levels");
  });
});
