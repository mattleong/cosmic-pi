import type { RunRecord } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
import { appendNoticeSessionEvent } from "./session-events.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText } from "./state.ts";

type RunWarningSource = "child" | "system";

export interface RunWarningSlots {
  readonly child?: string | undefined;
  readonly system?: string | undefined;
}

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
  const warning = system ?? child;
  return warning === undefined ? undefined : sanitizeDiagnosticText(warning, MAX_ERROR_CHARS);
};
