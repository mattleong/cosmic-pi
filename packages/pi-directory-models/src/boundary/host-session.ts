import {
  buildSessionContext,
  type ExtensionContext,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { captureSessionHost, invokeHostCallback } from "pi-cosmic-core";

/** Captures cwd, signal, and freshness; undefined means the session is unavailable. */
export function captureDirectorySession(event: SessionStartEvent, ctx: ExtensionContext) {
  const host = captureSessionHost(ctx);
  if (host._tag === "Unavailable") return undefined;
  // Only startup resolves the active leaf; other starts never read session entries.
  const fresh =
    event.reason === "startup"
      ? invokeHostCallback(
          () =>
            buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId())
              .messages.length === 0,
          undefined,
        )
      : event.reason === "new";
  return fresh === undefined ? undefined : { cwd: host.cwd, signal: host.signal, fresh };
}
