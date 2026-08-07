import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  visibleWidth,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { AskUserDialog } from "../src/ui/dialog.ts";
import type { AskUserRequest } from "../src/tools/schema.ts";

const request: AskUserRequest = {
  questions: [
    {
      key: "approach",
      title: "Approach",
      prompt: "Which implementation approach should we take?",
      mode: "single",
      choices: [
        {
          value: "safe",
          label: "Safe migration",
          description: "Make the smallest reversible change.",
        },
        { value: "rewrite", label: "Rewrite", description: "Replace the subsystem in one pass." },
      ],
    },
  ],
};

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const keybindings = {
  matches: (data: string, id: string) => {
    if (id === "tui.select.up") return matchesKey(data, Key.up);
    if (id === "tui.select.down") return matchesKey(data, Key.down);
    if (id === "tui.select.confirm") return matchesKey(data, Key.enter);
    if (id === "tui.select.cancel") return matchesKey(data, Key.escape);
    return false;
  },
} as unknown as KeybindingsManager;

const make = (
  dialogKeybindings: KeybindingsManager = keybindings,
  dialogRequest: AskUserRequest = request,
) => {
  const done = vi.fn();
  const requestRender = vi.fn();
  const dialog = new AskUserDialog({
    tui: { requestRender, terminal: { rows: 24, columns: 80 } } as unknown as TUI,
    theme,
    keybindings: dialogKeybindings,
    request: dialogRequest,
    done,
    editExternally: () => Promise.resolve(undefined),
    onCollapse: vi.fn(),
  });
  return { dialog, done, requestRender };
};

