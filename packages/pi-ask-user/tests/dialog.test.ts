import { initTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { controlled as controllable, opaqueHostFixture, theme } from "./support/host.ts";
import {
  CURSOR_MARKER,
  type KeyId,
  matchesKey,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";
import { AskUserDialog } from "../src/ui/dialog.ts";

beforeAll(() => initTheme("dark", false));

const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";
const EXTERNAL_EDITOR = "\x07";

const request = (mode: "single" | "multiple" = "single"): AskUserRequest => ({
  questions: [
    {
      key: "approach",
      title: "Approach",
      prompt: "Which implementation approach should we use for this change?",
      mode,
      choices: [
        { value: "first", label: "First", description: "First option.", preview: "First" },
        { value: "second", label: "Second", description: "Use the second authored option." },
      ],
    },
  ],
});

interface KeybindingFixture extends Readonly<Record<string, KeyId | undefined>> {}
const KEY_BINDINGS: KeybindingFixture = {
  "tui.select.up": "up",
  "tui.select.down": "down",
  "tui.select.pageUp": "pageUp",
  "tui.select.pageDown": "pageDown",
  "tui.select.confirm": "enter",
  "tui.select.cancel": "escape",
  "app.editor.external": "ctrl+g",
};

const keybindings: KeybindingsManager = opaqueHostFixture({
  matches(data: string, id: string) {
    const key = KEY_BINDINGS[id];
    return key !== undefined && matchesKey(data, key);
  },
});

const makeDialog = (
  selectedRequest: AskUserRequest = request(),
  editExternally: (value: string) => Promise<string | undefined> = () => Promise.resolve(undefined),
  getHeight: () => number = () => Infinity,
) => {
  const done = vi.fn<(outcome: AskUserOutcome) => void>();
  const tui: TUI = opaqueHostFixture({
    requestRender: vi.fn(),
    terminal: { rows: 60, columns: 120 },
  });
  const dialog = new AskUserDialog({
    tui,
    theme,
    keybindings,
    request: selectedRequest,
    getHeight,
    done,
    editExternally,
    onCollapse: vi.fn(),
  });
  return { dialog, done };
};

const typeText = (dialog: AskUserDialog, value: string): void => {
  for (const character of value) dialog.handleInput(character);
};

const openCustomInput = (dialog: AskUserDialog): void => {
  dialog.handleInput(DOWN);
  dialog.handleInput(DOWN);
  dialog.handleInput(ENTER);
};

describe("AskUserDialog", () => {
  it("keeps validation feedback visible beside a clipped custom editor", () => {
    const base = request();
    let height = 9;
    const { dialog, done } = makeDialog(
      { questions: [{ ...base.questions[0]!, prompt: "long prompt ".repeat(40) }] },
      undefined,
      () => height,
    );
    dialog.focused = true;
    openCustomInput(dialog);
    const before = dialog.render(40);
    dialog.handleInput(ENTER);
    const invalid = dialog.render(40);
    expect(invalid.at(-1)).not.toBe(before.at(-1));
    expect(invalid.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
    expect(done).not.toHaveBeenCalled();
    const feedback = invalid.at(-1);
    height = 4;
    dialog.handleInput("\x1b[6~");
    const resized = dialog.render(40);
    expect(resized.at(-1)).toBe(feedback);
    expect(resized.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
    expect(resized.length).toBeLessThanOrEqual(height);
    expect(done).not.toHaveBeenCalled();
  });
  it("pages complete prompts and previews and follows choices across resize without changing answers", () => {
    let height = 9;
    const base = request("multiple");
    const question = base.questions[0]!;
    const { dialog, done } = makeDialog(
      {
        questions: [
          {
            ...question,
            prompt: "Prompt start " + "long prompt ".repeat(80) + "PROMPT-END",
            choices: question.choices.map((choice, index) => ({
              ...choice,
              description: "description ".repeat(60) + `DETAIL-END-${index}`,
              preview: index === 0 ? "preview\n".repeat(80) + "PREVIEW-END" : "",
            })),
          },
        ],
      },
      undefined,
      () => height,
    );
    const views: string[] = [];
    dialog.handleInput("\x1b[H");
    for (let page = 0; page < 100; page++) {
      const lines = dialog.render(40);
      expect(lines.length).toBeLessThanOrEqual(height);
      expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
      views.push(lines.join("\n"));
      dialog.handleInput("\x1b[6~");
    }
    expect(views.some((view) => view.includes("PROMPT-END"))).toBe(true);
    expect(views.some((view) => view.includes("PREVIEW-END"))).toBe(true);
    expect(views.some((view) => view.includes("DETAIL-END-1"))).toBe(true);
    dialog.handleInput(DOWN);
    height = 5;
    expect(dialog.render(24).join("\n")).toContain("Second");
    dialog.handleInput(" ");
    dialog.handleInput("\t");
    height = 30;
    dialog.render(100);
    dialog.handleInput(ENTER);
    expect(done).toHaveBeenCalledWith({
      outcome: "submitted",
      answers: [{ key: "approach", kind: "choices", values: ["second"], labels: ["Second"] }],
    });
  });

  it("keeps a long editor cursor visible, preserves text and releases focus across resize", () => {
    let height = 8;
    const { dialog, done } = makeDialog(request(), undefined, () => height);
    dialog.focused = true;
    openCustomInput(dialog);
    const text = "typed content ".repeat(80) + "TAIL";
    dialog.handleInput(`\x1b[200~${text}\x1b[201~`);
    for (const width of [80, 24, 8, 1, 100]) {
      height = width <= 8 ? 1 : 8;
      const lines = dialog.render(width);
      expect(lines.length).toBeLessThanOrEqual(height);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).toContain(CURSOR_MARKER);
    }
    dialog.focused = false;
    expect(dialog.render(30).join("\n")).not.toContain(CURSOR_MARKER);
    dialog.focused = true;
    dialog.handleInput(ENTER);
    expect(dialog.render(30).join("\n")).not.toContain(CURSOR_MARKER);
    dialog.handleInput(ENTER);
    expect(done).toHaveBeenCalledWith({
      outcome: "submitted",
      answers: [{ key: "approach", kind: "custom", text }],
    });
  });

  it.each([
    [0, 10],
    [10, 0],
    [1, 1],
    [2, 2],
  ])("bounds a tiny questionnaire at %i by %i without changing its answer", (width, height) => {
    const { dialog, done } = makeDialog(request(), undefined, () => height);
    const lines = dialog.render(width);
    expect(lines.length).toBeLessThanOrEqual(height);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    dialog.handleInput("1");
    dialog.handleInput(ENTER);
    expect(done).toHaveBeenCalledWith({
      outcome: "submitted",
      answers: [{ key: "approach", kind: "choices", values: ["first"], labels: ["First"] }],
    });
  });

  it("does not pad a short dialog to its height allocation", () => {
    const { dialog } = makeDialog(request(), undefined, () => 100);
    expect(dialog.render(100).length).toBeLessThan(100);
  });
  it("keeps q navigation-only outside text input yet accepts it as custom text", () => {
    const { dialog, done } = makeDialog();

    dialog.handleInput("q");
    expect(done).not.toHaveBeenCalled();

    openCustomInput(dialog);
    dialog.handleInput("q");
    dialog.handleInput(ENTER);
    dialog.handleInput(ENTER);

    expect(done).toHaveBeenCalledWith({
      outcome: "submitted",
      answers: [{ key: "approach", kind: "custom", text: "q" }],
    });
  });

  it("discards completed drafts when cancelled", () => {
    const { dialog, done } = makeDialog();

    dialog.handleInput("1");
    dialog.handleInput(ESCAPE);

    expect(done).toHaveBeenCalledWith({ outcome: "cancelled", answers: [] });
  });

  it("suppresses concurrent external editors and ignores a result for a replaced input", () => {
    const external = controllable<string | undefined>();
    const editExternally = vi.fn(() => external.promise);
    const { dialog, done } = makeDialog(request(), editExternally);
    openCustomInput(dialog);

    dialog.handleInput(EXTERNAL_EDITOR);
    dialog.handleInput(EXTERNAL_EDITOR);
    expect(editExternally).toHaveBeenCalledOnce();

    dialog.handleInput(ESCAPE);
    openCustomInput(dialog);
    typeText(dialog, "fresh");
    external.resolve("stale");

    return external.promise.then(() => {
      dialog.handleInput(ENTER);
      dialog.handleInput(ENTER);

      expect(done).toHaveBeenCalledWith({
        outcome: "submitted",
        answers: [{ key: "approach", kind: "custom", text: "fresh" }],
      });
    });
  });

  it("submits multi-select values in authored order and retains the note", () => {
    const { dialog, done } = makeDialog(request("multiple"));

    dialog.handleInput("2");
    dialog.handleInput("1");
    dialog.handleInput("n");
    typeText(dialog, "Keep both paths.");
    dialog.handleInput(ENTER);
    dialog.handleInput(DOWN);
    dialog.handleInput(DOWN);
    dialog.handleInput(DOWN);
    dialog.handleInput(ENTER);
    dialog.handleInput(ENTER);

    expect(done).toHaveBeenCalledWith({
      outcome: "submitted",
      answers: [
        {
          key: "approach",
          kind: "choices",
          values: ["first", "second"],
          labels: ["First", "Second"],
          note: "Keep both paths.",
        },
      ],
    });
  });

  it.each([24, 120])("keeps every rendered line within width %i", (width) => {
    const { dialog } = makeDialog();

    const lines = dialog.render(width);

    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });
});
