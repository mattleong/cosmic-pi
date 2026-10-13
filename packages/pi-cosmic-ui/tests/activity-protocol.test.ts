import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  ACTIVITY_HOST,
  ACTIVITY_LIMITS,
  registerActivityProvider,
  registerRevisionedActivityProvider,
  type ActivityItem,
} from "../src/activity/protocol.ts";
import { fakeActivityHost } from "../src/activity/testing.ts";

const agent = (actions: number): ActivityItem => ({
  id: "flow",
  title: "Review",
  kind: "agent",
  status: "running",
  revision: "1",
  actions: Array.from({ length: actions }, (_, index) => ({
    id: index ? `action-${index}` : "stop",
    label: `Action ${index}`,
  })),
});

describe("activity producer protocol", () => {
  it("withholds snapshots beyond the action limit and cleans text before sending", () => {
    let items: readonly ActivityItem[] = [agent(ACTIVITY_LIMITS.actions)];
    const host = fakeActivityHost();
    const registration = registerActivityProvider(host.events, {
      sessionId: "session",
      providerId: "agents",
      snapshot: () => items,
      invoke: () => Promise.resolve(),
    });
    registration.publish();
    expect(host.get()?.items).toHaveLength(1);
    items = [agent(ACTIVITY_LIMITS.actions + 1)];
    registration.publish();
    expect(host.get()?.items).toBeUndefined();
    items = [{ ...agent(1), title: "Find\u001b[31m", summary: "Look\u0007 around" }];
    registration.publish();
    expect(host.get()?.items).toMatchObject([{ title: "Find", summary: "Look around" }]);
    registration.dispose();
  });
  it.effect("stops trusting an invocation once availability changes or the request aborts", () =>
    Effect.gen(function* () {
      const host = fakeActivityHost();
      const checks: Array<() => boolean> = [];
      const dispose = registerRevisionedActivityProvider(host.events, {
        sessionId: "session",
        providerId: "agents",
        isCurrent: () => true,
        items: () => [agent(1)],
        detail: () => "",
        act: (_item, _action, _signal, invocationCurrent) => {
          checks.push(invocationCurrent);
          return Promise.resolve();
        },
        subscriptions: [],
      });
      const invoke = host.capability()!.invoke!;
      const signal = yield* Effect.abortSignal;
      yield* Effect.promise(() => invoke("flow", "stop", "1", signal));
      expect(checks[0]!()).toBe(true);
      const announce = (available: boolean) =>
        host.events.emit(ACTIVITY_HOST, {
          version: 1,
          sessionId: "session",
          hostToken: host.hostToken,
          available,
        });
      announce(false);
      announce(true);
      expect(checks[0]!()).toBe(false);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const scoped = yield* Effect.abortSignal;
          yield* Effect.promise(() => host.capability()!.invoke!("flow", "stop", "1", scoped));
          expect(checks[1]!()).toBe(true);
        }),
      );
      expect(checks[1]!()).toBe(false);
      dispose();
    }),
  );
});
