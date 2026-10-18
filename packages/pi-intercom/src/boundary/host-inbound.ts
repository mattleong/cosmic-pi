import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { invokeHostCallback, latestAssistantText, safeTextPrefix } from "pi-cosmic-core";
import type { IntercomDelivery } from "../delivery.ts";
import {
  IntercomRefused,
  MAX_CWD_CHARS,
  MAX_IDENTITY_CHARS,
  MAX_READ_BYTES,
  type Description,
  type InboundMessage,
  type LastMessage,
  type SessionState,
} from "../transport/protocol.ts";
import type { IntercomInboundContract } from "../transport/server.ts";

const unavailable = () => new IntercomRefused({ code: "session_unavailable" });

const sessionState = (ctx: ExtensionContext): SessionState => (ctx.isIdle() ? "idle" : "busy");

/**
 * Answers peers from the live host session. Each read and delivery happens only while `isCurrent`
 * holds, in the same synchronous callback, so a replaced or shut-down runtime never answers for
 * its successor. Logs name only the disposition or refusal code.
 */
export const hostIntercomInbound = (
  ctx: ExtensionContext,
  isCurrent: () => boolean,
  delivery: Pick<IntercomDelivery, "deliver">,
): IntercomInboundContract => {
  const read = <A>(evaluate: () => A) =>
    Effect.suspend(() => {
      const value = invokeHostCallback(() => (isCurrent() ? evaluate() : undefined), undefined);
      return value === undefined ? Effect.fail(unavailable()) : Effect.succeed(value);
    });

  const describe = read((): Description => {
    const name = ctx.sessionManager.getSessionName();
    return {
      sessionId: safeTextPrefix(ctx.sessionManager.getSessionId(), MAX_IDENTITY_CHARS),
      ...(name !== undefined && { name: safeTextPrefix(name, MAX_IDENTITY_CHARS) }),
      cwd: safeTextPrefix(ctx.cwd, MAX_CWD_CHARS),
      state: sessionState(ctx),
    };
  });

  const readLast = read((): LastMessage => {
    const latest = latestAssistantText(ctx.sessionManager.getBranch(), MAX_READ_BYTES);
    return {
      ...(latest !== undefined && { text: latest.text }),
      truncated: latest?.truncated ?? false,
      state: sessionState(ctx),
    };
  });

  const deliver = (message: InboundMessage) =>
    Effect.suspend(() => {
      const outcome = invokeHostCallback(
        () => delivery.deliver(message, isCurrent),
        Result.fail("session_unavailable" as const),
      );
      return Result.isSuccess(outcome)
        ? Effect.logDebug("Took a message from another session.").pipe(
            Effect.annotateLogs({ disposition: outcome.success }),
            Effect.as(outcome.success),
          )
        : Effect.logDebug("Refused a message from another session.").pipe(
            Effect.annotateLogs({ refusal: outcome.failure }),
            Effect.andThen(Effect.fail(new IntercomRefused({ code: outcome.failure }))),
          );
    });

  return { describe, readLast, deliver };
};
