import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  classifyLocalCliInterruptOwnership,
  makeLocalCliInterrupts,
  type LocalCliInterrupt,
} from "../src/backend/local-cli-interruption.ts";
import type { BackendEvent } from "../src/backend/model.ts";
import type { LocalCliWireEvent } from "../src/boundary/local-cli-transport.ts";
import { processError, SubagentProcessError, type SubagentError } from "../src/run/errors.ts";

const processFailure = (code: string) =>
  new SubagentProcessError({
    operation: "interrupt",
    code,
    message: code,
  });

const uncertain = processFailure("interrupt_outcome_uncertain");

describe("local CLI interruption ownership", () => {
  it.each<[string, "retain" | "release", Exit.Exit<unknown, SubagentError>]>([
    ["an interruption-only exit", "retain", Exit.interrupt(1)],
    [
      "a multi-fiber interruption",
      "retain",
      Exit.failCause(
        Cause.fromReasons([Cause.makeInterruptReason(1), Cause.makeInterruptReason(2)]),
      ),
    ],
    ["a typed uncertain outcome", "retain", Exit.fail(uncertain)],
    [
      "an uncertain outcome mixed with interruption",
      "retain",
      Exit.failCause(
        Cause.fromReasons([Cause.makeInterruptReason(1), Cause.makeFailReason(uncertain)]),
      ),
    ],
    ["success", "release", Exit.succeed(undefined)],
    ["a definite failure", "release", Exit.fail(processFailure("interrupt_rejected"))],
    [
      "a defect shaped like an uncertain failure",
      "release",
      Exit.die({ _tag: "SubagentProcessError", code: "interrupt_outcome_uncertain" }),
    ],
  ])("classifies %s as %s", (_label, ownership, exit) => {
    expect(classifyLocalCliInterruptOwnership(exit)).toBe(ownership);
  });
});

const raw: LocalCliWireEvent = { type: "message", value: {} };
const settled = (rawOwner?: LocalCliWireEvent) => [
  { type: "run_settled", assignmentEpoch: 7 },
  rawOwner,
];

/** One shared interrupt owner whose correlated response is the given effect. */
const interruptHarness = () => {
  const offered: Array<[BackendEvent, LocalCliWireEvent | undefined]> = [];
  const released: LocalCliWireEvent[] = [];
  const interrupts = makeLocalCliInterrupts<LocalCliInterrupt>(
    "Codex",
    {
      offer: (event, rawOwner) => Effect.sync(() => void offered.push([event, rawOwner])),
      release: (rawOwner) => Effect.sync(() => void released.push(rawOwner)),
    },
    () => 7,
  );
  const run = (respond: Effect.Effect<unknown, SubagentError>) =>
    interrupts.run({ make: (base) => base, respond: () => respond, timeoutMessage: "Timed out" });
  /** Forks an interrupt and returns it once it owns the lifecycle. */
  const start = (respond: Effect.Effect<unknown, SubagentError>) =>
    Effect.gen(function* () {
      const caller = yield* Effect.forkChild(run(respond));
      yield* yieldUntil(() => interrupts.current !== undefined);
      const owned = interrupts.current;
      if (!owned) return yield* Effect.die(new Error("No interrupt owns the lifecycle."));
      return { caller, owned };
    });
  return { interrupts, offered, released, run, start };
};

describe("local CLI interrupt lifecycle", () => {
  it.effect("completes once both the response and the terminal evidence arrive", () =>
    Effect.gen(function* () {
      const { interrupts, offered, released, start } = interruptHarness();
      const { caller, owned } = yield* start(Effect.void);
      yield* interrupts.complete(owned, raw);
      yield* Fiber.join(caller);
      expect(interrupts.current).toBeUndefined();
      expect(released).toEqual([raw]);
      expect(offered).toEqual([]);
    }),
  );

  it.effect("keeps an uncertain lifecycle owned until late evidence settles it as a pause", () =>
    Effect.gen(function* () {
      const { interrupts, offered, run, start } = interruptHarness();
      const { caller, owned } = yield* start(Effect.never);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Effect.flip(Fiber.join(caller))).toMatchObject({
        code: "interrupt_outcome_uncertain",
      });
      expect(interrupts.current).toBe(owned);
      expect(owned.abandoned).toBe(true);
      // A second interrupt would be ambiguously correlated with the late evidence.
      expect(yield* Effect.flip(run(Effect.void))).toMatchObject({ code: "interrupt_not_sent" });
      yield* interrupts.complete(owned, raw);
      expect(offered).toEqual([settled(raw)]);
      expect(interrupts.current).toBeUndefined();
    }),
  );

  it.effect("settles at the deadline when terminal evidence arrived without its response", () =>
    Effect.gen(function* () {
      const { interrupts, offered, released, start } = interruptHarness();
      const { caller, owned } = yield* start(Effect.never);
      yield* interrupts.complete(owned, raw);
      expect(released).toEqual([raw]);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.await(caller);
      expect(offered).toEqual([settled()]);
      expect(interrupts.current).toBeUndefined();
    }),
  );

  it.effect("releases ownership after a definite rejection or transport cancellation", () =>
    Effect.gen(function* () {
      const { interrupts, run, start } = interruptHarness();
      const rejected = processError("interrupt", "interrupt_rejected", "Rejected.");
      expect(yield* Effect.flip(run(Effect.fail(rejected)))).toBe(rejected);
      expect(interrupts.current).toBeUndefined();
      const closed = processError("close", "transport_closed", "Closed.");
      const { caller } = yield* start(Effect.never);
      interrupts.cancel(closed);
      expect(yield* Effect.flip(Fiber.join(caller))).toBe(closed);
      expect(interrupts.current).toBeUndefined();
    }),
  );
});
