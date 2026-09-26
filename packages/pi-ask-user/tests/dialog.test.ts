import { initTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { deferredPromise, opaqueFixture, plainTheme as theme } from "pi-cosmic-core/testing";
import { cancelled, submitted } from "./support/questionnaire.ts";
import { expectWithin, pageViews } from "./support/viewport.ts";
import { CURSOR_MARKER, type KeyId, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";
import { AskUserDialog } from "../src/ui/dialog.ts";

beforeAll(() => initTheme("dark", false));

const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";
const EXTERNAL_EDITOR = "\x07";

const request = (mode: "single" | "multiple" = "single") =>
  ({
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
  }) satisfies AskUserRequest;

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

const keybindings: KeybindingsManager = opaqueFixture({
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
  const collapse = vi.fn();
  const tui: TUI = opaqueFixture({
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
    collapse,
  });
  return { dialog, done, collapse };
};

const typeText = (dialog: AskUserDialog, value: string): void => {
  for (const character of value) dialog.handleInput(character);
};

const openCustomInput = (dialog: AskUserDialog): void => {
  dialog.handleInput(DOWN);
  dialog.handleInput(DOWN);
  dialog.handleInput(ENTER);
};

const textRequest: AskUserRequest = {
  questions: [
    { key: "details", title: "Details", prompt: "Describe the requirement.", mode: "text" },
  ],
};

describe("AskUserDialog", () => {
  it("opens text input directly, preserves literal shortcuts and drafts across escape, notes, hide and review", () => {
    const { dialog, done, collapse } = makeDialog(textRequest);
    dialog.focused = true;
    typeText(dialog, "bq1234");
    dialog.handleInput("\x1b[200~\nnext line\x1b[201~");
    expect(collapse).not.toHaveBeenCalled();
    expect(dialog.render(30).join("\n")).toContain(CURSOR_MARKER);
    dialog.handleInput(ESCAPE);
    dialog.handleInput("b");
    expect(collapse).toHaveBeenCalledOnce();
    dialog.handleInput("n");
    typeText(dialog, "context");
    dialog.handleInput(ENTER);
    dialog.handleInput(ENTER);
    dialog.handleInput(ENTER);
    expect(done).not.toHaveBeenCalled();
    dialog.handleInput("\x1b[D");
    dialog.handleInput(ENTER);
    typeText(dialog, " revised");
    dialog.handleInput(ENTER);
    expect(done).not.toHaveBeenCalled();
    dialog.handleInput(ENTER);
    expect(done).toHaveBeenCalledWith(
      submitted({
        key: "details",
        kind: "text",
        text: "bq1234\nnext line revised",
        note: "context",
      }),
    );
  });

  it("retries blank and over-limit text without truncation and accepts the exact bound", () => {
    const replacement = "x".repeat(4001);
    const { dialog, done } = makeDialog(
      textRequest,
      () => Promise.resolve(replacement),
      () => 5,
    );
    dialog.focused = true;
    dialog.handleInput(ENTER);
    expect(dialog.render(30).join("\n")).toContain(CURSOR_MARKER);
    dialog.handleInput(EXTERNAL_EDITOR);
    return Promise.resolve().then(() => {
      dialog.handleInput(ENTER);
      expect(done).not.toHaveBeenCalled();
      expect(dialog.render(30).join("\n")).toContain(CURSOR_MARKER);
      dialog.handleInput("\x7f");
      dialog.handleInput(ENTER);
      expect(done).not.toHaveBeenCalled();
      dialog.handleInput(ENTER);
      expect(done).toHaveBeenCalledWith(
        submitted({ key: "details", kind: "text", text: replacement.slice(0, 4000) }),
      );
    });
  });

  it("enters a later text question directly and discards text on cancellation", () => {
    const { dialog, done } = makeDialog({
      questions: [...request().questions, ...textRequest.questions],
    });
    dialog.handleInput("1");
    typeText(dialog, "bq");
    dialog.handleInput(ENTER);
    expect(done).not.toHaveBeenCalled();
    dialog.handleInput(ESCAPE);
    expect(done).toHaveBeenCalledWith(cancelled);
  });
  it("navigates six questions and submits every answer in a narrow dialog", () => {
    const questions = Array.from({ length: 6 }, (_, index) => ({
      key: `question-${index + 1}`,
      title: `Question ${index + 1}`,
      prompt: `Answer question ${index + 1}?`,
      mode: "text" as const,
    }));
    const { dialog, done } = makeDialog({ questions }, undefined, () => 8);
    dialog.focused = true;
    for (let index = 0; index < questions.length; index++) {
      expectWithin(dialog.render(24), 24, 8);
      dialog.handleInput(ENTER);
      typeText(dialog, `answer-${index + 1}`);
      dialog.handleInput(ENTER);
    }
    expect(done).not.toHaveBeenCalled();
    dialog.handleInput(ENTER);
    expect(done).toHaveBeenCalledWith(
      submitted(
        ...questions.map((question, index) => ({
          key: question.key,
          kind: "text" as const,
          text: `answer-${index + 1}`,
        })),
      ),
    );
  });

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
    const views = pageViews(dialog, 40, 100, { height });
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
    expect(done).toHaveBeenCalledWith(
      submitted({ key: "approach", kind: "choices", values: ["second"], labels: ["Second"] }),
    );
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
      expectWithin(lines, width, height);
      expect(lines.join("\n")).toContain(CURSOR_MARKER);
    }
    dialog.focused = false;
    expect(dialog.render(30).join("\n")).not.toContain(CURSOR_MARKER);
    dialog.focused = true;
    dialog.handleInput(ENTER);
    expect(dialog.render(30).join("\n")).not.toContain(CURSOR_MARKER);
    dialog.handleInput(ENTER);
    expect(done).toHaveBeenCalledWith(submitted({ key: "approach", kind: "custom", text }));
  });

  it.each([
    [0, 10],
    [10, 0],
    [1, 1],
    [2, 2],
  ])("bounds a tiny questionnaire at %i by %i without changing its answer", (width, height) => {
    const { dialog, done } = makeDialog(request(), undefined, () => height);
    expectWithin(dialog.render(width), width, height);
    dialog.handleInput("1");
    dialog.handleInput(ENTER);
    expect(done).toHaveBeenCalledWith(
      submitted({ key: "approach", kind: "choices", values: ["first"], labels: ["First"] }),
    );
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

    expect(done).toHaveBeenCalledWith(submitted({ key: "approach", kind: "custom", text: "q" }));
  });

  it("suppresses concurrent external editors and ignores a result for a replaced input", () => {
    const external = deferredPromise<string | undefined>();
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

      expect(done).toHaveBeenCalledWith(
        submitted({ key: "approach", kind: "custom", text: "fresh" }),
      );
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

    expect(done).toHaveBeenCalledWith(
      submitted({
        key: "approach",
        kind: "choices",
        values: ["first", "second"],
        labels: ["First", "Second"],
        note: "Keep both paths.",
      }),
    );
  });

  it.each([24, 120])("keeps every rendered line within width %i", (width) => {
    expectWithin(makeDialog().dialog.render(width), width);
  });
});
