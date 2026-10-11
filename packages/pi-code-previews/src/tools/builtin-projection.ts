import * as Predicate from "effect/Predicate";
import {
  editResultDetail,
  grepResultDetail,
  projectWriteResultDetail,
} from "./builtin-result-detail";
import { getObjectValue } from "../shared/helpers";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { CompactSummary, CompactPhase } from "./compact-summary";
import { fileFailure } from "./builtin-failure-file";
import { shellFailure } from "./builtin-failure-shell";
import { compactIssueSeverity, mergeCompactIssues, type CompactIssue } from "./compact-issues";
import {
  bashCommandIssues,
  outputLimitProjection,
  readIssues,
  secretIssues,
  writeDiffProjection,
} from "./builtin-issues";
import { getPathArg } from "./data/args";
import { getBoundedTextContent, getEditDiff } from "./data/results";
import {
  describeBuiltinCompactSubject,
  stringArg,
  type BuiltinCompactTool,
} from "./builtin-subject";

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

interface ProjectionParts {
  readonly counters: readonly string[];
  readonly metadata: readonly string[];
  readonly issues: readonly CompactIssue[];
}

const EMPTY_PARTS: ProjectionParts = { counters: [], metadata: [], issues: [] };

const scanSecrets = (policy: BuiltinCompactPolicy, sources: readonly string[]) =>
  secretIssues(sources, policy.secretWarnings, policy.secretScanChars);

export function projectBuiltinCompactSummary(
  tool: BuiltinCompactTool,
  input: BuiltinCompactProjectionInput,
): CompactSummary | undefined {
  const { phase, args, result, cwd, isError } = input;
  const output = getBoundedTextContent(result?.content);
  if (output === undefined) return undefined;
  const inputSources = secretInputSources(tool, args, input.secretWarnings);
  if (!inputSources) return undefined;
  const issues = scanSecrets(input, [...inputSources, output]);
  if (tool === "bash")
    issues.push(...bashCommandIssues(stringArg(args, "command"), input.bashWarnings));
  const subject = describeBuiltinCompactSubject(tool, args, cwd);
  const live = liveResultParts(tool, input, output);
  if (!live) return undefined;
  issues.push(...live.issues);
  if (isError) return failureSummary(tool, subject, result, output, issues);
  if (phase !== "settled") return { subject, issues };
  if (!result) return undefined;
  const settled = settledResultParts(tool, input, result);
  if (!settled) return undefined;
  const counters = [...live.counters, ...settled.counters];
  if (tool === "grep" && counters.length === 0) counters.push(...grepCounters(output, result));
  const merged = mergeCompactIssues([...issues, ...settled.issues]);
  return {
    subject,
    counters,
    metadata: [...settled.metadata],
    outcome: compactIssueSeverity(merged) === "warning" ? "warning" : "success",
    issues: merged,
  };
}

function liveResultParts(
  tool: BuiltinCompactTool,
  input: BuiltinCompactProjectionInput,
  output: string,
): ProjectionParts | undefined {
  const { args, result, isError } = input;
  if (!result) return EMPTY_PARTS;
  if (tool === "read" && !isError) {
    const read = readIssues(
      result.details,
      output,
      Predicate.isNumber(getObjectValue(args, "limit")),
    );
    return read && { ...EMPTY_PARTS, issues: read };
  }
  if (tool === "bash" || tool === "grep" || tool === "find" || tool === "ls")
    return { ...EMPTY_PARTS, ...outputLimitProjection(tool, result.details) };
  return EMPTY_PARTS;
}

function failureSummary(
  tool: BuiltinCompactTool,
  subject: string,
  result: AgentToolResult<unknown> | undefined,
  output: string,
  issues: readonly CompactIssue[],
): CompactSummary | undefined {
  if (result?.content.some((part) => part.type !== "text")) return undefined;
  const failure = builtinFailure(tool, output, issues);
  return {
    subject,
    outcome: failure.outcome,
    issues: mergeCompactIssues(failure.issues, issues),
  };
}

function settledResultParts(
  tool: BuiltinCompactTool,
  input: BuiltinCompactProjectionInput,
  result: AgentToolResult<unknown>,
): ProjectionParts | undefined {
  if (tool === "write") return writeParts(input);
  if (tool === "edit") return editParts(input, result);
  return EMPTY_PARTS;
}

function writeParts(input: BuiltinCompactProjectionInput): ProjectionParts | undefined {
  const { args, beforeWrite } = input;
  const content = getObjectValue(args, "content");
  if (!Predicate.isString(content)) return undefined;
  const before = beforeWrite.kind === "snapshot" ? beforeWrite.value : undefined;
  const beforeContent = getObjectValue(before, "content");
  const issues = Predicate.isString(beforeContent) ? scanSecrets(input, [beforeContent]) : [];
  if (beforeWrite.kind === "new") return { counters: ["new file"], metadata: [], issues };
  const projection = writeDiffProjection(before, content, input);
  const counters =
    projection.issues.length || projection.metadata.length
      ? []
      : writeCounters(before, content, input);
  return {
    counters,
    metadata: projection.metadata,
    issues: [...issues, ...projection.issues],
  };
}

function writeCounters<Before>(
  before: Before,
  content: string,
  input: BuiltinCompactProjectionInput,
): string[] {
  const { beforeWrite } = input;
  const detail =
    beforeWrite.kind === "snapshot" && beforeWrite.counts
      ? beforeWrite.counts.detail
      : projectWriteResultDetail(before, content, input);
  return detail ? [detail] : [];
}

function editParts(
  input: BuiltinCompactProjectionInput,
  result: AgentToolResult<unknown>,
): ProjectionParts {
  const detail = editResultDetail(input.args);
  const diff = getEditDiff(result.details);
  return {
    counters: detail ? [detail] : [],
    metadata: [],
    issues: diff
      ? scanSecrets(input, [diff])
      : [{ severity: "info", code: "edit-diff-unavailable", message: "Diff unavailable" }],
  };
}

function grepCounters(output: string, result: AgentToolResult<unknown>): string[] {
  const detail = grepResultDetail(output, result.details);
  return detail ? [detail] : [];
}

function builtinFailure(tool: BuiltinCompactTool, output: string, issues: readonly CompactIssue[]) {
  const details = output || `${tool} failed`;
  if (details.trim() === "Operation aborted") return { outcome: "cancelled" as const, issues: [] };
  const lines = details.trimEnd().split(/\r?\n/u);
  if (tool !== "bash") return fileFailure(tool, details, lines);
  const retained = issues.some(({ code }) => code === "retained-output");
  return shellFailure(details, lines, retained);
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
