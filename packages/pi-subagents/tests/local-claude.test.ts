import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { yieldUntil } from "pi-cosmic-core/testing";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { processError, SubagentProcessError } from "../src/run/errors.ts";
import { makeLocalClaudeInputDelivery } from "../src/backend/local-claude-input-delivery.ts";

/** The only typed producer evidence that lets callers treat guidance as still pending. */
const pendingGuidance = {
  operation: "steer",
  code: "steer_outcome_uncertain",
  pendingDelivery: true,
} as const;

/** Input delivery whose preparation pauses until the test releases it. */
const gatedInputs = (scope: Scope.Scope) => {
  const preparing = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  let sends = 0;
  const inputs = makeLocalClaudeInputDelivery(
    {
      send: () =>
        Effect.sync(() => {
          sends++;
        }),
      terminate: () => Effect.void,
    },
    scope,
    () => Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Deferred.await(release))),
  );
  return { inputs, preparing, release, sends: () => sends };
};

describe("Claude input delivery ownership", () => {
  it.effect("late acknowledgement wins while the watchdog checks accepted report evidence", () =>
    Effect.gen(function* () {
      const sent = yield* Deferred.make<void>();
      const checking = yield* Deferred.make<void>();
      const releaseCheck = yield* Deferred.make<void>();
      let terminations = 0;
      const inputs = makeLocalClaudeInputDelivery(
        {
          send: () => Deferred.succeed(sent, undefined).pipe(Effect.asVoid),
          terminate: () =>
            Effect.sync(() => {
              terminations++;
            }),
        },
        yield* Scope.Scope,
        () => Effect.void,
        {
          preserveReport: () =>
            Deferred.succeed(checking, undefined).pipe(
              Effect.andThen(Deferred.await(releaseCheck)),
              Effect.as(false),
            ),
        },
      );
      const caller = yield* Effect.forkChild(inputs.send("Guidance", 1, "steer"));
      yield* Deferred.await(sent);
      const pending = inputs.pending;
      yield* TestClock.adjust("5 minutes");
      yield* Deferred.await(checking);
      if (!pending) return yield* Effect.die("Missing guidance owner");
      yield* inputs.confirm(pending);
      yield* Deferred.succeed(releaseCheck, undefined);
      yield* Effect.yieldNow;
      expect(inputs.failure).toBeUndefined();
      expect(terminations).toBe(0);
      yield* Fiber.await(caller);
    }),
  );

  it.effect(
    "watchdog latches admission before termination and late evidence cannot erase that cause",
    () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<void>();
        const terminating = yield* Deferred.make<void>();
        const releaseTermination = yield* Deferred.make<void>();
        const inputs = makeLocalClaudeInputDelivery(
          {
            send: () => Deferred.succeed(sent, undefined).pipe(Effect.asVoid),
            terminate: () =>
              Deferred.succeed(terminating, undefined).pipe(
                Effect.andThen(Deferred.await(releaseTermination)),
              ),
          },
          yield* Scope.Scope,
          () => Effect.void,
        );
        const caller = yield* Effect.forkChild(inputs.send("Guidance", 1, "steer"));
        yield* Deferred.await(sent);
        const pending = inputs.pending;
        yield* TestClock.adjust("5 minutes");
        yield* Deferred.await(terminating);
        if (!pending) return yield* Effect.die("Missing guidance owner");
        yield* inputs.confirm(pending);
        expect(yield* inputs.acceptReport(1)).toBe(false);
        expect(inputs.failure?.code).toBe("steer_outcome_uncertain");
        expect(Exit.isFailure(yield* Effect.exit(inputs.send("Never resend", 1, "steer")))).toBe(
          true,
        );
        yield* Deferred.succeed(releaseTermination, undefined);
        yield* Fiber.await(caller);
      }),
  );

  it.effect("backpressured delivery metadata cannot prevent watchdog termination", () =>
    Effect.gen(function* () {
      const blocked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const terminated = yield* Deferred.make<void>();
      let sends = 0;
      const inputs = makeLocalClaudeInputDelivery(
        {
          send: () =>
            Effect.sync(() => {
              sends++;
            }),
          terminate: () => Deferred.succeed(terminated, undefined).pipe(Effect.asVoid),
        },
        yield* Scope.Scope,
        () => Effect.void,
        {
          onState: () =>
            Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Deferred.await(release))),
        },
      );
      const caller = yield* Effect.forkChild(inputs.send("Guidance", 1, "steer"));
      yield* Deferred.await(blocked);
      yield* TestClock.adjust("5 minutes");
      yield* Deferred.await(terminated);
      expect(sends).toBe(0);
      expect(inputs.failure?.code).toBe("steer_outcome_uncertain");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(caller);
    }),
  );
  it.effect(
    "caller deadline preserves sent guidance until late acknowledgement reopens admission",
    () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<void>();
        let terminations = 0;
        const inputs = makeLocalClaudeInputDelivery(
          {
            send: () => Deferred.succeed(sent, undefined).pipe(Effect.asVoid),
            terminate: () =>
              Effect.sync(() => {
                terminations++;
              }),
          },
          yield* Scope.Scope,
          () => Effect.void,
        );
        const caller = yield* Effect.forkChild(inputs.send("Guidance", 1, "steer"));
        yield* Deferred.await(sent);
        const pending = inputs.pending;
        yield* TestClock.adjust("11 seconds");
        const deadline = yield* Effect.flip(Fiber.join(caller));
        // Only a caller deadline over still-tracked guidance is flagged pending; the backend lives.
        expect(deadline).toBeInstanceOf(SubagentProcessError);
        expect(deadline).toMatchObject(pendingGuidance);
        expect(inputs.failure).toBeUndefined();
        expect(terminations).toBe(0);
        expect(inputs.pending).toBe(pending);
        const duplicate = yield* Effect.flip(inputs.send("Duplicate", 1, "steer"));
        expect(duplicate).toMatchObject({ code: "steer_not_sent" });
        expect(duplicate).not.toMatchObject({ pendingDelivery: true });
        if (!pending) return yield* Effect.die("Missing pending guidance");
        yield* Deferred.succeed(pending.acknowledgement, undefined);
        yield* yieldUntil(() => inputs.pending === undefined);
        const next = yield* Effect.forkChild(inputs.send("Next guidance", 1, "steer"));
        yield* yieldUntil(() => inputs.pending !== undefined);
        const nextPending = inputs.pending;
        if (!nextPending) return yield* Effect.die("Missing next guidance");
        yield* Deferred.succeed(nextPending.acknowledgement, undefined);
        yield* Fiber.join(next);
        yield* TestClock.adjust("5 minutes");
        expect(terminations).toBe(0);
      }),
  );

  it.effect(
    "unacknowledged steering hits an absolute five-minute watchdog and closes admission",
    () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<void>();
        const terminated = yield* Deferred.make<void>();
        const inputs = makeLocalClaudeInputDelivery(
          {
            send: () => Deferred.succeed(sent, undefined).pipe(Effect.asVoid),
            terminate: () => Deferred.succeed(terminated, undefined).pipe(Effect.asVoid),
          },
          yield* Scope.Scope,
          () => Effect.void,
        );
        const caller = yield* Effect.forkChild(inputs.send("Guidance", 1, "steer"));
        yield* Deferred.await(sent);
        yield* TestClock.adjust("299 seconds");
        expect(yield* Deferred.isDone(terminated)).toBe(false);
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(terminated);
        expect(inputs.failure?.code).toBe("steer_outcome_uncertain");
        // Watchdog closure is terminal uncertainty, never pending delivery.
        expect(inputs.failure).not.toMatchObject({ pendingDelivery: true });
        expect(Exit.isFailure(yield* Effect.exit(inputs.send("No resend", 1, "steer")))).toBe(true);
        yield* Fiber.await(caller);
      }),
  );

  for (const operation of ["initialize", "start"] as const)
    it.effect(`${operation} replay deadline remains fail-closed at ten seconds`, () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<void>();
        const terminated = yield* Deferred.make<void>();
        const inputs = makeLocalClaudeInputDelivery(
          {
            send: () => Deferred.succeed(sent, undefined).pipe(Effect.asVoid),
            terminate: () => Deferred.succeed(terminated, undefined).pipe(Effect.asVoid),
          },
          yield* Scope.Scope,
          () => Effect.void,
        );
        const caller = yield* Effect.forkChild(inputs.send("Input", 1, operation));
        yield* Deferred.await(sent);
        yield* TestClock.adjust("10 seconds");
        yield* Deferred.await(terminated);
        expect(Exit.isFailure(yield* Fiber.await(caller))).toBe(true);
        expect(inputs.failure?.code).toBe(`${operation}_outcome_uncertain`);
      }),
    );

  it.effect("uncertain native write remains immediately fail-closed despite cleanup failure", () =>
    Effect.gen(function* () {
      const inputs = makeLocalClaudeInputDelivery(
        {
          send: () =>
            Effect.fail(
              processError("send", "transport_outcome_uncertain", "write outcome unknown"),
            ),
          terminate: () =>
            Effect.fail(processError("close", "process_cleanup_unconfirmed", "cleanup unknown")),
        },
        yield* Scope.Scope,
        () => Effect.void,
      );
      const failure = yield* Effect.flip(inputs.send("Guidance", 1, "steer"));
      expect(failure).toMatchObject({ operation: "steer", code: "steer_outcome_uncertain" });
      // Unknown write and cleanup outcomes are not tracked guidance and never read as pending.
      expect(failure).not.toMatchObject({ pendingDelivery: true });
      expect(inputs.failure?.code).toBe("steer_outcome_uncertain");
      expect(Exit.isFailure(yield* Effect.exit(inputs.send("No resend", 1, "steer")))).toBe(true);
    }),
  );

  it.effect("uncertain native write outlasting the caller deadline is not reported pending", () =>
    Effect.gen(function* () {
      const terminating = yield* Deferred.make<void>();
      const releaseTermination = yield* Deferred.make<void>();
      const inputs = makeLocalClaudeInputDelivery(
        {
          send: () =>
            Effect.fail(
              processError("send", "transport_outcome_uncertain", "write outcome unknown"),
            ),
          terminate: () =>
            Deferred.succeed(terminating, undefined).pipe(
              Effect.andThen(Deferred.await(releaseTermination)),
            ),
        },
        yield* Scope.Scope,
        () => Effect.void,
      );
      const caller = yield* Effect.forkChild(inputs.send("Guidance", 1, "steer"));
      yield* Deferred.await(terminating);
      yield* TestClock.adjust("11 seconds");
      const deadline = yield* Effect.flip(Fiber.join(caller));
      expect(deadline).toMatchObject({ operation: "steer", code: "steer_outcome_uncertain" });
      expect(deadline).not.toMatchObject({ pendingDelivery: true });
      yield* Deferred.succeed(releaseTermination, undefined);
    }),
  );

  for (const settlement of ["report", "close"] as const)
    it.effect(`guidance settled by ${settlement} before the caller deadline is not pending`, () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<void>();
        let terminations = 0;
        const inputs = makeLocalClaudeInputDelivery(
          {
            send: () => Deferred.succeed(sent, undefined).pipe(Effect.asVoid),
            terminate: () =>
              Effect.sync(() => {
                terminations++;
              }),
          },
          yield* Scope.Scope,
          () => Effect.void,
        );
        const caller = yield* Effect.forkChild(inputs.send("Guidance", 1, "steer"));
        yield* Deferred.await(sent);
        if (settlement === "report") expect(yield* inputs.acceptReport(1)).toBe(true);
        else
          inputs.cancel(
            processError("close", "local_claude_closed", "Local Claude Code backend closed."),
          );
        const failure = yield* Effect.flip(Fiber.join(caller));
        // Once guidance is no longer tracked, the caller never receives pending evidence.
        expect(failure).not.toMatchObject({ pendingDelivery: true });
        expect(failure).toMatchObject(
          settlement === "report"
            ? { operation: "steer", code: "steer_outcome_uncertain" }
            : { code: "local_claude_closed" },
        );
        expect(inputs.pending).toBeUndefined();
        expect(Exit.isFailure(yield* Effect.exit(inputs.send("No resend", 1, "steer")))).toBe(true);
        // An accepted report ends watchdog ownership instead of terminating a finished worker.
        yield* TestClock.adjust("5 minutes");
        if (settlement === "report") expect(terminations).toBe(0);
      }),
    );
  it.effect("closed scope rejects new input and releases admission racing preparation", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { inputs, preparing, release, sends } = gatedInputs(scope);
      const caller = yield* Effect.forkChild(inputs.send("Guidance", 1, "steer"));
      yield* Deferred.await(preparing);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(caller);
      expect(inputs.pending).toBeUndefined();
      expect(Exit.isFailure(yield* Effect.exit(inputs.send("Later guidance", 1, "steer")))).toBe(
        true,
      );
      expect(inputs.pending).toBeUndefined();
      expect(sends()).toBe(0);
    }),
  );
  it.effect("cancellation before native send releases admission without sending later", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { inputs, preparing, release, sends } = gatedInputs(yield* Scope.Scope);
        const caller = yield* Effect.forkChild(inputs.send("Guidance", 1, "steer"));
        yield* Deferred.await(preparing);
        yield* Fiber.interrupt(caller);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.yieldNow;
        expect(sends()).toBe(0);
        expect(inputs.pending).toBeUndefined();
      }),
    ),
  );

  it.effect("cancellation after native send retains the UUID until exact acknowledgement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const sent = Deferred.makeUnsafe<void>();
        const inputs = makeLocalClaudeInputDelivery(
          {
            send: () => Deferred.succeed(sent, undefined).pipe(Effect.asVoid),
            terminate: () => Effect.void,
          },
          scope,
          () => Effect.void,
        );
        const caller = yield* Effect.forkChild(inputs.send("Guidance", 1, "steer"));
        yield* Deferred.await(sent);
        const pending = inputs.pending;
        expect(pending).toBeDefined();
        yield* Fiber.interrupt(caller);
        expect(inputs.pending).toBe(pending);
        if (!pending) return yield* Effect.die("Missing sent input");
        yield* Deferred.succeed(pending.acknowledgement, undefined);
        yield* yieldUntil(() => inputs.pending === undefined);
      }),
    ),
  );
});
