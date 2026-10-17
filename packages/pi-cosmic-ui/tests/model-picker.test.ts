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
    const choices = createModelPickerChoices(
      [{ provider: "hostile\nprovider", id: "model\x1b[2J" }],
      undefined,
    );
    expect(choices[0]?.value).not.toContain("\n");
    expect(choices[0]?.value).not.toContain("\x1b");
    expect(choices[0]?.item.label).not.toContain("\n");
    expect(choices[0]?.item.label).not.toContain("\x1b");
  });
});

describe("ModelPickerPage", () => {
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
