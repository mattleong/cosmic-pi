import * as Predicate from "effect/Predicate";
import {
  editResultDetail,
  grepResultDetail,
  projectWriteResultDetail,
} from "./builtin-result-detail";
import { getObjectValue } from "../shared/helpers";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isCompactAttention, type CompactSummary, type CompactPhase } from "./compact-summary";
import { builtinFailure } from "./builtin-failure";
import {
  bashCommandNotices,
  outputLimitProjection,
  readNotices,
  secretNotices,
  writeDiffProjection,
} from "./compact-notices";
import { getPathArg } from "./data/args";
import { getBoundedTextContent, getEditDiff } from "./data/results";
import { describeBuiltinCompactSubject, type BuiltinCompactTool } from "./builtin-subject";
export type { BuiltinCompactTool } from "./builtin-subject";

export interface BuiltinCompactPolicy {
  secretWarnings: boolean;
  bashWarnings: boolean;
  secretScanChars: number;
  maxWriteDiffBytes: number;
  maxWriteDiffChangedLineCells: number;
}

export type BuiltinBeforeWrite =
  | { kind: "unknown" }
  | { kind: "new" }
  | { kind: "snapshot"; value: unknown; counts?: { detail: string | undefined } };

export interface BuiltinCompactProjectionInput extends BuiltinCompactPolicy {
  phase: CompactPhase;
  args: unknown;
  result: AgentToolResult<unknown> | undefined;
  cwd: string;
  isError: boolean;
  beforeWrite: BuiltinBeforeWrite;
}

/** Pure transient projection. Retaining consumers must drop failure.details, redact
 * sensitive text, and bound every retained string/collection. Never retain raw output.
 */
export function projectBuiltinCompactSummary(
  tool: BuiltinCompactTool,
  input: BuiltinCompactProjectionInput,
): CompactSummary | undefined {
  const { phase, args, result, cwd, isError, beforeWrite } = input;
  const scan = (sources: readonly string[]) =>
    secretNotices(sources, input.secretWarnings, input.secretScanChars);
  const output = getBoundedTextContent(result?.content);
  if (output === undefined) return undefined;
  const command = stringArg(args, "command");
  const inputSources = secretInputSources(tool, args, input.secretWarnings);
  if (!inputSources) return undefined;
  const notices = scan([...inputSources, output]);
  const metadata: string[] = [];
  const counters: string[] = [];
  if (tool === "bash") {
    const commandNotices = bashCommandNotices(command, input.bashWarnings);
    if (!commandNotices) return undefined;
    notices.push(...commandNotices);
  }
  const subject = describeBuiltinCompactSubject(tool, args, cwd);
  if (result) {
    if (tool === "read" && !isError) {
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
  if (isError) {
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
    const content = getObjectValue(args, "content");
    if (!Predicate.isString(content)) return undefined;
    const before = beforeWrite.kind === "snapshot" ? beforeWrite.value : undefined;
    const beforeContent = getObjectValue(before, "content");
    if (Predicate.isString(beforeContent)) notices.push(...scan([beforeContent]));
    const knownNewFile = beforeWrite.kind === "new";
    if (knownNewFile) counters.push("new file");
    if (!knownNewFile) {
      const projection = writeDiffProjection(before, content, input);
      notices.push(...projection.notices);
      metadata.push(...projection.metadata);
      if (!projection.notices.length && !projection.metadata.length) {
        const detail =
          beforeWrite.kind === "snapshot" && beforeWrite.counts
            ? beforeWrite.counts.detail
            : projectWriteResultDetail(before, content, input);
        if (detail) counters.push(detail);
      }
    }
  } else if (tool === "edit") {
    const detail = editResultDetail(args);
    if (detail) counters.push(detail);
    const diff = getEditDiff(result.details);
    if (diff) notices.push(...scan([diff]));
    else notices.push({ kind: "warning", text: "Edit applied; diff unavailable" });
  }
  if (tool === "grep" && counters.length === 0) {
    const detail = grepResultDetail(output, result.details);
    if (detail) counters.push(detail);
  }
  return {
    subject,
    counters,
    metadata,
    outcome: notices.some(isCompactAttention) ? "warning" : "success",
    notices: deduplicateNotices(notices),
  };
}

function stringArg<Args>(args: Args, name: string): string {
  const value = getObjectValue(args, name);
  return Predicate.isString(value) ? value : "";
}

function secretInputSources<Args>(
  tool: BuiltinCompactTool,
  args: Args,
  enabled: boolean,
): string[] | undefined {
  if (!enabled) return [];
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
