import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import { MAX_ERROR_CHARS } from "../../src/run/state.ts";
import {
  fakeChildLayer,
  localServiceFixture,
  request,
  withService,
} from "./fixtures/service-harness.ts";
import { SubagentProcessError } from "../../src/run/errors.ts";

const expectDiagnostic = (message: string | undefined) => {
  expect(message).toContain("Failed to load extension: missing entrypoint");
  expect(message).toContain("code 1");
  expect(message).toContain("[REDACTED]");
  expect(message).not.toContain("secret-credential");
  expect(message).not.toContain("\u001b");
  expect(message?.length).toBeLessThanOrEqual(MAX_ERROR_CHARS);
};

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
        child.offer({ type: "response", id: "unrelated", command: "get_state", success: true });
        yield* TestClock.adjust("31 seconds");
        expect(settled).toBe(false);
        expect(child.released()).toBe(0);
        yield* Deferred.succeed(release, undefined);
        const startFailure = yield* Fiber.join(starting);
        expect(startFailure).toBeInstanceOf(SubagentProcessError);
        expect(startFailure).toMatchObject({ code: "get_state_outcome_uncertain" });
        expect(child.released()).toBe(1);
        expect(child.commandTypes()).toEqual(["get_state"]);
        expect(fake.controls).toHaveLength(1);
      });
    }),
  );

  it.effect("retains a bounded redacted startup exit cause through cleanup", () =>
    Effect.gen(function* () {
      const fake = fakeChildLayer(Effect.void, { dropInitialState: true });
      const { layer, projections } = localServiceFixture({}, fake);
      yield* withService(layer, function* (service) {
        const starting = yield* service.start(request()).pipe(Effect.flip, Effect.forkScoped);
        yield* yieldUntil(() => fake.controls[0]?.sent("get_state") === true);
        const child = fake.controls[0]!;
        child.exit(1, {
          stderr: `\u001b[31mFailed to load extension: missing entrypoint\u001b[0m token=secret-credential\n${"x".repeat(MAX_ERROR_CHARS * 2)}`,
        });
        const failure = yield* Fiber.join(starting);
        expect(failure._tag).toBe("SubagentProcessError");
        expectDiagnostic(failure.message);
        const run = projections.at(-1)!.runs[0]!;
        expect(run.state).toBe("failed");
        expectDiagnostic((yield* service.status(run.id)).error);
        expect(child.released()).toBe(1);
        expect(fake.reclaimedRunIds).toContain(run.id);
        expect(child.sent("prompt")).toBe(false);
      });
    }),
  );

  it.effect("adds the install remedy below the cause when a child can't find its model", () =>
    Effect.gen(function* () {
      const fake = fakeChildLayer(Effect.void, { dropInitialState: true });
      const { layer } = localServiceFixture({}, fake);
      yield* withService(layer, function* (service) {
        const starting = yield* service.start(request()).pipe(Effect.flip, Effect.forkScoped);
        yield* yieldUntil(() => fake.controls[0]?.sent("get_state") === true);
        fake.controls[0]!.exit(1, {
          stderr:
            'Warning: No models match pattern "acme/*"\nError: Model "acme/turbo" not found. Use --list-models to see available models.\n',
        });
        const failure = yield* Fiber.join(starting);
        expect(failure).toMatchObject({ code: "pi_model_not_found" });
        const [cause, ...detail] = failure.message.split("\n");
        expect(cause).toContain('Model "acme/turbo" not found');
        expect(cause).not.toContain("pi install");
        expect(detail.join("\n")).toContain("pi install");
        expect(detail.join("\n")).toContain("No models match pattern");
      });
    }),
  );

  it.effect("preserves an exit cause while establishing startup usage", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const fake = fakeChildLayer(Effect.void, {
        initialSendGates: [{ spawnIndex: 0, type: "get_session_stats", gate }],
      });
      const { layer } = localServiceFixture({}, fake);
      yield* withService(layer, function* (service) {
        const starting = yield* service.start(request()).pipe(Effect.flip, Effect.forkScoped);
        yield* yieldUntil(() => fake.controls[0]?.sent("get_session_stats") === true);
        const child = fake.controls[0]!;
        child.exit(2, { stderr: "Startup resource loading failed" });
        const failure = yield* Fiber.join(starting);
        expect(failure.message).toContain("Startup resource loading failed");
        expect(failure.message).toContain("code 2");
        expect(child.released()).toBe(1);
        expect(child.sent("prompt")).toBe(false);
      });
    }),
  );

  it.effect("retains startup termination information when stderr is empty", () => {
    const fake = fakeChildLayer(Effect.void, { dropInitialState: true });
    const { layer } = localServiceFixture({}, fake);
    return withService(layer, function* (service) {
      const starting = yield* service.start(request()).pipe(Effect.flip, Effect.forkScoped);
      yield* yieldUntil(() => fake.controls[0]?.sent("get_state") === true);
      const child = fake.controls[0]!;
      child.exit(null, { signal: "SIGTERM" });
      const failure = yield* Fiber.join(starting);
      expect(failure.message).toContain("SIGTERM");
      expect(child.released()).toBe(1);
      expect(child.sent("prompt")).toBe(false);
    });
  });

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
      const renameFailure = yield* Fiber.join(renaming);
      expect(renameFailure).toBeInstanceOf(SubagentProcessError);
      expect(renameFailure).toMatchObject({ code: "rename_outcome_uncertain" });
      expect((yield* service.status(run.id)).name).toBe("original");
    });
  });
});
