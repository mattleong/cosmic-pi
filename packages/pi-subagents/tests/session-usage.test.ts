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
  fakeNativeReportBackendLayer,
  nativeReportRequest,
  nativeReportServiceFixture,
  profileLayerFor,
  withService,
} from "./run/fixtures/service-harness.ts";
import { stringContaining } from "./support/matchers.ts";

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

describe("session subagent spend", () => {
  it.effect(
    "records settled and shutdown usage in the session, then restores the spend limit",
    () =>
      Effect.gen(function* () {
        const host = hostSession();
        const recorded: SubagentUsage[] = [];
        const record = sessionUsageRecorder(host.pi, host.ctx);
        const first = nativeReportServiceFixture(
          fakeNativeReportBackendLayer(),
          {
            recordSessionUsage: (usage) => {
              recorded.push(usage);
              record(usage);
            },
          },
          profileLayerFor({ version: 6, sessionSpendLimit: 0.5 }),
        );
        yield* withService(first.layer, function* (service) {
          const settled = yield* service.start(nativeReportRequest());
          const control = first.backend.controls[0]!;
          control.offer({ type: "usage", usage: charge(0.25) });
          yield* yieldUntil(() => first.projections.at(-1)?.runs[0]?.usage.cost === 0.25, 200);
          expect(recorded).toEqual([]);
          control.report(settled.id, 1, "report", "Done");
          yield* yieldUntil(() => recorded.length === 1, 200);

          yield* service.start(nativeReportRequest());
          first.backend.controls[1]!.offer({ type: "usage", usage: charge(0.5) });
          yield* yieldUntil(() => first.projections.at(-1)?.sessionUsage?.cost === 0.75, 200);
          expect(recorded).toHaveLength(1);
        });
        expect(recorded.map((usage) => usage.cost)).toEqual([0.25, 0.5]);

        const second = nativeReportServiceFixture(
          fakeNativeReportBackendLayer(),
          { restoredSessionUsage: restoreSessionUsage(host.ctx) },
          profileLayerFor({ version: 6, sessionSpendLimit: 0.5 }),
        );
        yield* withService(second.layer, function* (service) {
          expect((yield* service.projection).sessionUsage?.cost).toBe(0.75);
          expect(yield* service.start(nativeReportRequest()).pipe(Effect.flip)).toMatchObject({
            code: "session_spend_limit",
          });
        });
      }),
  );

  it.effect("refuses every start while the only declared spend limit is invalid", () =>
    Effect.gen(function* () {
      const { layer, backend } = nativeReportServiceFixture(
        fakeNativeReportBackendLayer(),
        {},
        profileLayerFor({ version: 6 }, { version: 6, sessionSpendLimit: "10" }),
      );
      yield* withService(layer, function* (service) {
        expect(yield* service.start(nativeReportRequest()).pipe(Effect.flip)).toMatchObject({
          code: "session_spend_limit_invalid",
          message: stringContaining("project.sessionSpendLimit"),
        });
        expect(backend.controls).toHaveLength(0);
      });
    }),
  );

  it.effect("applies another scope's valid spend limit over an invalid one", () =>
    Effect.gen(function* () {
      const { layer, backend, projections } = nativeReportServiceFixture(
        fakeNativeReportBackendLayer(),
        {},
        profileLayerFor(
          { version: 6, sessionSpendLimit: 0.5 },
          { version: 6, sessionSpendLimit: 0 },
        ),
      );
      yield* withService(layer, function* (service) {
        yield* service.start(nativeReportRequest());
        backend.controls[0]!.offer({ type: "usage", usage: charge(0.5) });
        yield* yieldUntil(() => projections.at(-1)?.sessionUsage?.cost === 0.5, 200);
        expect(yield* service.start(nativeReportRequest()).pipe(Effect.flip)).toMatchObject({
          code: "session_spend_limit",
          limit: 0.5,
        });
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
