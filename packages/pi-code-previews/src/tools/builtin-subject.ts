import * as Predicate from "effect/Predicate";
import { ownField, type HostObject } from "../shared/untrusted-value";
import { escapeControlChars } from "../shared/terminal-text";
import { getPathArg, getReadLineRange } from "./data/args";
import type { CORE_CODE_PREVIEW_TOOLS } from "./names";
import { normalizeShellCommandWhitespace } from "./shell-command";
import { formatDisplayPath } from "pi-cosmic-core";

export type BuiltinCompactTool = (typeof CORE_CODE_PREVIEW_TOOLS)[number];

export function stringArg(args: HostObject | undefined, name: string): string {
  const value = ownField(args, name);
  return Predicate.isString(value) ? value : "";
}

export function describeBuiltinCompactSubject(
  tool: BuiltinCompactTool,
  args: HostObject | undefined,
  cwd: string,
): string {
  const path = escapeControlChars(formatDisplayPath(getPathArg(args), cwd).slice(0, 4096));
  if (tool === "bash")
    return escapeControlChars(
      normalizeShellCommandWhitespace(stringArg(args, "command").slice(0, 4096)),
    );
  if (tool === "find" || tool === "grep") {
    const pattern = escapeControlChars(stringArg(args, "pattern").slice(0, 4096));
    return `${pattern || (tool === "find" ? "*" : "")} in ${path || "."}`;
  }
  if (tool === "read") return path + getReadLineRange(args);
  return path || (tool === "ls" ? "." : "");
}
