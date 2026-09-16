import * as Predicate from "effect/Predicate";
import { writeResultDetail } from "./builtin-result-detail";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import { codePreviewSettings } from "../config/state";
import { codePreviewPerformanceConfig } from "../config/env";
import { getObjectValue } from "../shared/helpers";
import { getCodePreviewBeforeWrite } from "../write/preview-execution";
import type { CompactSummary, CompactSummaryProvider } from "./compact-summary";
import {
  projectBuiltinCompactSummary,
  type BuiltinCompactPolicy,
  type BuiltinBeforeWrite,
} from "./builtin-projection";
import type { BuiltinCompactTool } from "./builtin-subject";
export type { BuiltinCompactTool } from "./builtin-subject";

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
    // Explicit undefined records a known absent file; JSON replay loses this evidence.
    const knownNew =
      before === undefined &&
      result.details !== null &&
      hasObjectRuntimeType(result.details) &&
      Object.hasOwn(result.details, "codePreviewBeforeWrite") &&
      getObjectValue(result.details, "codePreviewBeforeWrite") === undefined;
    beforeWrite = knownNew
      ? { kind: "new" }
      : before === undefined
        ? { kind: "unknown" }
        : { kind: "snapshot", value: before };
  }
  const content = getObjectValue(args, "content");
  if (beforeWrite.kind === "snapshot" && Predicate.isString(content)) {
    beforeWrite = {
      ...beforeWrite,
      counts: { detail: writeResultDetail(beforeWrite.value, content) },
    };
  }
  return projectBuiltinCompactSummary(tool, {
    ...captureBuiltinCompactPolicy(),
    phase,
    args,
    result,
    cwd: context.cwd,
    isError: context.isError,
    beforeWrite,
  });
}
