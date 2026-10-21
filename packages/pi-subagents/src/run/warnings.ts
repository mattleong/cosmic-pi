import type { RunRecord } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
import { appendNoticeSessionEvent } from "./session-events.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText } from "./state.ts";

type RunWarningSource = "child" | "system";

/** The latest child and system warnings of the current assignment, and which came last. */
export interface RunWarningSlots {
  readonly child?: string | undefined;
  readonly system?: string | undefined;
  readonly latest?: RunWarningSource | undefined;
}

/** Retains the warning and returns the session events that record its notice. */
export const recordRunWarning = (
  record: RunRecord,
  sessionEvents: SubagentRunView["sessionEvents"],
  source: RunWarningSource,
  warning: string,
  now: number,
  notice = warning,
) => {
  record.warningSlots = { ...record.warningSlots, [source]: warning, latest: source };
  return { sessionEvents: appendNoticeSessionEvent(sessionEvents, "warning", notice, now) };
};

/** The view's warning fields, which a run snapshot derives from its slots. */
export const runWarningFields = ({
  child,
  system,
  latest,
}: RunWarningSlots): Pick<
  SubagentRunView,
  "warning" | "warningSource" | "childWarning" | "systemWarning"
> => {
  const warning = latest && { child, system }[latest];
  return {
    ...(warning !== undefined && { warning, warningSource: latest }),
    ...(child !== undefined && { childWarning: child }),
    ...(system !== undefined && { systemWarning: system }),
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
