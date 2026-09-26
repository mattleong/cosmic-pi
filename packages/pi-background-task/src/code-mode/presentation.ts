import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, invokeBestEffort, sanitizeTerminalLine } from "pi-cosmic-core";
import { createBoundedCompactIssuesSchema } from "pi-code-previews";
import { BACKGROUND_TASK_ACTIONS, MaxChars } from "../task/schema.ts";
import { projectBackgroundTaskCompactSummary } from "../ui/compact-summary.ts";
import type { BackgroundTaskCodeModeInput } from "./protocol.ts";

export const BACKGROUND_TASK_PRESENTATION_VERSION = 1 as const;
const Text = MaxChars(2048);
const Labels = Schema.Array(Text).check(Schema.isMaxLength(16));
export const BackgroundTaskPresentationSchema = Schema.Struct({
  version: Schema.Literal(BACKGROUND_TASK_PRESENTATION_VERSION),
  incomplete: Schema.Boolean,
  overflow: Schema.Boolean,
  summary: Schema.optionalKey(
    Schema.Struct({
      action: Schema.Literals(BACKGROUND_TASK_ACTIONS),
      subject: Text,
      compactSubject: Schema.optionalKey(Text),
      outcome: Schema.Literals(["success", "warning", "error", "cancelled", "uncertain"]),
      metadata: Labels,
      counters: Labels,
      notices: Schema.Array(
        Schema.Struct({
          kind: Schema.Literals(["warning", "error", "recovery"]),
          text: Text,
          description: Schema.optionalKey(MaxChars(240)),
        }),
      ).check(Schema.isMaxLength(32)),
      issues: Schema.optionalKey(
        createBoundedCompactIssuesSchema({
          maxTextLength: 2048,
          maxEntries: 32,
          maxRecoveryEntries: 8,
          maxDiagnosticEntries: 16,
        }),
      ),
      detailsOnExpand: Schema.Literal(true),
    }),
  ),
});
export type BackgroundTaskPresentation = typeof BackgroundTaskPresentationSchema.Type;
export type BackgroundTaskPresentationObserver = (receipt: BackgroundTaskPresentation) => void;

/** Decode only bounded semantic data. Never retains command results or log text. */
export const normalizeBackgroundTaskPresentation = <Value>(
  value: Value,
): BackgroundTaskPresentation | undefined => {
  try {
    const decoded = decodeUnknownOrUndefined(BackgroundTaskPresentationSchema, value);
    if (
      !decoded ||
      (decoded.overflow && !decoded.incomplete) ||
      (!decoded.incomplete && !decoded.summary)
    )
      return undefined;
    if (decoded.summary) {
      const s = decoded.summary;
      return {
        ...decoded,
        summary: {
          ...s,
          subject: sanitizeTerminalLine(s.subject),
          ...(s.compactSubject !== undefined && {
            compactSubject: sanitizeTerminalLine(s.compactSubject),
          }),
          ...(s.issues && {
            issues: {
              coverage: decoded.incomplete || decoded.overflow ? "unknown" : s.issues.coverage,
              entries: s.issues.entries.map((issue) => ({
                ...issue,
                operation: sanitizeTerminalLine(issue.operation),
                code: sanitizeTerminalLine(issue.code),
                cause: sanitizeTerminalLine(issue.cause),
                ...(issue.description !== undefined && {
                  description: sanitizeTerminalLine(issue.description),
                }),
                ...(issue.diagnostics && {
                  diagnostics: issue.diagnostics.map(sanitizeTerminalLine),
                }),
                recovery: issue.recovery.map((instruction) => ({
                  code: sanitizeTerminalLine(instruction.code),
                  text: sanitizeTerminalLine(instruction.text),
                })),
              })),
            },
          }),
          metadata: s.metadata.map(sanitizeTerminalLine),
          counters: s.counters.map(sanitizeTerminalLine),
          notices: s.notices.map((n) => ({
            ...n,
            text: sanitizeTerminalLine(n.text),
            ...(n.description !== undefined && {
              description: sanitizeTerminalLine(n.description),
            }),
          })),
        },
      };
    }
    return decoded;
  } catch {
    return undefined;
  }
};

export const projectBackgroundTaskPresentation = (
  args: BackgroundTaskCodeModeInput,
  result: { details?: unknown },
): BackgroundTaskPresentation => {
  try {
    const summary = projectBackgroundTaskCompactSummary({
      phase: "settled",
      args,
      result,
      isError: false,
    });
    if (!summary?.outcome) return { version: 1, incomplete: true, overflow: false };
    const receipt = normalizeBackgroundTaskPresentation({
      version: 1,
      incomplete: summary.issues?.coverage === "unknown",
      overflow: false,
      summary: {
        action: summary.action ?? args.action,
        subject: summary.subject,
        ...(summary.compactSubject !== undefined && { compactSubject: summary.compactSubject }),
        outcome: summary.outcome,
        metadata: summary.metadata ?? [],
        counters: summary.counters ?? [],
        notices: summary.notices ?? [],
        issues: summary.issues,
        detailsOnExpand: true,
      },
    });
    return receipt ?? { version: 1, incomplete: true, overflow: true };
  } catch {
    return { version: 1, incomplete: true, overflow: false };
  }
};

/** Observers are best effort: throws and rejecting thenables never change execution. */
export const observeBackgroundTaskPresentation = (
  observer: BackgroundTaskPresentationObserver | undefined,
  receipt: BackgroundTaskPresentation,
): void => {
  if (Predicate.isFunction(observer)) invokeBestEffort(() => observer(receipt));
};
