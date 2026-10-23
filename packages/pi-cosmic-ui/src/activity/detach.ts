import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { ACTIVITY_LIMITS } from "./limits.ts";
import type { ActivityItem } from "./protocol.ts";

const cleanText = (text: string, limit: number) =>
  sanitizeDiagnosticContent(sanitizeTerminalLine(Fn.pipe(text, Str.slice(0, limit))), {
    maximumLength: limit,
  });

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
  ...(item.actions && {
    // Copies rather than mutates: the sliced array still holds the producer's action objects.
    actions: Arr.map(item.actions.slice(0, ACTIVITY_LIMITS.actions), (action) => ({
      ...action,
      label: cleanText(action.label, ACTIVITY_LIMITS.text),
      ...(action.confirmation !== undefined && {
        confirmation: cleanText(action.confirmation, ACTIVITY_LIMITS.text),
      }),
    })),
  }),
});
