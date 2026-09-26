import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
  decodeFormOutcome,
  queryOwnedFormCapability,
  type ExtensionFormOwner,
  type OwnedFormCapability,
  type OwnedFormRequest,
} from "pi-ask-user/protocol";
import { boundaryError } from "../client/errors.ts";
import type { McpInteractionHost } from "../interaction/model.ts";
import { makeElicitationBrowser } from "./host-elicitation-browser.ts";

// A new session/runtime must not bypass unresolved foreign UI ownership. Entries are
// removed only by the exact successful cancel settlement, never by waiter timeout.
const pendingCleanup = new Set<object>();
const cleanupWaitMs = 1_000;

/** One current, same-stable-session local form capability. No direct MCP dialogs or relay. */
export const makeAskUserHost = (
  pi: Pick<ExtensionAPI, "events" | "exec">,
  sessionId: string | undefined,
  isCurrent: () => boolean,
): McpInteractionHost => {
  const browser = makeElicitationBrowser(pi);
  const available = (): OwnedFormCapability | undefined => {
    try {
      return pendingCleanup.size === 0 && sessionId && isCurrent()
        ? queryOwnedFormCapability(pi.events, sessionId)
        : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    resolve: Effect.sync(() => {
      const capability = available();
      if (!capability) return undefined;
      const current = (): boolean => {
        const next = available();
        return (
          next?.generation === capability.generation &&
          next.ask === capability.ask &&
          next.cancel === capability.cancel
        );
      };
      return {
        current: Effect.sync(current),
        openBrowser: browser,
        ask: (request: OwnedFormRequest, owner: ExtensionFormOwner) =>
          Effect.gen(function* () {
            if (!current())
              return yield* boundaryError("stale", "unknown", "MCP input provider was revoked.");
            let joined = false;
            const cleanup = Effect.suspend(() => {
              const fence = {};
              pendingCleanup.add(fence);
              // Track native settlement independently of the interruptible Effect waiter.
              const settlement = Promise.resolve().then(() => capability.cancel(owner));
              void settlement.then(
                () => pendingCleanup.delete(fence),
                () => undefined,
              );
              return Effect.tryPromise(() => settlement).pipe(
                Effect.interruptible,
                Effect.timeout(cleanupWaitMs),
                Effect.tap(() =>
                  Effect.sync(() => {
                    joined = true;
                  }),
                ),
                Effect.ignore,
              );
            });
            const outcome = yield* Effect.tryPromise({
              try: (signal) => capability.ask(request, owner, signal),
              catch: () =>
                boundaryError("cancelled", "unknown", "MCP user input did not complete."),
            }).pipe(Effect.ensuring(Effect.uninterruptible(cleanup)));
            if (!joined)
              return yield* boundaryError(
                "cleanup",
                "unknown",
                "MCP user input cleanup is unconfirmed.",
              );
            if (!current())
              return yield* boundaryError("stale", "unknown", "MCP input provider was revoked.");
            const decoded = decodeFormOutcome(outcome);
            if (!decoded)
              return yield* boundaryError(
                "invalid-input",
                "unknown",
                "MCP user input was invalid.",
              );
            return decoded;
          }),
      };
    }),
  };
};
