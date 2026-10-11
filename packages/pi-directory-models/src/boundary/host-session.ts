import {
  buildSessionContext,
  type ExtensionContext,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { captureSessionHost, invokeHostCallback } from "pi-cosmic-core";

export function captureDirectorySession(event: SessionStartEvent, ctx: ExtensionContext) {
  const host = captureSessionHost(ctx);
  if (host._tag === "Unavailable") return undefined;
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
