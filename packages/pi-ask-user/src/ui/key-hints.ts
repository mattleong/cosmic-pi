import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { formatKeyIds } from "pi-cosmic-ui/manager/key-labels";

export type EditorKeybindings = Pick<KeybindingsManager, "getKeys">;

/** The first configured key of each editor action, so hints name the keys that actually work. */
export interface EditorKeyLabels {
  readonly submit: string;
  readonly newLine: string | undefined;
  readonly externalEditor: string | undefined;
}

const firstKey = (
  keybindings: EditorKeybindings,
  id: "tui.input.submit" | "tui.input.newLine" | "app.editor.external",
): string | undefined => {
  const [key] = keybindings.getKeys(id);
  return key === undefined ? undefined : formatKeyIds([key]);
};

export const editorKeyLabels = (keybindings: EditorKeybindings): EditorKeyLabels => ({
  submit: firstKey(keybindings, "tui.input.submit") ?? "Enter",
  newLine: firstKey(keybindings, "tui.input.newLine"),
  externalEditor: firstKey(keybindings, "app.editor.external"),
});
