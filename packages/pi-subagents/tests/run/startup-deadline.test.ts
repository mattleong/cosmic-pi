import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  fakeChildLayer,
  localServiceFixture,
  request,
  withService,
} from "./fixtures/service-harness.ts";

describe("local Pi startup deadline", () => {
  it.effect("allows slow initialization without sending the task before readiness", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const fake = fakeChildLayer(Effect.void, {
        initialSendGates: [{ spawnIndex: 0, type: "get_state", gate: ready }],
      });
      const { layer, projections } = localServiceFixture({}, fake);
      yield* withService(layer, function* (service) {
        const starting = yield* service.start(request()).pipe(Effect.forkScoped);
        yield* yieldUntil(() => fake.controls[0]?.sent("get_state") === true);
        yield* TestClock.adjust("20 seconds");
        expect(projections.at(-1)?.runs[0]?.state).toBe("starting");
        expect(fake.controls[0]?.released()).toBe(0);
        expect(fake.controls[0]?.sent("prompt")).toBe(false);
        yield* Deferred.succeed(ready, undefined);
        const run = yield* Fiber.join(starting);
        expect(run.state).toBe("running");
        expect(fake.controls[0]?.sent("prompt")).toBe(true);
        yield* service.stop(run.id);
        expect(fake.controls[0]?.released()).toBe(1);
      });
    }),
  );

  it.effect("bounds startup and joins cleanup without replay or task dispatch", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const fake = fakeChildLayer(Effect.void, { dropInitialState: true });
      const { layer } = localServiceFixture({}, fake);
      yield* withService(layer, function* (service) {
        let settled = false;
        const starting = yield* service.start(request()).pipe(
          Effect.flip,
          Effect.tap(() =>
            Effect.sync(() => {
              settled = true;
            }),
          ),
          Effect.forkScoped,
        );
        yield* yieldUntil(() => fake.controls[0]?.sent("get_state") === true);
        const child = fake.controls[0]!;
        child.gateRelease(release);
        // Unrelated replies cannot establish readiness for this request.
        child.offer({ type: "response", id: "unrelated", command: "get_state", success: true });
        yield* TestClock.adjust("31 seconds");
        expect(settled).toBe(false);
        expect(child.released()).toBe(0);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(starting)).toMatchObject({
          _tag: "SubagentProcessError",
          code: "get_state_outcome_uncertain",
        });
        expect(child.released()).toBe(1);
        expect(child.commandTypes()).toEqual(["get_state"]);
        expect(fake.controls).toHaveLength(1);
      });
    }),
  );

  it.effect("keeps the shorter deadline for ordinary commands after startup", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "original" }));
      fake.controls[0]!.dropNext("set_session_name");
      const renaming = yield* service
        .rename(run.id, "new name")
        .pipe(Effect.flip, Effect.forkScoped);
      yield* yieldUntil(() => fake.controls[0]?.sent("set_session_name") === true);
      yield* TestClock.adjust("11 seconds");
      expect(yield* Fiber.join(renaming)).toMatchObject({
        _tag: "SubagentProcessError",
        code: "rename_outcome_uncertain",
      });
      expect((yield* service.status(run.id)).name).toBe("original");
    });
  });
});
