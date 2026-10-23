import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  deferredPromise,
  keybindingsFixture,
  plainTheme as theme,
  terminalFixture,
  tuiFixture,
} from "pi-cosmic-core/testing";
import { submitted } from "./support/questionnaire.ts";
import { CURSOR_MARKER, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { it as effectIt } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";
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

const KEY_BINDINGS = new Map<string, KeyId>([
  ["tui.select.up", "up"],
  ["tui.select.down", "down"],
  ["tui.select.pageUp", "pageUp"],
  ["tui.select.pageDown", "pageDown"],
  ["tui.select.confirm", "enter"],
  ["tui.select.cancel", "escape"],
  ["app.editor.external", "ctrl+g"],
]);

const keybindings = keybindingsFixture({
  matches(data, id) {
    const key = KEY_BINDINGS.get(id);
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
  const tui = tuiFixture({
    requestRender: vi.fn(),
    terminal: terminalFixture({ rows: 60, columns: 120 }),
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

const rendered = (dialog: AskUserDialog, width: number): string =>
  Arr.join(dialog.render(width), "\n");

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
  it("picks each of six choices by its digit shortcut", () => {
    const choices = Array.from({ length: 6 }, (_, index) => ({
      value: `v${index + 1}`,
      label: `Choice ${index + 1}`,
      description: "A concrete option.",
    }));
    const { dialog, done } = makeDialog({
      questions: [{ key: "pick", title: "Pick", prompt: "Pick one.", mode: "single", choices }],
    });
    dialog.handleInput("6");
    dialog.handleInput(ENTER);
    expect(done).toHaveBeenCalledWith(
      submitted({ key: "pick", kind: "choices", values: ["v6"], labels: ["Choice 6"] }),
    );
  });

  it("opens text input directly, preserves literal shortcuts and drafts across escape, notes, hide and review", () => {
    const { dialog, done, collapse } = makeDialog(textRequest);
    dialog.focused = true;
    typeText(dialog, "bq1234");
    dialog.handleInput("\x1b[200~\nnext line\x1b[201~");
    expect(collapse).not.toHaveBeenCalled();
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

  effectIt.effect(
    "suppresses concurrent external editors and ignores a result for a replaced input",
    () =>
      Effect.gen(function* () {
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

        yield* Effect.promise(() => external.promise);
        dialog.handleInput(ENTER);
        dialog.handleInput(ENTER);

        expect(done).toHaveBeenCalledWith(
          submitted({ key: "approach", kind: "custom", text: "fresh" }),
        );
      }),
  );

  effectIt.effect("shows the external editor's state and result without further input", () =>
    Effect.gen(function* () {
      const external = deferredPromise<string | undefined>();
      const { dialog } = makeDialog(request(), () => external.promise);
      openCustomInput(dialog);
      const idle = dialog.render(100);

      dialog.handleInput(EXTERNAL_EDITOR);
      expect(dialog.render(100)).not.toEqual(idle);

      external.resolve("written in the editor");
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(rendered(dialog, 100)).toContain("written in the editor")),
      );
    }),
  );

  it("shows the focused choice's own preview at every width", () => {
    const { dialog } = makeDialog({
      questions: [
        {
          key: "layout",
          title: "Layout",
          prompt: "Pick a layout.",
          mode: "single",
          choices: [
            { value: "grid", label: "Grid", description: "Tiles.", preview: "Grid preview body" },
            { value: "list", label: "List", description: "Rows.", preview: "List preview body" },
          ],
        },
      ],
    });
    expect(rendered(dialog, 120)).toContain("Grid preview body");
    dialog.handleInput(DOWN);
    for (const width of [120, 80, 120]) {
      expect(rendered(dialog, width)).toContain("List preview body");
      expect(rendered(dialog, width)).not.toContain("Grid preview body");
    }
  });

  it("places the input cursor only while the dialog has focus", () => {
    const { dialog } = makeDialog(textRequest);
    const hasCursor = () => Arr.some(dialog.render(100), Str.includes(CURSOR_MARKER));
    expect(hasCursor()).toBe(false);
    dialog.focused = true;
    expect(hasCursor()).toBe(true);
    dialog.focused = false;
    expect(hasCursor()).toBe(false);
  });
});
