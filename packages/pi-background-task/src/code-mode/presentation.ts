import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import { projectBackgroundTaskCompactSummary } from "../ui/compact-summary.ts";
import type { BackgroundTaskCodeModeInput } from "./protocol.ts";

export const BACKGROUND_TASK_PRESENTATION_VERSION = 1 as const;
const Text = Schema.String.check(Schema.isMaxLength(2048));
const Labels = Schema.Array(Text).check(Schema.isMaxLength(16));
export const BackgroundTaskPresentationSchema = Schema.Struct({
  version: Schema.Literal(BACKGROUND_TASK_PRESENTATION_VERSION),
  incomplete: Schema.Boolean,
  overflow: Schema.Boolean,
  summary: Schema.optionalKey(
    Schema.Struct({
      action: Schema.Literals([
        "start",
        "list",
        "status",
        "logs",
        "wait",
        "stop",
        "stop_all",
        "clear",
      ]),
      subject: Text,
      outcome: Schema.Literals(["success", "warning", "error", "cancelled", "uncertain"]),
      metadata: Labels,
      counters: Labels,
      notices: Schema.Array(
        Schema.Struct({
          kind: Schema.Literals(["warning", "error", "recovery"]),
          text: Text,
        }),
      ).check(Schema.isMaxLength(32)),
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
    const decoded = Option.getOrUndefined(
      Schema.decodeUnknownOption(BackgroundTaskPresentationSchema)(value),
    );
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
          metadata: s.metadata.map(sanitizeTerminalLine),
          counters: s.counters.map(sanitizeTerminalLine),
          notices: s.notices.map((n) => ({ ...n, text: sanitizeTerminalLine(n.text) })),
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
      incomplete: false,
      overflow: false,
      summary: {
        action: summary.action ?? args.action,
        subject: summary.subject,
        outcome: summary.outcome,
        metadata: summary.metadata ?? [],
        counters: summary.counters ?? [],
        notices: summary.notices ?? [],
        detailsOnExpand: true,
      },
    });
    return receipt ?? { version: 1, incomplete: true, overflow: true };
  } catch {
    return { version: 1, incomplete: true, overflow: false };
  }
};

/** Observers are best effort, including hostile or rejecting thenables. */
export const observeBackgroundTaskPresentation = (
  observer: BackgroundTaskPresentationObserver | undefined,
  receipt: BackgroundTaskPresentation,
): void => {
  try {
    if (!Predicate.isFunction(observer)) return;
    const result: unknown = observer(receipt);
    if (!Predicate.isObjectOrArray(result) && !Predicate.isFunction(result)) return;
    // SAFETY: only objects and functions can carry a then method.
    const then = (result as { then?: unknown }).then;
    if (Predicate.isFunction(then))
      then.call(
        result,
        () => undefined,
        () => undefined,
      );
  } catch {
    /* Presentation must not change execution. */
  }
};
