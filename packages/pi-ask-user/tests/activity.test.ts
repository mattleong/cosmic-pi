import { routeRequest as request } from "./support/questionnaire.ts";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { makeActivityFixture as fixture } from "./support/activity.ts";

it.effect("publishes queued, mounted, hidden and settled questions without copying answers", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.activity.observer.admitted("one", request, Effect.void);
    expect(f.provider.snapshot()[0]?.status).toBe("pending");
    expect(f.provider.snapshot()[0]?.parent).toBeUndefined();
    yield* f.activity.observer.presenting("one");
    const token = f.bridge.activate(() => {});
    f.bridge.markOpened(token);
    expect(f.provider.snapshot()[0]).toMatchObject({ status: "needs-input", inputTarget: "user" });
    f.bridge.markCollapsed(token);
    const hidden = f.provider.snapshot()[0]!;
    expect(hidden.actions?.some((action) => action.id === "resume")).toBe(true);
    yield* f.invoke("one", "resume", hidden.revision);
    expect(f.provider.snapshot()[0]?.actions?.some((action) => action.id === "resume")).toBe(false);
    expect(Exit.isFailure(yield* Effect.exit(f.invoke("one", "cancel", hidden.revision)))).toBe(
      true,
    );
    f.bridge.clear(token);
    yield* f.activity.observer.settled("one", "submitted");
    expect(f.provider.snapshot()[0]).toMatchObject({ status: "done", actions: [] });
    expect(f.provider.snapshot()[0]?.inputTarget).toBeUndefined();
    expect(f.provider.snapshot()[0]?.blockedReason).toBeUndefined();
    f.activity.dispose();
  }),
);
it.effect(
  "keeps explicit owner ancestry and revokes stale cancellation and overlay capabilities",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      let cancelled = 0;
      let resumed = 0;
      yield* f.activity.observer.admitted(
        "owned",
        request,
        Effect.sync(() => {
          cancelled++;
        }),
        { runId: "run", assignmentEpoch: 1, requestId: "request" },
      );
      expect(f.provider.snapshot()[0]?.parent).toEqual({
        providerId: "pi-subagents",
        itemId: "run",
      });
      yield* f.activity.observer.presenting("owned");
      const token = f.bridge.activate(() => {
        resumed++;
      });
      f.bridge.markOpened(token);
      f.bridge.markCollapsed(token);
      const stale = f.provider.snapshot()[0]!;
      f.bridge.activate(() => {
        resumed++;
      });
      expect(Exit.isFailure(yield* Effect.exit(f.invoke("owned", "resume", stale.revision)))).toBe(
        true,
      );
      expect(resumed).toBe(0);
      const cancel = f.provider.snapshot()[0]!;
      expect(cancel.actions?.find((action) => action.id === "cancel")?.confirmation).toBeTruthy();
      yield* f.invoke("owned", "cancel", cancel.revision);
      expect(cancelled).toBe(1);
      f.replace();
      expect(Exit.isFailure(yield* Effect.exit(f.invoke("owned", "cancel", cancel.revision)))).toBe(
        true,
      );
      expect(cancelled).toBe(1);
      f.activity.dispose();
    }),
);
it.effect("closes Activity before Resume shows the questionnaire and cancels in place", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.activity.observer.admitted("one", request, Effect.void);
    yield* f.activity.observer.presenting("one");
    const token = f.bridge.activate(() => {});
    f.bridge.markOpened(token);
    f.bridge.markCollapsed(token);
    const actions = f.provider.snapshot()[0]?.actions ?? [];
    // Showing the questionnaire takes keyboard focus; a manager left open would hide it.
    expect(actions.find((action) => action.id === "resume")?.handoff).toBe(true);
    expect(actions.find((action) => action.id === "cancel")?.handoff).toBe(false);
    f.activity.dispose();
  }),
);
