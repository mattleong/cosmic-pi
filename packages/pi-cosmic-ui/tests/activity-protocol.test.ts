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

const workflow = (phases: number): ActivityItem => ({
  id: "flow",
  title: "Review",
  kind: "workflow",
  status: "running",
  revision: "1",
  phases: Array.from({ length: phases }, (_, index) => ({ title: `Phase ${index}` })),
  actions: [{ id: "stop", label: "Stop workflow" }],
});

describe("activity producer protocol", () => {
  it("withholds snapshots beyond the phase limit and cleans phase text before sending", () => {
    let items: readonly ActivityItem[] = [workflow(ACTIVITY_LIMITS.phases)];
    const host = fakeActivityHost();
    const registration = registerActivityProvider(host.events, {
      sessionId: "session",
      providerId: "agents",
      snapshot: () => items,
      invoke: () => Promise.resolve(),
    });
    registration.publish();
    expect(host.get()?.items).toHaveLength(1);
    items = [workflow(ACTIVITY_LIMITS.phases + 1)];
    registration.publish();
    expect(host.get()?.items).toBeUndefined();
    items = [
      {
        ...workflow(0),
        phases: [{ title: "Find\u001b[31m", detail: "Look\u0007 around" }],
        phase: "Find\u001b[31m",
      },
    ];
    registration.publish();
    expect(host.get()?.items).toMatchObject([
      { phases: [{ title: "Find", detail: "Look around" }], phase: "Find" },
    ]);
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
        items: () => [workflow(1)],
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
