// Test harness boundary: the child API requires a controllable Promise-shaped follow-up.
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { SynchronousIngress } from "pi-cosmic-core";
import { AdvisorModelError } from "../../src/runtime/client.ts";
import { makeAdvisorSessionEvents } from "../../src/runtime/session-events.ts";
import type {
  ActiveAdvisorChild,
  ActiveCheckpointFinalization,
  AdvisorChildEvent,
  AdvisorFinalizationCompletion,
} from "../../src/runtime/types.ts";
import { agentSessionFixture } from "../support/agent-session.ts";
import { tick } from "../support/async.ts";

// SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
const makeIngress = <A>(offered: A[]): SynchronousIngress<A> =>
  ({
    offer: (value: A) => {
      offered.push(value);
      return "accepted";
    },
  }) as SynchronousIngress<A>;

const makeChild = (
  epoch: number,
  session: AgentSession,
  offeredEvents: AdvisorChildEvent[] = [],
  offeredFinalizations: AdvisorFinalizationCompletion[] = [],
): ActiveAdvisorChild => ({
  epoch,
  session,
  scope: Scope.makeUnsafe(),
  releaseState: { aborted: false },
  pendingEvents: 0,
  events: makeIngress(offeredEvents),
  finalizations: makeIngress(offeredFinalizations),
});

const makeCheckpoint = (epoch: number): ActiveCheckpointFinalization => ({
  epoch,
  finalPrompt: `finalize-${epoch}`,
  abortRequested: Deferred.makeUnsafe<void>(),
  finalization: Deferred.makeUnsafe<void, AdvisorModelError>(),
  finalizationQueued: false,
});

describe("Advisor session event epoch ownership", () => {
  it("balances an accepted source event after a child rollover", () => {
    const offered: AdvisorChildEvent[] = [];
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const source = makeChild(1, {} as AgentSession, offered);
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const successor = makeChild(2, {} as AgentSession);
    let epoch = 1;
    let activeChild: ActiveAdvisorChild | undefined = source;
    const recordStream = vi.fn();
    const events = makeAdvisorSessionEvents({
      epoch: () => epoch,
      activeChild: () => activeChild,
      activeCheckpoint: () => undefined,
      invalidateForReprime: vi.fn(),
      recordStream,
      recordToolRound: vi.fn(),
      recordStopError: vi.fn(),
      recordUsage: vi.fn(),
    });

    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    events.observeChildEvent(source, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "queued" },
    } as AgentSessionEvent);
    expect(source.pendingEvents).toBe(1);
    expect(offered).toHaveLength(1);

    epoch = 2;
    activeChild = successor;
    Effect.runSync(events.handleChildEventEffect(source, offered[0]!));

    expect(source.pendingEvents).toBe(0);
    expect(recordStream).not.toHaveBeenCalled();
  });

  it.effect("keeps a delayed finalization completion on its originating epoch", () => {
    const followUpGate = Deferred.makeUnsafe<void>();
    const resolveFollowUp = () => void Deferred.doneUnsafe(followUpGate, Effect.void);
    const followUp = vi.fn(() => Effect.runPromise(Deferred.await(followUpGate)));
    return Effect.gen(function* () {
      const finalizations: AdvisorFinalizationCompletion[] = [];
      const session = agentSessionFixture({ isStreaming: true, followUp });
      const child = makeChild(1, session, [], finalizations);
      const originating = makeCheckpoint(1);
      const successor = makeCheckpoint(2);
      let epoch = 1;
      let activeCheckpoint: ActiveCheckpointFinalization | undefined = originating;
      const events = makeAdvisorSessionEvents({
        epoch: () => epoch,
        activeChild: () => child,
        activeCheckpoint: () => activeCheckpoint,
        invalidateForReprime: vi.fn(),
        recordStream: vi.fn(),
        recordToolRound: vi.fn(),
        recordStopError: vi.fn(),
        recordUsage: vi.fn(),
      });

      const eventFixture = {
        type: "message_end" as const,
        message: { role: "assistant" as const, content: [], stopReason: "stop" as const },
      };
      // SAFETY: The message_end observer reads only the fields supplied by this fixture.
      events.observeChildEvent(child, eventFixture as typeof eventFixture & AgentSessionEvent);
      expect(followUp).toHaveBeenCalledWith("finalize-1");

      epoch = 2;
      child.epoch = 2;
      activeCheckpoint = successor;
      resolveFollowUp();
      yield* Effect.promise(() => tick());

      expect(finalizations).toEqual([{ epoch: 1, succeeded: true }]);
      yield* events.handleFinalizationCompletionEffect(finalizations[0]!);
      expect(yield* Deferred.isDone(successor.finalization)).toBe(false);
    });
  });
});
