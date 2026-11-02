import type { KeybindingHints, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { keybindingsFixture, type HostKeybindings } from "./tui.ts";

export const keybindingHintsFixture: KeybindingHints = {
  keyText: () => "",
  keyHint: (_key, description) => description,
};

export const piKeybindingsFixture = (
  overrides: Partial<HostKeybindings> = {},
): KeybindingsManager => keybindingsFixture(overrides) as KeybindingsManager;
