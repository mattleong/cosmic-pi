import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import { captureSessionHost, invokeHostCallback } from "pi-cosmic-core/host-session";
import type { IntercomSessionInput } from "../session/service.ts";

/** Only sessions another agent can address and a user can see: the TUI and RPC clients. */
const isReachableMode = (ctx: ExtensionContext): boolean =>
  invokeHostCallback(() => ctx.mode === "tui" || ctx.mode === "rpc", false);

/** The session to register, or undefined when this session should stay unregistered. */
export const captureIntercomSession = (ctx: ExtensionContext) => {
  if (!isReachableMode(ctx)) return undefined;
  const host = captureSessionHost(ctx);
  if (!Predicate.isTagged(host, "Captured")) return undefined;
  const identity = invokeHostCallback(
    () => ({
      sessionId: ctx.sessionManager.getSessionId(),
      name: ctx.sessionManager.getSessionName(),
    }),
    undefined,
  );
  if (identity === undefined || identity.sessionId === "") return undefined;
  const session: IntercomSessionInput = { ...identity, cwd: host.cwd };
  return { session, signal: host.signal };
};
