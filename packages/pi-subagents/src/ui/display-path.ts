import { formatDisplayPath } from "pi-cosmic-core/platform/paths";

/**
 * A path as the user reads it where no session directory applies: `~/…` under home, otherwise
 * unchanged. Working directories, saved reports, and settings files all read this way; anything
 * that acts on the path keeps the real one.
 */
export const homeDisplayPath = (path: string): string => formatDisplayPath(path, "");
