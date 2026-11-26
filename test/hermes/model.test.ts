import { describe, expect, it } from "vitest";
import { hermesModel } from "../../src/hermes/model.js";

describe("hermesModel", () => {
  it.each([
    ["model:\n  default: claude-sonnet-5\n  provider: anthropic\n", "claude-sonnet-5"],
    ["model:\n  provider: anthropic\n  model: gpt-6.2-sol\n", "gpt-6.2-sol"],
    ["model: claude-sonnet-5\n", "claude-sonnet-5"],
    ['model:\r\n  "default": "claude-sonnet-5" # the main one\r\n', "claude-sonnet-5"],
    ["kanban:\n  x: 1\nmodel:\n  # chosen by hermes model\n  default: 'm-1'\nother: 2\n", "m-1"],
  ])("reads the model from %j", (text, model) => {
    expect(hermesModel(text)).toBe(model);
  });

  it.each([
    ["kanban:\n  auto_decompose: false\n"],
    ["model:\n  default:\n  provider: anthropic\n"],
    ["model:\n  default: null\n"],
    ["model:\n  options:\n    default: nested\n"],
    ["# model:\n#   default: claude\n"],
    ["model: ~\n"],
  ])("finds no model in %j", (text) => {
    expect(hermesModel(text)).toBeUndefined();
  });
});
