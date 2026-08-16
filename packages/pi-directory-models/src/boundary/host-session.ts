import * as Predicate from "effect/Predicate";

import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";

export interface CapturedDirectorySession {
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
  readonly fresh: boolean;
}

export function captureDirectorySession(
  event: SessionStartEvent,
  ctx: ExtensionContext,
): CapturedDirectorySession | undefined {
  try {
    const cwd = ctx.cwd;
    const signal = ctx.signal;
    if (!Predicate.isString(cwd) || cwd.length === 0) return undefined;
    const hasConversation = ctx.sessionManager.buildContextEntries().some((entry) => {
      if (
        entry.type === "message" ||
        entry.type === "custom_message" ||
        entry.type === "compaction"
      )
        return true;
      return entry.type === "branch_summary" && Predicate.isString(entry.summary);
    });
    const fresh = event.reason === "new" || (event.reason === "startup" && !hasConversation);
    return { cwd, signal, fresh };
  } catch {
    return undefined;
  }
}
