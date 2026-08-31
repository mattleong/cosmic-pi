import {
  buildSessionContext,
  type ExtensionContext,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { captureSessionHost, invokeHostCallback } from "pi-cosmic-core";

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
  if (event.reason === "new") return { cwd: host.cwd, signal: host.signal, fresh: true };
  if (event.reason !== "startup") return { cwd: host.cwd, signal: host.signal, fresh: false };

  const sessionContext = invokeHostCallback(
    () => buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()),
    undefined,
  );
  if (!sessionContext) return undefined;
  return { cwd: host.cwd, signal: host.signal, fresh: sessionContext.messages.length === 0 };
}
