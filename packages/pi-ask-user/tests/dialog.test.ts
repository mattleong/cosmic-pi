import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  deferredPromise,
  keybindingsFixture,
  plainTheme as theme,
  terminalFixture,
  tuiFixture,
} from "pi-cosmic-core/testing";
import { submitted } from "./support/questionnaire.ts";
import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
});
