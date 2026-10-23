import * as Predicate from "effect/Predicate";
import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { captureSessionHost, invokeHostCallback } from "pi-cosmic-core";

export function captureDirectorySession(event: SessionStartEvent, ctx: ExtensionContext) {
  const host = captureSessionHost(ctx);
  if (!Predicate.isTagged(host, "Captured")) return undefined;
  const fresh =
    event.reason === "startup"
      ? invokeHostCallback(
          () => ctx.sessionManager.buildSessionProjection().messages.length === 0,
          undefined,
        )
      : event.reason === "new";
  return fresh === undefined ? undefined : { cwd: host.cwd, signal: host.signal, fresh };
}
