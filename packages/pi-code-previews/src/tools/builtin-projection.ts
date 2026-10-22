import * as Predicate from "effect/Predicate";
import {
  editResultDetail,
  grepResultDetail,
  projectWriteResultDetail,
} from "./builtin-result-detail";
import { hostObject, ownField, type HostObject } from "../shared/untrusted-value";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { CompactSummary, CompactPhase } from "./compact-summary";
import { argumentFailureIssue } from "./argument-failure";
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
import { editOperationInputs, getPathArg, hasReadLimit } from "./data/args";
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

interface DecodedProjectionInput {
  readonly args: HostObject | undefined;
  readonly details: HostObject | undefined;
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
  const { phase, result, cwd, isError } = input;
  const decoded: DecodedProjectionInput = {
    args: hostObject(input.args),
    details: hostObject(result?.details),
  };
  const { args } = decoded;
  const output = getBoundedTextContent(result?.content);
  if (output === undefined) return undefined;
  const inputSources = secretInputSources(tool, args, input.secretWarnings);
  if (!inputSources) return undefined;
  const issues = scanSecrets(input, [...inputSources, output]);
  if (tool === "bash")
    issues.push(...bashCommandIssues(stringArg(args, "command"), input.bashWarnings));
  const subject = describeBuiltinCompactSubject(tool, args, cwd);
  const live = liveResultParts(tool, input, decoded, output);
  if (!live) return undefined;
  issues.push(...live.issues);
  if (isError) return failureSummary(tool, subject, decoded, result, output, issues);
  if (phase !== "settled") return { subject, issues };
  if (!result) return undefined;
  const settled = settledResultParts(tool, input, decoded);
  if (!settled) return undefined;
  const counters = [...live.counters, ...settled.counters];
  if (tool === "grep" && counters.length === 0)
    counters.push(...grepCounters(output, decoded.details));
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
  { args, details }: DecodedProjectionInput,
  output: string,
): ProjectionParts | undefined {
  if (!input.result) return EMPTY_PARTS;
  if (tool === "read" && !input.isError) {
    const read = readIssues(details, output, hasReadLimit(args));
    return read && { ...EMPTY_PARTS, issues: read };
  }
  if (tool === "bash" || tool === "grep" || tool === "find" || tool === "ls")
    return { ...EMPTY_PARTS, ...outputLimitProjection(tool, details) };
  return EMPTY_PARTS;
}

function failureSummary(
  tool: BuiltinCompactTool,
  subject: string,
  { args }: DecodedProjectionInput,
  result: AgentToolResult<unknown> | undefined,
  output: string,
  issues: readonly CompactIssue[],
): CompactSummary | undefined {
  if (result?.content.some((part) => part.type !== "text")) return undefined;
  const invalid = argumentFailureIssue(output);
  if (invalid)
    return {
      // Malformed JSON reaches renderers as `{}`, where argument defaults would invent a subject.
      subject: args && Object.keys(args).length > 0 ? subject : "",
      outcome: "error",
      issues: mergeCompactIssues([invalid], issues),
    };
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
  decoded: DecodedProjectionInput,
): ProjectionParts | undefined {
  if (tool === "write") return writeParts(input, decoded.args);
  if (tool === "edit") return editParts(input, decoded);
  return EMPTY_PARTS;
}

function writeParts(
  input: BuiltinCompactProjectionInput,
  args: HostObject | undefined,
): ProjectionParts | undefined {
  const { beforeWrite } = input;
  const content = ownField(args, "content");
  if (!Predicate.isString(content)) return undefined;
  const before = beforeWrite.kind === "snapshot" ? hostObject(beforeWrite.value) : undefined;
  const beforeContent = ownField(before, "content");
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

function writeCounters(
  before: HostObject | undefined,
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
  { args, details }: DecodedProjectionInput,
): ProjectionParts {
  const detail = editResultDetail(args);
  const diff = getEditDiff(details);
  return {
    counters: detail ? [detail] : [],
    metadata: [],
    issues: diff
      ? scanSecrets(input, [diff])
      : [{ severity: "info", code: "edit-diff-unavailable", message: "Diff unavailable" }],
  };
}

function grepCounters(output: string, details: HostObject | undefined): string[] {
  const detail = grepResultDetail(output, details);
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

function secretInputSources(
  tool: BuiltinCompactTool,
  args: HostObject | undefined,
  enabled: boolean,
): string[] | undefined {
  if (!enabled) return [];
  const sources = [getPathArg(args), stringArg(args, "command"), stringArg(args, "pattern")];
  if (tool === "write") sources.push(stringArg(args, "content"));
  if (tool === "edit") {
    const operations = editOperationInputs(args);
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