describe("ask-user TUI", () => {
  it("renders width-safe layouts and submits a selected value", () => {
    const { dialog, done } = make();
    for (const width of [120, 48, 12]) {
      expect(dialog.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }

    dialog.handleInput("\r");
    expect(done).not.toHaveBeenCalled();
    dialog.handleInput("\r");
    expect(done).toHaveBeenCalledWith({
      outcome: "submitted",
      answers: [{ key: "approach", kind: "choices", values: ["safe"], labels: ["Safe migration"] }],
    });
  });

  it("supports numbered choice shortcuts and shows question progress", () => {
    const { dialog, done } = make();
    expect(dialog.render(80).join("\n")).toContain("Question 1 of 1 • 0 of 1 answered");
    expect(dialog.render(80).join("\n")).toContain("1–2 choose");
    expect(dialog.render(80).join("\n")).not.toContain("Space toggle");

    dialog.handleInput("\u001b[50u");
    expect(dialog.render(80).join("\n")).toContain("✓ Approach: Rewrite");
    dialog.handleInput("\r");
    expect(done).toHaveBeenCalledWith({
      outcome: "submitted",
      answers: [{ key: "approach", kind: "choices", values: ["rewrite"], labels: ["Rewrite"] }],
    });
  });

  it("shows multi-select counts and keeps Continue disabled without a selection", () => {
    const multipleRequest: AskUserRequest = {
      questions: [{ ...request.questions[0]!, mode: "multiple" }],
    };
    const { dialog } = make(keybindings, multipleRequest);
    expect(dialog.render(80).join("\n")).toContain("→ Continue (0 selected)");
    expect(dialog.render(80).join("\n")).toContain("Space toggle");

    dialog.handleInput("2");
    expect(dialog.render(80).join("\n")).toContain("> [x] 2. Rewrite");
    expect(dialog.render(80).join("\n")).toContain("→ Continue (1 selected)");
    dialog.handleInput("\u001b[50;1:2u");
    expect(dialog.render(80).join("\n")).toContain("→ Continue (1 selected)");
    dialog.handleInput("2");
    dialog.handleInput("\u001b[B");
    dialog.handleInput("\u001b[B");
    dialog.handleInput("\r");
    expect(dialog.render(80).join("\n")).toContain(
      "Select at least one choice or write a custom answer.",
    );
  });

  it("exposes note actions and live character counts", () => {
    const { dialog } = make();
    expect(dialog.render(80).join("\n")).toContain("n Add an optional note");
    dialog.handleInput("n");
    expect(dialog.render(80).join("\n")).toContain("0 / 2000 characters");
    for (const character of "abc") dialog.handleInput(character);
    expect(dialog.render(80).join("\n")).toContain("3 / 2000 characters");
    dialog.handleInput("\r");
    expect(dialog.render(80).join("\n")).toContain("n Edit note — abc");

    dialog.handleInput("\u001b[B");
    dialog.handleInput("\u001b[B");
    dialog.handleInput("\r");
    expect(dialog.render(80).join("\n")).toContain("0 / 4000 characters");
  });

  it("highlights unanswered review items and jumps to the first one", () => {
    const reviewRequest: AskUserRequest = {
      questions: [
        request.questions[0]!,
        {
          ...request.questions[0]!,
          key: "rollout",
          title: "Rollout",
          prompt: "How should we roll this out?",
        },
      ],
    };
    const { dialog } = make(keybindings, reviewRequest);
    dialog.handleInput("1");
    dialog.handleInput("l");
    const review = dialog.render(80).join("\n");
    expect(review).toContain("Review • 1 of 2 answered");
    expect(review).toContain("✓ Approach: Safe migration");
    expect(review).toContain("! Rollout: Unanswered");
    expect(review).toContain("Answer next unanswered");
    expect(review).toContain("Enter open unanswered");

    dialog.handleInput("\r");
    const question = dialog.render(80).join("\n");
    expect(question).toContain("Question 2 of 2");
    expect(question).toContain("Answer this question to finish.");
  });

  it("uses Vim aliases only while the editor is inactive", () => {
    const { dialog, done } = make();
    dialog.handleInput("j");
    expect(dialog.render(80).join("\n")).toContain("> [ ] 2. Rewrite");
    dialog.handleInput("q");
    expect(done).not.toHaveBeenCalled();
    dialog.handleInput("\u001b[106u");
    expect(dialog.render(80).join("\n")).toContain("> ✎ Write a custom answer");
    dialog.handleInput("\r");
    for (const character of "hjklqgGs") dialog.handleInput(character);
    expect(dialog.render(80).join("\n")).toContain("hjklqgGs");
    expect(done).not.toHaveBeenCalled();
  });

  it("keeps printable configured cancel keys typeable and reserves the note shortcut", () => {
    const printableCancel = {
      matches: (data: string, id: Parameters<KeybindingsManager["matches"]>[1]) =>
        id === "tui.select.cancel"
          ? data === "q" || data === "n" || matchesKey(data, Key.escape)
          : keybindings.matches(data, id),
    } as unknown as KeybindingsManager;
    const { dialog, done } = make(printableCancel);
    dialog.handleInput("\u001b[110u");
    expect(dialog.render(80).join("\n")).toContain("Note");
    dialog.handleInput("q");
    expect(dialog.render(80).join("\n")).toContain("q");
    expect(done).not.toHaveBeenCalled();
  });

  it("collapses through the mounted overlay without a terminal input listener", () => {
    const { dialog } = make();
    const handle = {
      setHidden: vi.fn(),
      unfocus: vi.fn(),
      focus: vi.fn(),
      isHidden: vi.fn(),
      isFocused: vi.fn(),
      hide: vi.fn(),
    } as unknown as OverlayHandle;
    dialog.setOverlayHandle(handle);
    dialog.handleInput("b");
    expect(handle.setHidden).toHaveBeenCalledWith(true);
    expect(handle.unfocus).toHaveBeenCalledOnce();
    dialog.resume();
    expect(handle.setHidden).toHaveBeenCalledWith(false);
    expect(handle.focus).toHaveBeenCalledOnce();
    dialog.handleInput("\u001b[98u");
    expect(handle.setHidden).toHaveBeenCalledTimes(3);
    expect(handle.setHidden).toHaveBeenLastCalledWith(true);
  });
});
