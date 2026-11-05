import { formatDisplayPath } from "pi-cosmic-core/platform/paths";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import type { OpenAIConfigError } from "../config/store.ts";

/**
 * A settings file that couldn't be read or written, in words: the file as settings show paths, and
 * what to check. The store's own message never reaches the notice.
 */
export const saveFailureMessage = (error: OpenAIConfigError, cwd: string): string => {
  const shown = sanitizeTerminalLine(formatDisplayPath(error.path, cwd));
  return error.operation === "write"
    ? `Couldn't save Better OpenAI settings\nCheck that you can write to ${shown}`
    : `Couldn't save Better OpenAI settings\nCheck that ${shown} is readable and holds a JSON object`;
};
