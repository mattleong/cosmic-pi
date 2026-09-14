import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import { codePreviewSettings } from "../config/state";
import { getObjectValue } from "../shared/helpers";
import { escapeControlChars } from "../shared/terminal-text";
import { getCodePreviewBeforeWrite } from "../write/preview-execution";
import type { CompactSummary, CompactSummaryProvider } from "./compact-summary";
import { builtinFailure } from "./builtin-failure";
import {
  bashCommandNotices,
  outputLimitProjection,
  readNotices,
  secretNotices,
  writeDiffProjection,
} from "./compact-notices";
import { getPathArg, getReadStartLine } from "./data/args";
import { getBoundedTextContent, getEditDiff } from "./data/results";
import { normalizeShellCommandWhitespace } from "./shell-command";

export type BuiltinCompactTool = "read" | "bash" | "write" | "edit" | "grep" | "find" | "ls";

/** Only built-ins use their execution error flag as the success contract. */
export function createBuiltinCompactSummary<TArgs, TDetails, TState>(
  tool: BuiltinCompactTool,
  { phase, args, result, context }: Parameters<CompactSummaryProvider<TArgs, TDetails, TState>>[0],
): CompactSummary | undefined {
  const output = getBoundedTextContent(result?.content);
  if (output === undefined) return undefined;
  const command = stringArg(args, "command");
  const inputSources = secretInputSources(tool, args);
  if (!inputSources) return undefined;
  const notices = secretNotices([...inputSources, output]);
  const metadata: string[] = [];
  const counters: string[] = [];
  if (tool === "bash") {
    const commandNotices = bashCommandNotices(command);
    if (!commandNotices) return undefined;
    notices.push(...commandNotices);
  }
  const subject = builtinSubject(tool, args);
  if (result) {
    if (tool === "read" && !context.isError) {
      const recovery = readNotices(
        result.details,
        output,
        Predicate.isNumber(getObjectValue(args, "limit")),
      );
      if (!recovery) return undefined;
      notices.push(...recovery);
    } else if (tool === "bash" || tool === "grep" || tool === "find" || tool === "ls") {
      const projection = outputLimitProjection(tool, result.details);
      counters.push(...(projection.counters ?? []));
      notices.push(...projection.notices);
      metadata.push(...projection.metadata);
    }
  }
  if (context.isError) {
    // Text ownership must not replace attachment-aware failure renderers.
    if (result?.content.some((part) => part.type !== "text")) return undefined;
    const failure = builtinFailure(tool, output);
    return {
      subject,
      ...failure,
      notices: deduplicateNotices([...notices, ...failure.notices]),
    };
  }
  if (phase !== "settled") return { subject, notices };
  if (!result) return undefined;
  if (tool === "write") {
    const before = getCodePreviewBeforeWrite(context.toolCallId, result.details);
    const beforeContent = getObjectValue(before, "content");
    if (Predicate.isString(beforeContent)) notices.push(...secretNotices([beforeContent]));
    // Live writes explicitly record an absent previous file. JSON replay drops this
    // undefined property, so a missing replay snapshot must not imply a new file.
    const knownNewFile =
      before === undefined &&
      result.details !== null &&
      hasObjectRuntimeType(result.details) &&
      Object.hasOwn(result.details, "codePreviewBeforeWrite") &&
      getObjectValue(result.details, "codePreviewBeforeWrite") === undefined;
    if (!knownNewFile) {
      const projection = writeDiffProjection(before, stringArg(args, "content"));
      notices.push(...projection.notices);
      metadata.push(...projection.metadata);
    }
  } else if (tool === "edit") {
    const diff = getEditDiff(result.details);
    if (diff) notices.push(...secretNotices([diff]));
    else notices.push({ kind: "warning", text: "Edit applied; diff unavailable" });
  }
  return {
    subject,
    counters,
    metadata,
    outcome: notices.length > 0 ? "warning" : "success",
    notices: deduplicateNotices(notices),
  };
}

function stringArg<Args>(args: Args, name: string): string {
  const value = getObjectValue(args, name);
  return Predicate.isString(value) ? value : "";
}

function builtinSubject<Args>(tool: BuiltinCompactTool, args: Args): string {
  // Subject clipping is harmless. Notices, unlike subjects, are never clipped.
  const path = escapeControlChars(getPathArg(args).slice(0, 4096));
  if (tool === "bash")
    return escapeControlChars(
      normalizeShellCommandWhitespace(stringArg(args, "command").slice(0, 4096)),
    );
  if (tool === "find" || tool === "grep") {
    const pattern = escapeControlChars(stringArg(args, "pattern").slice(0, 4096));
    return `${pattern || (tool === "find" ? "*" : "")} in ${path || "."}`;
  }
  if (tool === "read") {
    const start = getReadStartLine(args);
    const limit = getObjectValue(args, "limit");
    if (Predicate.isNumber(limit) && Number.isSafeInteger(limit) && limit > 0)
      return `${path}:${start}-${start + limit - 1}`;
    if (getObjectValue(args, "offset") !== undefined) return `${path}:${start}`;
  }
  return path || (tool === "ls" ? "." : "");
}

function secretInputSources<Args>(tool: BuiltinCompactTool, args: Args): string[] | undefined {
  if (!codePreviewSettings.secretWarnings) return [];
  const sources = [getPathArg(args), stringArg(args, "command"), stringArg(args, "pattern")];
  if (tool === "write") sources.push(stringArg(args, "content"));
  if (tool === "edit") {
    const edits = getObjectValue(args, "edits");
    const operations = Array.isArray(edits) ? edits : [args];
    // Keep input discovery bounded as well as each individual secret scan.
    if (operations.length > 64) return undefined;
    for (const edit of operations) {
      sources.push(
        stringArg(edit, "oldText") || stringArg(edit, "old_text"),
        stringArg(edit, "newText") || stringArg(edit, "new_text"),
      );
    }
  }
  return sources;
}

function deduplicateNotices<T extends { kind: string; text: string }>(notices: T[]): T[] {
  const seen = new Set<string>();
  return notices.filter((notice) => {
    const key = `${notice.kind}\0${notice.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
