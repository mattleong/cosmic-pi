// Explicit test entry-point Layer provision owns the captured logger.
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { provideBuiltLayer } from "pi-cosmic-core";
import { capturedTelemetrySnapshot, makeCapturedLogger } from "pi-cosmic-core/testing";
import type { LocalCliWireEvent } from "../src/boundary/local-cli-transport.ts";
import { makeLocalCliRawEventOwnership } from "../src/backend/local-cli-events.ts";
import type { BackendEvent } from "../src/backend/model.ts";

const rawEvent = (id: number): LocalCliWireEvent => ({
  type: "exit",
  exitCode: 0,
  stderr: `raw-${id}`,
});
const backendEvent = (epoch: number): BackendEvent => ({
  type: "activity",
  assignmentEpoch: epoch,
});
const rawId = (raw: LocalCliWireEvent): string => (raw.type === "exit" ? raw.stderr : "");

describe("local CLI raw event ownership", () => {
  it.effect("keeps raw ownership across a delivered offer until acknowledgement", () =>
    Effect.gen(function* () {
      const captured = makeCapturedLogger();
      return yield* Effect.gen(function* () {
        const events = yield* Queue.bounded<BackendEvent, Cause.Done>(4);
        const acknowledged: string[] = [];
        const ownership = makeLocalCliRawEventOwnership(
          events,
          (raw) => void acknowledged.push(rawId(raw)),
        );

        const event = backendEvent(1);
        yield* ownership.offer(event, rawEvent(1));
        expect(acknowledged).toEqual([]);
        expect(yield* Queue.take(events)).toBe(event);
        ownership.acknowledge(event);
        expect(acknowledged).toEqual(["raw-1"]);
        // A second acknowledgement of a released event is inert.
        ownership.acknowledge(event);
        expect(acknowledged).toEqual(["raw-1"]);
        // A successful offer must not log an overflow warning.
        expect(capturedTelemetrySnapshot({ entries: captured.entries })).not.toContain(
          "ingress overflowed",
        );
      }).pipe(provideBuiltLayer(captured.layer));
    }),
  );

  it.effect("logs and acknowledges an event dropped by an ended ingress queue", () =>
    Effect.gen(function* () {
      const captured = makeCapturedLogger();
      return yield* Effect.gen(function* () {
        const events = yield* Queue.bounded<BackendEvent, Cause.Done>(4);
        const acknowledged: string[] = [];
        const ownership = makeLocalCliRawEventOwnership(
          events,
          (raw) => void acknowledged.push(rawId(raw)),
        );

        yield* ownership.offer(backendEvent(1));
        Queue.endUnsafe(events);
        const dropped = backendEvent(2);
        yield* ownership.offer(dropped, rawEvent(2));
        expect(acknowledged).toEqual(["raw-2"]);
        const warnings = capturedTelemetrySnapshot({ entries: captured.entries });
        expect(warnings).toContain("ingress overflowed");
        expect(warnings).toContain("activity");
      }).pipe(provideBuiltLayer(captured.layer));
    }),
  );

  it.effect("logs and acknowledges a blocked offer that is interrupted before delivering", () =>
    Effect.gen(function* () {
      const captured = makeCapturedLogger();
      return yield* Effect.gen(function* () {
        const events = yield* Queue.bounded<BackendEvent, Cause.Done>(1);
        const acknowledged: string[] = [];
        const ownership = makeLocalCliRawEventOwnership(
          events,
          (raw) => void acknowledged.push(rawId(raw)),
        );

        yield* ownership.offer(backendEvent(1));
        // The saturated bounded queue suspends the next offer until it is interrupted.
        const blocked = yield* Effect.forkChild(ownership.offer(backendEvent(2), rawEvent(3)));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(blocked);
        expect(acknowledged).toEqual(["raw-3"]);
        expect(capturedTelemetrySnapshot({ entries: captured.entries })).toContain(
          "ingress overflowed",
        );
      }).pipe(provideBuiltLayer(captured.layer));
    }),
  );
});
