import { SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import type { HostShellSettings } from "./local-process.ts";

const setting = (read: (settings: SettingsManager) => string | undefined, pi: ExtensionAPI) =>
  invokeHostCallback(() => {
    const value = read(SettingsManager.inMemory(pi.getSettings()));
    return Predicate.isString(value) && Str.isNonEmpty(value) ? value : undefined;
  }, undefined);

/**
 * Pi's shell settings as its bash tool reads them, with `~` expanded in the shell path. Each is
 * read on its own, so one that can't be read leaves the other in effect.
 */
export const readHostShellSettings = (pi: ExtensionAPI): HostShellSettings => {
  const shellPath = setting((settings) => settings.getShellPath(), pi);
  const commandPrefix = setting((settings) => settings.getShellCommandPrefix(), pi);
  return { ...(shellPath && { shellPath }), ...(commandPrefix && { commandPrefix }) };
};
