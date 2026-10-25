import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { extensionApiFixture, extensionContextFixture, yieldUntil } from "pi-cosmic-core/testing";
import {
  restoreSessionUsage,
  SUBAGENT_USAGE_ENTRY_TYPE,
  sessionUsageRecorder,
} from "../src/boundary/host-session-usage.ts";
import { emptyUsage, type SubagentUsage } from "../src/run/model.ts";
import {
  fakeEventBackendLayer,
  eventBackendRequest,
  eventBackendServiceFixture,
  withService,
} from "./run/fixtures/service-harness.ts";
import * as Arr from "effect/Array";

const charge = (cost: number): SubagentUsage => ({
  ...emptyUsage(),
  input: 10,
  totalTokens: 10,
  cost,
});

const hostSession = () => {
  const sessionManager = SessionManager.inMemory(process.cwd());
  const ctx = extensionContextFixture({ sessionManager });
  const pi = extensionApiFixture({
    appendEntry: (customType, data) => void sessionManager.appendCustomEntry(customType, data),
  });
  return { sessionManager, ctx, pi };
};

describe("session subagent usage", () => {
  it.effect("records settled and shutdown usage in the session, then restores it", () =>
    Effect.gen(function* () {
      const host = hostSession();
      const recorded: SubagentUsage[] = [];
      const record = sessionUsageRecorder(host.pi, host.ctx);
      const first = eventBackendServiceFixture(fakeEventBackendLayer(), {
        recordSessionUsage: (usage) => {
          recorded.push(usage);
          record(usage);
        },
      });
      yield* withService(first.layer, function* (service) {
        yield* service.start(eventBackendRequest());
        const control = first.backend.controls[0]!;
        control.offer({ type: "usage", usage: charge(0.25) });
        yield* yieldUntil(() => first.projections.at(-1)?.runs[0]?.usage.cost === 0.25, 200);
        expect(recorded).toEqual([]);
        control.complete("Done");
        yield* yieldUntil(() => recorded.length === 1, 200);

        yield* service.start(eventBackendRequest());
        first.backend.controls[1]!.offer({ type: "usage", usage: charge(0.5) });
        yield* yieldUntil(() => first.projections.at(-1)?.sessionUsage?.cost === 0.75, 200);
        expect(recorded).toHaveLength(1);
      });
      expect(Arr.map(recorded, (usage) => usage.cost)).toEqual([0.25, 0.5]);

      const second = eventBackendServiceFixture(fakeEventBackendLayer(), {
        restoredSessionUsage: restoreSessionUsage(host.ctx),
      });
      yield* withService(second.layer, function* (service) {
        expect((yield* service.projection).sessionUsage?.cost).toBe(0.75);
      });
    }),
  );

  it("restores usage from every branch of the session, skipping malformed entries", () => {
    const { sessionManager, ctx, pi } = hostSession();
    const record = sessionUsageRecorder(pi, ctx);
    const root = sessionManager.appendCustomEntry("marker", {});
    record(charge(0.5));
    sessionManager.branch(root);
    record(charge(0.25));
    sessionManager.appendCustomEntry(SUBAGENT_USAGE_ENTRY_TYPE, { version: 1, cost: "free" });

    expect(restoreSessionUsage(ctx)).toMatchObject({ input: 20, totalTokens: 20, cost: 0.75 });
  });

  it("drops usage recorded after the session was replaced", () => {
    const { sessionManager, ctx, pi } = hostSession();
    const record = sessionUsageRecorder(pi, ctx);
    sessionManager.newSession();
    record(charge(0.5));

    expect(restoreSessionUsage(ctx)).toEqual(emptyUsage());
  });
});
