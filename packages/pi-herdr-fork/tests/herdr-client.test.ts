import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import {
  makeHerdrCommandRunner,
  type HerdrProcessRequest,
  type HerdrProcessRunner,
} from "../src/boundary/herdr-client.ts";

const request = (mutation = false, timeoutMillis?: number) => {
  const base = {
    args: ["api", "schema", "--json"],
    operation: "inspect protocol",
    mutation,
  };
  return timeoutMillis === undefined ? base : { ...base, timeoutMillis };
};

const success = {
  status: 0,
  signal: null,
  stdout: '{"protocol":19}',
  stderr: "",
  overflowed: false,
} as const;

it.effect("runs and interrupts the production asynchronous child-process boundary", () =>
  Effect.gen(function* () {
    const runner = makeHerdrCommandRunner({}, { executable: process.execPath });
    const output = yield* runner({
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      operation: "inspect process boundary",
      mutation: false,
    });
    expect(output).toEqual({ stdout: "out", stderr: "err" });

    const running = yield* runner({
      args: ["-e", "setInterval(() => undefined, 1000)"],
      operation: "inspect process interruption",
      mutation: false,
    }).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(running);
  }),
);

it.effect("runs fixed argv asynchronously through the injectable process seam", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let captured: HerdrProcessRequest | undefined;
    let completed = false;
    const processRunner: HerdrProcessRunner = (processRequest) =>
      Effect.gen(function* () {
        captured = processRequest;
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);
        return success;
      });
    const runner = makeHerdrCommandRunner(
      {
        HOME: "/home/test",
        PATH: "/bin",
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p1",
        SECRET: "never-pass",
      },
      { executable: "fixture-herdr", processRunner },
    );

    const running = yield* runner(request()).pipe(
      Effect.tap(() => Effect.sync(() => void (completed = true))),
      Effect.forkScoped,
    );
    yield* Deferred.await(started);

    expect(completed).toBe(false);
    expect(captured).toEqual({
      executable: "fixture-herdr",
      args: ["api", "schema", "--json"],
      environment: {
        HOME: "/home/test",
        PATH: "/bin",
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p1",
      },
      maximumOutputBytes: 4 * 1024 * 1024,
    });

    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(running)).toEqual({ stdout: success.stdout, stderr: "" });
  }),
);

it.effect("times out with scoped cleanup and preserves uncertain mutation classification", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let finalized = 0;
    const processRunner: HerdrProcessRunner = () =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => void finalized++));
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      });
    const runner = makeHerdrCommandRunner({}, { processRunner });
    const running = yield* runner(request(true, 50)).pipe(Effect.result, Effect.forkScoped);
    yield* Deferred.await(started);

    yield* TestClock.adjust("50 millis");
    const result = yield* Fiber.join(running);

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({
        code: "herdr_inspect_protocol_outcome_uncertain",
        outcome: "uncertain",
      });
    expect(finalized).toBe(1);
  }),
);

it.effect("interrupts an in-flight command and releases its scoped process", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let finalized = 0;
    const processRunner: HerdrProcessRunner = () =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => void finalized++));
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      });
    const runner = makeHerdrCommandRunner({}, { processRunner });
    const running = yield* runner(request()).pipe(Effect.forkScoped);
    yield* Deferred.await(started);

    yield* Fiber.interrupt(running);

    expect(finalized).toBe(1);
  }),
);

it.effect("fails closed when either output stream exceeds its byte bound", () =>
  Effect.gen(function* () {
    for (const stream of ["stdout", "stderr"] as const) {
      const processRunner: HerdrProcessRunner = () =>
        Effect.succeed({ ...success, [stream]: "123456789" });
      const runner = makeHerdrCommandRunner({}, { processRunner, maximumOutputBytes: 8 });

      const result = yield* Effect.result(runner(request()));

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "herdr_inspect_protocol_failed",
          outcome: "confirmed",
        });
    }
  }),
);

it.effect("keeps structured mutation precondition rejections confirmed", () =>
  Effect.gen(function* () {
    const processRunner: HerdrProcessRunner = () =>
      Effect.succeed({
        status: 1,
        signal: null,
        stdout: "",
        stderr: JSON.stringify({ error: { code: "agent_pane_busy", message: "busy" } }),
        overflowed: false,
      });
    const runner = makeHerdrCommandRunner({}, { processRunner });
    const result = yield* Effect.result(
      runner({
        args: ["agent", "start"],
        operation: "start forked Pi",
        mutation: true,
        confirmedRejectionCodes: ["agent_pane_busy"],
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({
        code: "herdr_start_forked_pi_rejected",
        outcome: "confirmed",
        herdrCode: "agent_pane_busy",
      });
  }),
);
