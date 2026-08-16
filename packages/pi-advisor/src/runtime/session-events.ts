import * as Predicate from "effect/Predicate";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SynchronousIngressOfferResult } from "pi-cosmic-core";
import { snapshotData } from "../domain/safe-data.ts";
import { AdvisorModelError } from "./client.ts";
import { isolateCallback, isToolCallDelta } from "./session.ts";
import {
  AdvisorUsageWireSchema,
  type ActiveAdvisorChild,
  type ActiveCheckpointFinalization,
  type AdvisorChildEvent,
  type AdvisorFinalizationCompletion,
} from "./types.ts";

const AdvisorMessageEndSnapshotSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  stopReason: Schema.optional(Schema.Unknown),
  errorMessage: Schema.optional(Schema.Unknown),
  usage: Schema.optional(Schema.Unknown),
});

interface AdvisorSessionEventPort {
  readonly epoch: () => number;
  readonly activeChild: () => ActiveAdvisorChild | undefined;
  readonly activeCheckpoint: () => ActiveCheckpointFinalization | undefined;
  readonly invalidateForReprime: (message: string) => void;
  readonly recordStream: (kind: "thinking" | "text" | "tool" | undefined, text: string) => void;
  readonly recordToolRound: () => void;
  readonly recordStopError: (message: string) => void;
  readonly recordUsage: (usage: {
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly cost: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  }) => void;
}

export const makeAdvisorSessionEvents = (port: AdvisorSessionEventPort) => {
  const offerChildEvent = (child: ActiveAdvisorChild, event: AdvisorChildEvent): void => {
    child.pendingEvents++;
    const result: SynchronousIngressOfferResult = child.events.offer(event);
    if (result !== "accepted") {
      child.pendingEvents--;
      port.invalidateForReprime("Advisor child event ingress overflowed.");
    }
  };

  const observeChildEvent = (child: ActiveAdvisorChild, event: AgentSessionEvent): void => {
    try {
      if (child.epoch !== port.epoch() || port.activeChild() !== child) return;
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta" || update.type === "thinking_delta") {
          offerChildEvent(child, {
            epoch: child.epoch,
            type: "stream",
            streamKind: update.type === "thinking_delta" ? "thinking" : "text",
            text: update.delta,
          });
        } else if (isToolCallDelta(update)) {
          offerChildEvent(child, {
            epoch: child.epoch,
            type: "stream",
            streamKind: "tool",
            text: update.delta,
          });
        }
        return;
      }
      if (event.type === "turn_end") {
        if (event.toolResults.length > 0)
          offerChildEvent(child, { epoch: child.epoch, type: "tool-round" });
        return;
      }
      if (event.type !== "message_end") return;
      const decodedMessage = Schema.decodeUnknownOption(AdvisorMessageEndSnapshotSchema)(
        snapshotData(event.message),
      );
      if (Option.isNone(decodedMessage)) return;
      const messageSnapshot = decodedMessage.value;
      const stopReason = Predicate.isString(messageSnapshot.stopReason)
        ? messageSnapshot.stopReason
        : undefined;
      const active = port.activeCheckpoint();
      if (
        active &&
        active.epoch === child.epoch &&
        !active.finalizationQueued &&
        stopReason === "stop" &&
        child.session.isStreaming
      ) {
        active.finalizationQueued = true;
        const finalizationEpoch = active.epoch;
        try {
          // AgentSession requires followUp to be invoked before this streaming callback returns.
          void child.session.followUp(active.finalPrompt).then(
            () => child.finalizations.offer({ epoch: finalizationEpoch, succeeded: true }),
            () => child.finalizations.offer({ epoch: finalizationEpoch, succeeded: false }),
          );
        } catch {
          child.finalizations.offer({ epoch: finalizationEpoch, succeeded: false });
        }
      }
      const messageEnd: AdvisorChildEvent = {
        epoch: child.epoch,
        type: "message-end",
        usage: snapshotData(messageSnapshot.usage),
      };
      const withStopReason = stopReason === undefined ? messageEnd : { ...messageEnd, stopReason };
      offerChildEvent(
        child,
        Predicate.isString(messageSnapshot.errorMessage)
          ? { ...withStopReason, errorMessage: messageSnapshot.errorMessage }
          : withStopReason,
      );
    } catch {
      port.invalidateForReprime("Advisor child event boundary failed.");
    }
  };

  const awaitChildEventsEffect = (epoch: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      const child = port.activeChild();
      return !child || child.epoch !== epoch || child.pendingEvents === 0
        ? Effect.void
        : Effect.yieldNow.pipe(Effect.andThen(awaitChildEventsEffect(epoch)));
    });

  const handleChildEventEffect = (source: ActiveAdvisorChild, event: AdvisorChildEvent) =>
    Effect.sync(() => {
      const child = port.activeChild();
      if (event.epoch !== port.epoch() || !child || child !== source || child.epoch !== event.epoch)
        return;
      if (event.type === "stream") {
        port.recordStream(event.streamKind, event.text ?? "");
        return;
      }
      if (event.type === "tool-round") {
        port.recordToolRound();
        return;
      }
      if (event.stopReason === "aborted") port.recordStopError("Advisor review was aborted.");
      if (event.stopReason === "error")
        port.recordStopError(event.errorMessage || "Advisor review failed.");
      const usage = Schema.decodeUnknownOption(AdvisorUsageWireSchema)(event.usage);
      if (Option.isNone(usage)) return;
      isolateCallback(() =>
        port.recordUsage({
          cacheReadTokens: usage.value.cacheRead ?? 0,
          cacheWriteTokens: usage.value.cacheWrite ?? 0,
          cost: usage.value.cost?.total ?? 0,
          inputTokens: usage.value.input ?? 0,
          outputTokens: usage.value.output ?? 0,
          totalTokens: usage.value.totalTokens ?? 0,
        }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (source.pendingEvents > 0) source.pendingEvents--;
        }),
      ),
    );

  const handleFinalizationCompletionEffect = (completion: AdvisorFinalizationCompletion) => {
    const active = port.activeCheckpoint();
    if (!active || active.epoch !== completion.epoch) return Effect.void;
    return completion.succeeded
      ? Deferred.succeed(active.finalization, undefined).pipe(Effect.asVoid)
      : Deferred.fail(
          active.finalization,
          new AdvisorModelError({ message: "Advisor checkpoint finalization failed." }),
        ).pipe(Effect.asVoid);
  };

  return {
    observeChildEvent,
    awaitChildEventsEffect,
    handleChildEventEffect,
    handleFinalizationCompletionEffect,
  } as const;
};
