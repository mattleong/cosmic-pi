import { initTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { controlled as controllable, opaqueHostFixture, theme } from "./support/host.ts";
import { type KeyId, matchesKey, type TUI, visibleWidth } from "@earendil-works/pi-tui";
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
) => {
  const done = vi.fn<(outcome: AskUserOutcome) => void>();
  const tui: TUI = opaqueHostFixture({ requestRender: vi.fn() });
  const dialog = new AskUserDialog({
    tui,
    theme,
    keybindings,
    request: selectedRequest,
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
