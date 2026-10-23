import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { SubagentCleanupDiagnostic } from "./model.ts";
import { sanitizeDiagnosticText } from "./state.ts";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";

const FailureDetails = Schema.Struct({
  message: Schema.String,
  code: Schema.optional(Schema.String),
});

const failureDetails = (reason: Cause.Reason<unknown>): typeof FailureDetails.Type => {
  if (Cause.isInterruptReason(reason)) return { message: "Cleanup was interrupted." };
  const value = Cause.isFailReason(reason) ? reason.error : reason.defect;
  const details = Schema.decodeUnknownOption(FailureDetails)(value);
  if (Option.isSome(details)) return details.value;
  const message = Schema.decodeUnknownOption(Schema.String)(value);
  return { message: Option.isSome(message) ? message.value : "Unrecognized cleanup failure." };
};

export const boundedCleanupDiagnostic = (
  diagnostic: SubagentCleanupDiagnostic,
): SubagentCleanupDiagnostic => {
  const code =
    diagnostic.code === undefined
      ? undefined
      : Fn.pipe(
          sanitizeDiagnosticContent(diagnostic.code, { maximumLength: 80 }),
          Str.replace(/\s+/g, " "),
          Str.trim,
        );
  const message =
    Str.trim(sanitizeDiagnosticText(diagnostic.message, 1024)) ||
    "Cleanup did not provide confirmation.";
  return { phase: diagnostic.phase, ...(code && { code }), message };
};

export const cleanupFailureDiagnostic = (
  phase: SubagentCleanupDiagnostic["phase"],
  cause: Cause.Cause<unknown>,
): SubagentCleanupDiagnostic => {
  const failures = Arr.map(cause.reasons, failureDetails);
  const first = failures[0];
  return boundedCleanupDiagnostic({
    phase,
    ...(first?.code && { code: first.code }),
    message:
      Arr.join(
        Arr.map(failures, (failure) => failure.message),
        "; ",
      ) || "Cleanup did not provide confirmation.",
  });
};
