import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeSessionCapabilityProtocol } from "pi-cosmic-core";
import { ActivityError } from "../src/activity/service.ts";
import { ACTIVITY_VIEW_DISCOVER, discoverActivityView } from "../src/activity/view-protocol.ts";
import { eventBus } from "./support/host.ts";

const queries = makeSessionCapabilityProtocol({ version: 1 });

const discoverOpener = (open: () => Promise<boolean> | string) => {
  const { events } = eventBus();
  events.on(ACTIVITY_VIEW_DISCOVER, (data) =>
    queries
      .normalizeQuery(data)
      ?.respond({ version: 1, sessionId: "session", hostToken: {}, open }),
  );
  return discoverActivityView(events, "session");
};

const opening = (view: ReturnType<typeof discoverOpener>) =>
  Effect.tryPromise(() => view?.open("tasks") ?? Promise.resolve(false));

describe("activity view discovery", () => {
  it.effect("opens through a valid foreign opener", () =>
    Effect.gen(function* () {
      expect(yield* opening(discoverOpener(() => Promise.resolve(true)))).toBe(true);
    }),
  );

  it.effect("rejects instead of throwing when the opener returns garbage or throws", () =>
    Effect.gen(function* () {
      const garbage = yield* Effect.flip(opening(discoverOpener(() => "opened")));
      expect(garbage.cause).toEqual(ActivityError.make({ reason: "failed" }));
      const hostile = discoverOpener(() => {
        throw new Error("hostile opener");
      });
      expect((yield* Effect.flip(opening(hostile))).cause).toEqual(new Error("hostile opener"));
    }),
  );
});
