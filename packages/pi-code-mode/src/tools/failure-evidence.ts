/** Bounded semantic provenance for the outer diagnostic; never retains its body. */
import * as Schema from "effect/Schema";
import { projectBuiltinFailure } from "pi-code-previews";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import type { CodeModeFailure } from "../boundary/codemode-runtime.ts";
import { FailureEvidenceSchema } from "./compact-evidence.ts";
import { decodeOption } from "./format.ts";

const Builtin = Schema.Literals(["read", "bash", "write", "edit", "grep", "find", "ls"]);
export const FailurePresentationSchema = Schema.Struct({
  version: Schema.Literal(1),
  tool: Builtin,
  evidence: FailureEvidenceSchema,
  notices: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["warning", "error", "recovery"]),
      text: Schema.String.check(Schema.isMaxLength(1024)),
    }),
  ).check(Schema.isMaxLength(32)),
});
export type FailurePresentation = typeof FailurePresentationSchema.Type;

/** The owned adapter creates this envelope. Recognition is by producer policy, not a last-call guess. */
export const projectFailurePresentation = (
  result: CodeModeFailure,
): FailurePresentation | undefined => {
  try {
    if (
      result.error.kind !== "ToolFailure" ||
      result.logs?.length ||
      result.error.suggestions?.length
    )
      return undefined;
    const envelope = /^Nested tool '([^']+)' failed: ([\s\S]*)$/u.exec(result.error.message);
    const tool = decodeOption(Builtin, envelope?.[1]);
    if (tool === undefined || envelope?.[2] === undefined) return undefined;
    const projected = projectBuiltinFailure(tool, envelope[2]);
    if (projected.failureEvidence?.coverage !== "complete") return undefined;
    return decodeOption(FailurePresentationSchema, {
      version: 1,
      tool,
      evidence: {
        ...projected.failureEvidence,
        cause: sanitizeDiagnosticContent(projected.failureEvidence.cause, {
          maximumLength: Number.MAX_SAFE_INTEGER,
        }),
      },
      notices: projected.notices.map((notice) => ({
        kind: notice.kind,
        text: sanitizeDiagnosticContent(notice.text, { maximumLength: Number.MAX_SAFE_INTEGER }),
      })),
    });
  } catch {
    return undefined;
  }
};

export const copyFailurePresentation = (value: FailurePresentation): FailurePresentation =>
  Object.freeze({
    ...value,
    evidence: Object.freeze({ ...value.evidence }),
    notices: Object.freeze(value.notices.map((notice) => Object.freeze({ ...notice }))),
  });
