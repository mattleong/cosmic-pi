import { MAX_ERROR_CHARS, sanitizeDiagnosticText } from "./state.ts";

export type RunWarningSource = "child" | "system";

/** Latest warning from each source; full warning history remains in bounded session events. */
export interface RunWarningSlots {
  readonly child?: string | undefined;
  readonly system?: string | undefined;
}

export const emptyRunWarningSlots = (): RunWarningSlots => ({});

export const setRunWarning = (
  slots: RunWarningSlots,
  source: RunWarningSource,
  warning: string,
): RunWarningSlots => ({ ...slots, [source]: warning });

export const projectRunWarning = (slots: RunWarningSlots, source: RunWarningSource) => ({
  warning: slots[source],
  warningSource: source,
  systemWarning: slots.system,
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
  return sanitizeDiagnosticText((system ?? child)!, MAX_ERROR_CHARS);
};
