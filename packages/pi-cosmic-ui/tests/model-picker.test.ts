import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  createModelPickerChoices,
  makeModelPickerPage,
  modelSelector,
  type ModelPickerModel,
} from "../src/manager/model-picker.ts";

// SAFETY: The pure picker renderer uses only these Theme methods.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

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
  it("starts scoped and switches to all authenticated models with Tab", () => {
    const select = vi.fn();
    const page = makeModelPickerPage({
      theme,
      scopedModels: scoped,
      allModels: all,
      current: modelSelector(scoped[0]!),
      getHeight: () => 14,
      requestRender: vi.fn(),
      select,
      cancel: vi.fn(),
    });
    expect(page.activeScope).toBe("scoped");
    page.handleInput("\t");
    expect(page.activeScope).toBe("all");
    page.handleInput("j");
    page.handleInput("\r");
    expect(select).toHaveBeenCalledWith(all[1]);
  });

  it("keeps a hidden stable identity across filtering and scope changes", () => {
    const select = vi.fn();
    const page = makeModelPickerPage({
      theme,
      scopedModels: scoped,
      allModels: all,
      current: "anthropic/claude-opus",
      getHeight: () => 12,
      requestRender: vi.fn(),
      select,
      cancel: vi.fn(),
    });
    page.handleInput("/");
    page.handleInput("gpt");
    page.handleInput("\x1b");
    page.handleInput("\t");
    page.handleInput("\r");

    expect(select).toHaveBeenCalledWith(all[1]);
  });

  it("keeps unavailable rows visible but prevents selection", () => {
    const select = vi.fn();
    const page = makeModelPickerPage({
      theme,
      scopedModels: [
        {
          provider: "openai",
          id: "unavailable",
          available: false,
          unavailableReason: "Requires another runtime",
        },
      ],
      getHeight: () => 12,
      requestRender: vi.fn(),
      select,
      cancel: vi.fn(),
    });

    expect(page.render(80).join("\n")).toContain("unavailable");
    page.handleInput("\r");
    expect(select).not.toHaveBeenCalled();
    expect(page.render(80).join("\n")).toContain("Requires another runtime");
  });

  it("refreshes caller snapshots without losing the selected identity", () => {
    const select = vi.fn();
    const page = makeModelPickerPage({
      theme,
      scopedModels: scoped,
      allModels: all,
      current: "anthropic/claude-opus",
      getHeight: () => 12,
      requestRender: vi.fn(),
      select,
      cancel: vi.fn(),
    });

    page.refreshCatalogs({ scopedModels: [], allModels: [...all] });
    page.handleInput("\r");

    expect(page.activeScope).toBe("all");
    expect(select).toHaveBeenCalledWith(all[1]);
  });

  it("keeps search active across scope changes and bounds every width", () => {
    const page = makeModelPickerPage({
      theme,
      scopedModels: scoped,
      allModels: all,
      getHeight: () => 12,
      requestRender: vi.fn(),
      select: vi.fn(),
      cancel: vi.fn(),
    });
    page.handleInput("/");
    page.handleInput("claude");
    page.handleInput("\t");
    page.handleInput("\r");

    for (const width of [0, 1, 2, 3, 20, 30, 40, 59, 60, 71, 72, 92, 99, 100, 120])
      expect(page.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  });
});
