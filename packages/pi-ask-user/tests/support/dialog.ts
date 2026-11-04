import type { Theme } from "@earendil-works/pi-coding-agent";
import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import {
  keybindingsFixture,
  plainTheme,
  terminalFixture,
  tuiFixture,
} from "pi-cosmic-core/testing";
import { vi } from "vitest";
import type { AskUserOutcome } from "../../src/questionnaire/model.ts";
import type { AskUserRequest } from "../../src/questionnaire/schema.ts";
import { AskUserDialog } from "../../src/ui/dialog.ts";

export const ENTER = "\r";
export const ESCAPE = "\x1b";
export const DOWN = "\x1b[B";
export const RIGHT = "\x1b[C";
export const LEFT = "\x1b[D";
export const SPACE = " ";
export const EXTERNAL_EDITOR = "\x07";

const KEY_BINDINGS = new Map<string, KeyId>([
  ["tui.select.up", "up"],
  ["tui.select.down", "down"],
  ["tui.select.pageUp", "pageUp"],
  ["tui.select.pageDown", "pageDown"],
  ["tui.select.confirm", "enter"],
  ["tui.select.cancel", "escape"],
  ["tui.input.submit", "enter"],
  ["tui.input.newLine", "shift+enter"],
  ["app.editor.external", "ctrl+g"],
]);

export const keybindings = keybindingsFixture({
  matches(data, id) {
    const key = KEY_BINDINGS.get(id);
    return key !== undefined && matchesKey(data, key);
  },
  getKeys(id) {
    const key = KEY_BINDINGS.get(id);
    return key === undefined ? [] : [key];
  },
});

export const makeDialog = (
  request: AskUserRequest,
  options: {
    readonly editExternally?: (value: string) => Promise<string | undefined>;
    readonly getHeight?: () => number;
    readonly theme?: Theme;
  } = {},
) => {
  const done = vi.fn<(outcome: AskUserOutcome) => void>();
  const collapse = vi.fn();
  const tui = tuiFixture({
    requestRender: vi.fn(),
    terminal: terminalFixture({ rows: 60, columns: 120 }),
  });
  const dialog = new AskUserDialog({
    tui,
    theme: options.theme ?? plainTheme,
    keybindings,
    request,
    getHeight: options.getHeight ?? (() => Infinity),
    done,
    editExternally: options.editExternally ?? (() => Promise.resolve(undefined)),
    collapse,
  });
  return { dialog, done, collapse };
};

export const typeText = (dialog: AskUserDialog, value: string): void => {
  for (const character of value) dialog.handleInput(character);
};
