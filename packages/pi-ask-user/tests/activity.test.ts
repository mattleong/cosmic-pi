import { routeRequest as request } from "./support/questionnaire.ts";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { makeActivityFixture as fixture } from "./support/activity.ts";

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
      expect(f.items()[0]?.parent).toEqual({
        providerId: "pi-subagents",
        itemId: "run",
      });
      yield* f.activity.observer.presenting("owned");
      const token = f.bridge.activate(() => {
        resumed++;
      });
      f.bridge.markOpened(token);
      f.bridge.markCollapsed(token);
      const stale = f.items()[0]!;
      f.bridge.activate(() => {
        resumed++;
      });
      expect(Exit.isFailure(yield* Effect.exit(f.invoke("owned", "resume", stale.revision)))).toBe(
        true,
      );
      expect(resumed).toBe(0);
      const cancel = f.items()[0]!;
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
