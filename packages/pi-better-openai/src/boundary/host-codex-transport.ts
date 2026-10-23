import { cleanupSessionResources } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { invokeBestEffort, invokeHostCallback } from "pi-cosmic-core/host-session";

// Pi resolves the pi-ai root import to its own copy, which owns the pooled Codex WebSockets.
// Closing them makes the next request reconnect with current routing headers. Without a session id
// pi-ai cleans up every session, so an empty id resets nothing.
export function resetOpenAICodexTransport(ctx: ExtensionContext): void {
  invokeBestEffort(() => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (sessionId) cleanupSessionResources(sessionId);
  });
}

export interface CodexTransportReset {
  /** Resets while the session is idle; otherwise defers the reset to the next provider request. */
  readonly request: (ctx: ExtensionContext) => void;
  /** Performs a deferred reset before the provider request acquires its socket. */
  readonly beforeProviderRequest: (ctx: ExtensionContext) => void;
  /** Drops a deferred reset when its session retires. */
  readonly discard: () => void;
}

// Pi closes pooled sockets even when a reply is streaming over them, so a busy session defers the
// reset to the next provider headers, which Pi emits before a request acquires its socket. Pi's
// cache warmer replays requests through the same hook and may do so mid-reply; this assumes it never
// warms Codex, which holds while Codex models have no `promptCache` lifetimes (as in Pi 1.4's
// catalog; a models.json override could add them).
export function createCodexTransportReset(
  reset: (ctx: ExtensionContext) => void,
): CodexTransportReset {
  let pending = false;
  const resetNow = (ctx: ExtensionContext) => {
    pending = false;
    reset(ctx);
  };
  return {
    request: (ctx) => {
      if (invokeHostCallback(() => ctx.isIdle(), false)) resetNow(ctx);
      else pending = true;
    },
    beforeProviderRequest: (ctx) => {
      if (pending) resetNow(ctx);
    },
    discard: () => {
      pending = false;
    },
  };
}
