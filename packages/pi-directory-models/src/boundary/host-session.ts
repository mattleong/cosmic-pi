import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import { captureSessionHost } from "pi-cosmic-core";

export interface CapturedDirectorySession {
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
  readonly fresh: boolean;
}

export function captureDirectorySession(
  event: SessionStartEvent,
  ctx: ExtensionContext,
): CapturedDirectorySession | undefined {
  const host = captureSessionHost(ctx);
  if (host._tag === "Unavailable") return undefined;
  try {
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
    return { cwd: host.cwd, signal: host.signal, fresh };
  } catch {
    return undefined;
  }
}
