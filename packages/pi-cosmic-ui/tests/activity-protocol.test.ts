import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ACTIVITY_HOST,
  ACTIVITY_LIMITS,
  ActivitySnapshotSchema,
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
const ids = (entries: ReadonlyArray<{ readonly id: string }> | undefined) =>
  entries === undefined ? undefined : Arr.map(entries, (entry) => entry.id);

describe("activity producer protocol", () => {
  it("publishes the bounded prefix of oversized snapshots and cleans text before sending", () => {
    const item = (index: number, actions: number): ActivityItem => ({
      ...agent(actions),
      id: `flow-${index}`,
    });
    let items: readonly ActivityItem[] = Array.from(
      { length: ACTIVITY_LIMITS.items + 3 },
      (_, index) => item(index, index === 0 ? ACTIVITY_LIMITS.actions + 4 : 1),
    );
    const host = fakeActivityHost();
    const registration = registerActivityProvider(host.events, {
      sessionId: "session",
      providerId: "agents",
      snapshot: () => items,
      invoke: () => Promise.resolve(),
    });
    registration.publish();
    const published = Schema.decodeUnknownSync(ActivitySnapshotSchema)(host.get()?.items);
    expect(ids(published)).toEqual(ids(items.slice(0, ACTIVITY_LIMITS.items)));
    expect(ids(published[0]?.actions)).toEqual(
      ids(items[0]?.actions?.slice(0, ACTIVITY_LIMITS.actions)),
    );
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
      yield* Effect.promise(() => Promise.resolve<unknown>(invoke("flow", "stop", "1", signal)));
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
          yield* Effect.promise(() =>
            Promise.resolve<unknown>(host.capability()!.invoke!("flow", "stop", "1", scoped)),
          );
          expect(checks[1]!()).toBe(true);
        }),
      );
      expect(checks[1]!()).toBe(false);
      dispose();
    }),
  );
});
