import * as Predicate from "effect/Predicate";
import { getObjectValue } from "../shared/helpers";
import { escapeControlChars } from "../shared/terminal-text";
import { getPathArg, getReadStartLine } from "./data/args";
import { normalizeShellCommandWhitespace } from "./shell-command";
import { formatDisplayPath } from "pi-cosmic-core";

export type BuiltinCompactTool = "read" | "bash" | "write" | "edit" | "grep" | "find" | "ls";

/** Argument-only display target shared by standalone and nested calls. Never reads output. */
export function describeBuiltinCompactSubject<Args>(
  tool: BuiltinCompactTool,
  args: Args,
  cwd: string,
): string {
  const stringArg = (name: string): string => {
    const value = getObjectValue(args, name);
    return Predicate.isString(value) ? value : "";
  };
  // Subject clipping is harmless. Notices, unlike subjects, are never clipped.
  const path = escapeControlChars(formatDisplayPath(getPathArg(args), cwd).slice(0, 4096));
  if (tool === "bash")
    return escapeControlChars(normalizeShellCommandWhitespace(stringArg("command").slice(0, 4096)));
  if (tool === "find" || tool === "grep") {
    const pattern = escapeControlChars(stringArg("pattern").slice(0, 4096));
    return `${pattern || (tool === "find" ? "*" : "")} in ${path || "."}`;
  }
  if (tool === "read") {
    const start = getReadStartLine(args);
    const limit = getObjectValue(args, "limit");
    if (Number.isSafeInteger(start)) {
      if (
        Predicate.isNumber(limit) &&
        Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit - 1 <= Number.MAX_SAFE_INTEGER - start
      )
        return `${path}:${start}-${start + (limit - 1)}`;
      if (getObjectValue(args, "offset") !== undefined) return `${path}:${start}`;
    }
  }
  return path || (tool === "ls" ? "." : "");
}
