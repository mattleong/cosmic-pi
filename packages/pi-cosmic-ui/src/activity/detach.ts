import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core/security";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { ACTIVITY_LIMITS } from "./limits.ts";
import type { ActivityItem } from "./protocol.ts";

/** One sanitized, credential-redacted line of at most `limit` characters. */
export const cleanLine = (text: string, limit: number): string =>
  sanitizeDiagnosticContent(sanitizeTerminalLine(Fn.pipe(text, Str.slice(0, limit))), {
    maximumLength: limit,
  });

export const detachActivityItem = (
  item: ActivityItem,
  detail: (value: string) => string,
): ActivityItem => ({
  ...item,
  title: cleanLine(item.title, ACTIVITY_LIMITS.title),
  ...(item.parent && { parent: { ...item.parent } }),
  ...(item.profile !== undefined && { profile: cleanLine(item.profile, ACTIVITY_LIMITS.profile) }),
  ...(item.model !== undefined && { model: cleanLine(item.model, ACTIVITY_LIMITS.model) }),
  ...(item.modelDetail !== undefined && {
    modelDetail: cleanLine(item.modelDetail, ACTIVITY_LIMITS.model),
  }),
  ...(item.summary !== undefined && { summary: cleanLine(item.summary, ACTIVITY_LIMITS.text) }),
  ...(item.detail !== undefined && { detail: detail(item.detail) }),
  ...(item.actions && {
    // Copies rather than mutates: the sliced array still holds the producer's action objects.
    actions: Arr.map(item.actions.slice(0, ACTIVITY_LIMITS.actions), (action) => ({
      ...action,
      label: cleanLine(action.label, ACTIVITY_LIMITS.text),
      ...(action.confirmation !== undefined && {
        confirmation: cleanLine(action.confirmation, ACTIVITY_LIMITS.text),
      }),
    })),
  }),
});
