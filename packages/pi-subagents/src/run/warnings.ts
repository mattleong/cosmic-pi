import type { RunRecord } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
import { appendNoticeSessionEvent } from "./session-events.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText } from "./state.ts";

export type RunWarningSource = "child" | "system";

/** Latest warning from each source; full warning history remains in bounded session events. */
export interface RunWarningSlots {
  readonly child?: string | undefined;
  readonly system?: string | undefined;
}

export const emptyRunWarningSlots = (): RunWarningSlots => ({});

/**
 * Records `warning` in its source slot and returns the projected warning fields plus a `notice`
 * appended to `sessionEvents`. Callers sanitize `warning` and hold the service lock.
 */
export const recordRunWarning = (
  record: RunRecord,
  sessionEvents: SubagentRunView["sessionEvents"],
  source: RunWarningSource,
  warning: string,
  now: number,
  notice = warning,
) => {
  record.warningSlots = { ...record.warningSlots, [source]: warning };
  return {
    warning,
    warningSource: source,
    systemWarning: record.warningSlots.system,
    sessionEvents: appendNoticeSessionEvent(sessionEvents, "warning", notice, now),
  };
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
  return sanitizeDiagnosticText((system ?? child)!, MAX_ERROR_CHARS);
};
