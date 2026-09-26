import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import {
  createModelPickerChoices,
  makeModelPickerPage,
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
    const page = makeModelPickerPage({
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

  it("can opt into immediate typing without changing default navigation", () => {
    const { page, select } = picker({
      scopedModels: [],
      initialSearchMode: true,
      current: modelSelector(scoped[0]!),
      getHeight: () => 14,
    });
    page.focused = true;
    page.handleInput("claude");
    page.handleInput("\r");
    expect(select).toHaveBeenCalledWith(all[1]);
  });

  it("uses injected cancellation for immediate search without swallowing typed keys", () => {
    const { page, cancel } = picker({
      allModels: undefined,
      initialSearchMode: true,
      getHeight: () => 14,
      matchesKeybinding: (data, id) =>
        id === "tui.select.cancel" && (data === "\u001b[17~" || data === "s"),
    });
    page.handleInput("s");
    expect(cancel).not.toHaveBeenCalled();
    page.handleInput("\u001b[17~");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("starts scoped and switches to all authenticated models with Tab", () => {
    const { page, select } = picker({ current: modelSelector(scoped[0]!), getHeight: () => 14 });
    expect(page.activeScope).toBe("scoped");
    page.handleInput("\t");
    expect(page.activeScope).toBe("all");
    page.handleInput("j");
    page.handleInput("\r");
    expect(select).toHaveBeenCalledWith(all[1]);
  });

  it("keeps a hidden stable identity across filtering and scope changes", () => {
    const { page, select } = picker({ current: "anthropic/claude-opus" });
    page.handleInput("/");
    page.handleInput("gpt");
    page.handleInput("\x1b");
    page.handleInput("\t");
    page.handleInput("\r");

    expect(select).toHaveBeenCalledWith(all[1]);
  });

  it("keeps unavailable rows visible but prevents selection", () => {
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

    expect(page.render(80).join("\n")).toContain("unavailable");
    page.handleInput("\r");
    expect(select).not.toHaveBeenCalled();
    expect(page.render(80).join("\n")).toContain("Requires another runtime");
  });

  it("keeps search active across scope changes and bounds every width", () => {
    const { page } = picker();
    page.handleInput("/");
    page.handleInput("claude");
    page.handleInput("\t");
    page.handleInput("\r");

    for (const width of [0, 1, 2, 3, 20, 30, 40, 59, 60, 71, 72, 92, 99, 100, 120])
      expect(page.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  });
});
