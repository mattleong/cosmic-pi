import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core";
import { ACTIVITY_LIMITS } from "./limits.ts";
import type { ActivityItem } from "./protocol.ts";

/** One display line, stripped of terminal controls and redacted, within its own limit. */
const cleanText = (text: string, limit: number) =>
  sanitizeDiagnosticContent(sanitizeTerminalLine(text.slice(0, limit)), { maximumLength: limit });

/**
 * Copies an item and cleans every display field within its own limit; producer and host ingress
 * supply their own detail cleaner.
 */
export const detachActivityItem = (
  item: ActivityItem,
  detail: (value: string) => string,
): ActivityItem => ({
  ...item,
  title: cleanText(item.title, ACTIVITY_LIMITS.title),
  ...(item.parent && { parent: { ...item.parent } }),
  ...(item.profile !== undefined && { profile: cleanText(item.profile, ACTIVITY_LIMITS.profile) }),
  ...(item.route !== undefined && { route: cleanText(item.route, ACTIVITY_LIMITS.route) }),
  ...(item.summary !== undefined && { summary: cleanText(item.summary, ACTIVITY_LIMITS.text) }),
  ...(item.detail !== undefined && { detail: detail(item.detail) }),
  ...(item.phase !== undefined && { phase: cleanText(item.phase, ACTIVITY_LIMITS.phaseTitle) }),
  ...(item.phases && {
    phases: item.phases.map((phase) => ({
      ...phase,
      title: cleanText(phase.title, ACTIVITY_LIMITS.phaseTitle),
      ...(phase.detail !== undefined && { detail: cleanText(phase.detail, ACTIVITY_LIMITS.text) }),
      ...(phase.work && { work: { ...phase.work } }),
    })),
  }),
  ...(item.actions && {
    actions: item.actions.map((action) => ({
      ...action,
      label: cleanText(action.label, ACTIVITY_LIMITS.text),
      ...(action.confirmation !== undefined && {
        confirmation: cleanText(action.confirmation, ACTIVITY_LIMITS.text),
      }),
    })),
  }),
});
