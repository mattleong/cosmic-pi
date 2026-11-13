import * as Arr from "effect/Array";
import { describe, expect, it, vi } from "vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import {
  createModelPickerChoices,
  ModelPickerPage,
  modelSelector,
  type ModelPickerModel,
  type ModelPickerPageOptions,
} from "../src/manager/model-picker.ts";

const scoped: ModelPickerModel[] = [
  {
    provider: "openai-codex",
    id: "gpt-5.4",
    name: "GPT 5.4",
    reasoning: true,
    supportedEfforts: ["low", "high"],
  },
];
const all: ModelPickerModel[] = [...scoped, { provider: "anthropic", id: "claude-opus" }];

describe("model picker projection", () => {
  it("uses canonical identities and terminal-safe searchable rows", () => {
    expect(modelSelector(scoped[0]!)).toBe("openai-codex/gpt-5.4");
    const choices = createModelPickerChoices([
      { provider: "hostile\nprovider", id: "model\x1b[2J" },
    ]);
    expect(choices[0]?.value).not.toContain("\n");
    expect(choices[0]?.value).not.toContain("\x1b");
    expect(choices[0]?.item.label).not.toContain("\n");
    expect(choices[0]?.item.label).not.toContain("\x1b");
  });
});

const picker = (overrides: Partial<ModelPickerPageOptions<ModelPickerModel>> = {}) => {
  const select = vi.fn();
  const cancel = vi.fn();
  const page = new ModelPickerPage({
    theme: plainTheme,
    scopedModels: scoped,
    allModels: all,
    getHeight: () => 12,
    requestRender: vi.fn(),
    select,
    cancel,
    ...overrides,
  });
  return { page, select, cancel };
};

describe("ModelPickerPage", () => {
  it("keeps a hidden stable identity across filtering and scope changes", () => {
    const { page, select } = picker({ current: "anthropic/claude-opus" });
    page.handleInput("/");
    page.handleInput("gpt");
    page.handleInput("\x1b");
    page.handleInput("\t");
    page.handleInput("\r");

    expect(select).toHaveBeenCalledWith(all[1]);
  });

  it("prevents selecting unavailable rows", () => {
    const { page, select } = picker({
      allModels: undefined,
      scopedModels: [
        {
          provider: "openai",
          id: "unavailable",
          available: false,
          unavailableReason: "Requires another runtime",
        },
      ],
    });

    page.handleInput("\r");
    expect(select).not.toHaveBeenCalled();
  });
});

describe("model picker groups", () => {
  const models: ModelPickerModel[] = [
    { provider: "profile", id: "parent", selector: "parent", label: "inherit", pinned: true },
    { provider: "openai-codex", id: "gpt-6-luna" },
    { provider: "anthropic", id: "claude-opus" },
    { provider: "openai-codex", id: "gpt-6-sol" },
  ];

  it("lists models under their provider, with pinned rows first", () => {
    const choices = createModelPickerChoices(models);
    expect(choices[0]?.group).toBeUndefined();
    expect(Arr.map(choices.slice(1), (choice) => choice.group)).toEqual([
      "openai-codex",
      "anthropic",
      "openai-codex",
    ]);
    expect(choices[1]?.item.label).not.toContain("openai-codex");
    const { page, select } = picker({
      scopedModels: models,
      allModels: undefined,
      getHeight: () => 20,
    });
    page.handleInput("j");
    page.handleInput("j");
    page.handleInput("\r");
    expect(select).toHaveBeenLastCalledWith(models[3]);
  });

  it("still finds a model by its whole provider/model selector", () => {
    const { page, select } = picker({
      scopedModels: models,
      allModels: undefined,
      initialSearchMode: true,
      getHeight: () => 20,
    });
    for (const key of "anthropic/claude") page.handleInput(key);
    page.handleInput("\r");
    expect(select).toHaveBeenLastCalledWith(models[2]);
  });
});
