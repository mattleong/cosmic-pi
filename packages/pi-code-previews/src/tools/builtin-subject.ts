import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { ownField, type HostObject } from "../shared/untrusted-value";
import { escapeControlChars } from "../shared/terminal-text";
import { getPathArg, getReadLineRange } from "./data/args";
import type { CORE_CODE_PREVIEW_TOOLS } from "./names";
import { normalizeShellCommandWhitespace } from "./shell-command";
import { formatDisplayPath } from "pi-cosmic-core/platform/paths";

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
  const path = escapeControlChars(
    Fn.pipe(formatDisplayPath(getPathArg(args), cwd), Str.slice(0, 4096)),
  );
  if (tool === "bash")
    return escapeControlChars(
      normalizeShellCommandWhitespace(Fn.pipe(stringArg(args, "command"), Str.slice(0, 4096))),
    );
  if (tool === "find" || tool === "grep") {
    const pattern = escapeControlChars(Fn.pipe(stringArg(args, "pattern"), Str.slice(0, 4096)));
    return `${pattern || (tool === "find" ? "*" : "")} in ${path || "."}`;
  }
  if (tool === "read") return path + getReadLineRange(args);
  return path || (tool === "ls" ? "." : "");
}
