import * as Predicate from "effect/Predicate";
import type { GuidedText } from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
import { appendNoticeSessionEvent } from "./session-events.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText } from "./state.ts";

type RunWarningSource = "child" | "system";

/** The latest child and system warnings of the current assignment, and which came last. */
export interface RunWarningSlots {
  readonly child?: string | undefined;
  readonly system?: string | undefined;
  /** `system` without the agent procedure it carries; absent when they match. */
  readonly systemUser?: string | undefined;
  readonly latest?: RunWarningSource | undefined;
}

/**
 * Retains the warning and returns the session events that record its notice. A system warning's
 * user copy, when it has one, is what Activity's notice shows.
 */
export const recordRunWarning = (
  record: RunRecord,
  sessionEvents: SubagentRunView["sessionEvents"],
  source: RunWarningSource,
  warning: string | GuidedText,
  now: number,
  notice?: string,
) => {
  const text = Predicate.isString(warning) ? warning : warning.message;
  const user = Predicate.isString(warning) ? warning : warning.userMessage;
  // A new system warning replaces the previous one's user copy too.
  const kept = source === "system" ? { child: record.warningSlots.child } : record.warningSlots;
  record.warningSlots = {
    ...kept,
    [source]: text,
    ...(source === "system" && user !== text && { systemUser: user }),
    latest: source,
  };
  return {
    sessionEvents: appendNoticeSessionEvent(sessionEvents, "warning", notice ?? user, now),
  };
};

/** The view's warning fields, which a run snapshot derives from its slots. */
export const runWarningFields = ({
  child,
  system,
  systemUser,
  latest,
}: RunWarningSlots): Pick<
  SubagentRunView,
  "warning" | "warningSource" | "childWarning" | "systemWarning" | "userSystemWarning"
> => {
  const warning = latest && { child, system }[latest];
  return {
    ...(warning !== undefined && { warning, warningSource: latest }),
    ...(child !== undefined && { childWarning: child }),
    ...(system !== undefined && { systemWarning: system }),
    ...(systemUser !== undefined && { userSystemWarning: systemUser }),
  };
};

/** A view's failure and warnings as the user reads them, without agent procedures. */
export const userRunText = (
  run: Pick<
    SubagentRunView,
    "error" | "userError" | "warning" | "warningSource" | "systemWarning" | "userSystemWarning"
  >,
) => {
  const systemWarning = run.userSystemWarning ?? run.systemWarning;
  return {
    error: run.userError ?? run.error,
    warning: run.warningSource === "system" ? systemWarning : run.warning,
    systemWarning,
  };
};

/** The retained child and system warnings; an identical pair shows once, under the latest source. */
export const distinctRunWarnings = (
  run: Pick<SubagentRunView, "childWarning" | "systemWarning" | "warningSource">,
): RunWarningSlots => {
  if (run.childWarning === undefined || run.childWarning !== run.systemWarning)
    return { child: run.childWarning, system: run.systemWarning };
  return run.warningSource === "system"
    ? { system: run.systemWarning }
    : { child: run.childWarning };
};

/** `foldRunWarnings` as the user reads it, with the system warning's user copy. */
export const foldUserRunWarnings = (slots: RunWarningSlots): string | undefined =>
  slots.systemUser === undefined
    ? foldRunWarnings(slots)
    : foldRunWarnings({
        child: slots.child === slots.system ? undefined : slots.child,
        system: slots.systemUser,
      });

export const foldRunWarnings = (slots: RunWarningSlots): string | undefined => {
  const child = slots.child;
  const system = slots.system;
  if (!child && !system) return undefined;
  if (child && system && child !== system) {
    const labelsLength = "System warning: \nChild warning: ".length;
    const perWarningLimit = Math.max(1, Math.floor((MAX_ERROR_CHARS - labelsLength) / 2));
    return `System warning: ${sanitizeDiagnosticText(system, perWarningLimit)}\nChild warning: ${sanitizeDiagnosticText(child, perWarningLimit)}`;
  }
  const warning = system ?? child;
  return warning === undefined ? undefined : sanitizeDiagnosticText(warning, MAX_ERROR_CHARS);
};
