import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  decodeUnknownOrUndefined,
  invokeBestEffort,
  sanitizeTerminalLine,
  stripTerminalControls,
} from "pi-cosmic-core";
import { createBoundedCompactIssuesSchema } from "pi-code-previews";
import { BACKGROUND_TASK_ACTIONS, MaxChars } from "../task/schema.ts";
import { projectBackgroundTaskCompactSummary } from "../ui/compact-summary.ts";
import type { BackgroundTaskCodeModeInput } from "./protocol.ts";

export const BACKGROUND_TASK_PRESENTATION_VERSION = 2 as const;
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
      issues: createBoundedCompactIssuesSchema({ maxTextLength: 2048, maxEntries: 32 }),
    }),
  ),
});
export type BackgroundTaskPresentation = typeof BackgroundTaskPresentationSchema.Type;
export type BackgroundTaskPresentationObserver = (receipt: BackgroundTaskPresentation) => void;

const incomplete = (overflow: boolean): BackgroundTaskPresentation => ({
  version: BACKGROUND_TASK_PRESENTATION_VERSION,
  incomplete: true,
  overflow,
});

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
    if (!decoded.summary) return decoded;
    const s = decoded.summary;
    return {
      ...decoded,
      summary: {
        ...s,
        subject: sanitizeTerminalLine(s.subject),
        ...(s.compactSubject !== undefined && {
          compactSubject: sanitizeTerminalLine(s.compactSubject),
        }),
        metadata: s.metadata.map(sanitizeTerminalLine),
        counters: s.counters.map(sanitizeTerminalLine),
        issues: s.issues.map((issue) => {
          const detail = issue.detail === undefined ? "" : stripTerminalControls(issue.detail);
          return {
            severity: issue.severity,
            code: sanitizeTerminalLine(issue.code) || "background-task",
            message: sanitizeTerminalLine(issue.message),
            ...(detail.trim() && { detail }),
          };
        }),
      },
    };
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
    if (!summary?.outcome) return incomplete(false);
    // Oversized or excess issues reject the whole receipt: evidence is never silently clipped.
    return (
      normalizeBackgroundTaskPresentation({
        version: BACKGROUND_TASK_PRESENTATION_VERSION,
        incomplete: false,
        overflow: false,
        summary: {
          action: summary.action ?? args.action,
          subject: summary.subject,
          ...(summary.compactSubject !== undefined && { compactSubject: summary.compactSubject }),
          outcome: summary.outcome,
          metadata: summary.metadata ?? [],
          counters: summary.counters ?? [],
          issues: summary.issues ?? [],
        },
      }) ?? incomplete(true)
    );
  } catch {
    return incomplete(false);
  }
};

/** Observers are best effort: throws and rejecting thenables never change execution. */
export const observeBackgroundTaskPresentation = (
  observer: BackgroundTaskPresentationObserver | undefined,
  receipt: BackgroundTaskPresentation,
): void => {
  if (Predicate.isFunction(observer)) invokeBestEffort(() => observer(receipt));
};
