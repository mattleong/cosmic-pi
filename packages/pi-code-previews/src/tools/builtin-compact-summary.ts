import * as Predicate from "effect/Predicate";
import { writeResultDetail } from "./builtin-result-detail";
import { codePreviewPerformanceConfig, codePreviewSettings } from "../config/state";
import { getObjectValue } from "../shared/helpers";
import { getCodePreviewBeforeWrite, isKnownNewWrite } from "../write/preview-execution";
import type { CompactSummary, CompactSummaryProvider } from "./compact-summary";
import {
  projectBuiltinCompactSummary,
  type BuiltinCompactPolicy,
  type BuiltinBeforeWrite,
} from "./builtin-projection";
import { describeBuiltinCompactSubject, type BuiltinCompactTool } from "./builtin-subject";
import { isTruncated } from "./data/results";

/** Detached, no-I/O snapshot of the currently published preview policy. */
export function captureBuiltinCompactPolicy(): BuiltinCompactPolicy {
  return {
    secretWarnings: codePreviewSettings.secretWarnings,
    bashWarnings: codePreviewSettings.bashWarnings,
    secretScanChars: codePreviewPerformanceConfig.secretScanChars,
    maxWriteDiffBytes: codePreviewPerformanceConfig.maxWriteDiffBytes,
    maxWriteDiffChangedLineCells: codePreviewPerformanceConfig.maxWriteDiffChangedLineCells,
  };
}

/** Host adapter owns settings and private before-write lookup, never execution. */
export function createBuiltinCompactSummary<TArgs, TDetails, TState>(
  tool: BuiltinCompactTool,
  { phase, args, result, context }: Parameters<CompactSummaryProvider<TArgs, TDetails, TState>>[0],
): CompactSummary | undefined {
  let beforeWrite: BuiltinBeforeWrite = { kind: "unknown" };
  if (tool === "write" && phase === "settled" && result && !context.isError) {
    const before = getCodePreviewBeforeWrite(context.toolCallId, result.details);
    const content = getObjectValue(args, "content");
    if (isKnownNewWrite(before, result.details)) beforeWrite = { kind: "new" };
    else if (before !== undefined)
      beforeWrite = {
        kind: "snapshot",
        value: before,
        ...(Predicate.isString(content) && {
          counts: { detail: writeResultDetail(before, content) },
        }),
      };
  }
  const projected = projectBuiltinCompactSummary(tool, {
    ...captureBuiltinCompactPolicy(),
    phase,
    args,
    result,
    cwd: context.cwd,
    isError: context.isError,
    beforeWrite,
  });
  if (projected || phase !== "settled" || context.isError || !isTruncated(result?.details))
    return projected;
  // Output too large to classify still says that it was cut off.
  return {
    subject: describeBuiltinCompactSubject(tool, args, context.cwd),
    outcome: "success",
    issues: [{ severity: "warning", code: "output-truncated", message: "Output was cut off" }],
  };
}
