import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { keybindingsFixture, type HostKeybindings } from "./tui.ts";

export const piKeybindingsFixture = (
  overrides: Partial<HostKeybindings> = {},
): KeybindingsManager => keybindingsFixture(overrides) as KeybindingsManager;
