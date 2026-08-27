import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type { BoundedProcessRequest } from "pi-cosmic-core";
import { expect } from "vitest";
import { makeHerdrCommandRunner, type HerdrProcessRunner } from "../src/boundary/herdr-client.ts";

const request = (mutation = false, timeoutMillis?: number) => ({
  args: ["api", "schema", "--json"],
  operation: "inspect protocol",
  mutation,
  timeoutMillis,
});

const success = {
  code: 0,
  signal: null,
  stdout: '{"protocol":19}',
  stderr: "",
  overflowed: false,
  timedOut: false,
  cleanupUnconfirmed: false,
  dispatched: true,
} as const;

// Intentional real platform process behavior; the deterministic seams cannot prove it.
it.live("runs, classifies, and interrupts the production child-process boundary", () =>
  Effect.gen(function* () {
    const runner = makeHerdrCommandRunner({}, { executable: process.execPath });
    const output = yield* runner({
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      operation: "inspect process boundary",
    });
    expect(output).toEqual({ stdout: "out", stderr: "err" });

    const failed = yield* Effect.result(
      runner({
        args: ["-e", "process.stderr.write('real boundary failure'); process.exit(3)"],
        operation: "inspect process boundary",
      }),
    );
    expect(failed._tag).toBe("Failure");
    if (failed._tag === "Failure") {
      expect(failed.failure).toMatchObject({
        code: "herdr_inspect_process_boundary_failed",
        outcome: "confirmed",
      });
      expect(failed.failure.message).toContain("real boundary failure");
      expect(failed.failure.message.length).toBeLessThanOrEqual(2_100);
    }

    const running = yield* runner({
      args: ["-e", "setInterval(() => undefined, 1000)"],
      operation: "inspect process interruption",
    }).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(running);
    expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
  }),
);

it.effect("runs fixed argv asynchronously through the injectable process seam", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let captured: BoundedProcessRequest | undefined;
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
      stdoutLimitBytes: 4 * 1024 * 1024,
      stderrLimitBytes: 4 * 1024 * 1024,
      timeoutMillis: 15_000,
      cleanupTimeoutMillis: 1_000,
      detached: false,
      windowsHide: true,
    });

    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(running)).toEqual({ stdout: success.stdout, stderr: "" });
  }),
);

it.effect("owns each per-command deadline and hands the clamped value to the process", () =>
  Effect.gen(function* () {
    const captured: Array<number> = [];
    const processRunner: HerdrProcessRunner = (processRequest) =>
      Effect.sync(() => {
        captured.push(processRequest.timeoutMillis);
        return success;
      });
    const runner = makeHerdrCommandRunner({}, { processRunner });

    yield* runner(request());
    yield* runner(request(false, 70_000));
    yield* runner(request(false, 200_000));
    yield* runner(request(false, 0));

    expect(captured).toEqual([15_000, 70_000, 120_000, 15_000]);
  }),
);

it.effect("interrupts an in-flight command and observes the process interruption", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let interrupted = 0;
    const processRunner: HerdrProcessRunner = () =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => void interrupted++)),
      );
    const runner = makeHerdrCommandRunner({}, { processRunner });
    const running = yield* runner(request()).pipe(Effect.forkScoped);
    yield* Deferred.await(started);

    yield* Fiber.interrupt(running);

    expect(interrupted).toBe(1);
  }),
);

it.effect("fails closed when either output stream exceeds its byte bound", () =>
  Effect.gen(function* () {
    for (const stream of ["stdout", "stderr"] as const) {
      let limits: readonly [number, number] | undefined;
      const processRunner: HerdrProcessRunner = (processRequest) =>
        Effect.sync(() => {
          limits = [processRequest.stdoutLimitBytes, processRequest.stderrLimitBytes];
          return { ...success, [stream]: "123456789" };
        });
      const runner = makeHerdrCommandRunner({}, { processRunner, maximumOutputBytes: 8 });

      const result = yield* Effect.result(runner(request()));

      expect(limits).toEqual([8, 8]);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "herdr_inspect_protocol_failed",
          outcome: "confirmed",
        });
    }
  }),
);

it.effect(
  "fails closed on in-band overflow, deadline, and cleanup uncertainty by mutation class",
  () =>
    Effect.gen(function* () {
      for (const flag of ["overflowed", "timedOut", "cleanupUnconfirmed"] as const)
        for (const mutation of [false, true]) {
          const processRunner: HerdrProcessRunner = () =>
            Effect.succeed({ ...success, [flag]: true });
          const runner = makeHerdrCommandRunner({}, { processRunner });

          const result = yield* Effect.result(runner(request(mutation)));

          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure).toMatchObject(
              mutation
                ? { code: "herdr_inspect_protocol_outcome_uncertain", outcome: "uncertain" }
                : { code: "herdr_inspect_protocol_failed", outcome: "confirmed" },
            );
        }
    }),
);

it.effect("keeps structured mutation precondition rejections confirmed", () =>
  Effect.gen(function* () {
    const processRunner: HerdrProcessRunner = () =>
      Effect.succeed({
        ...success,
        code: 1,
        stdout: "",
        stderr: JSON.stringify({ error: { code: "agent_pane_busy", message: "busy" } }),
      });
    const runner = makeHerdrCommandRunner({}, { processRunner });
    const result = yield* Effect.result(
      runner({
        args: ["agent", "start"],
        operation: "start side-session Pi",
        mutation: true,
        confirmedRejectionCodes: ["agent_pane_busy"],
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        code: "herdr_start_side_session_pi_rejected",
        outcome: "confirmed",
        herdrCode: "agent_pane_busy",
      });
      expect(result.failure.message).toContain("was rejected before it was applied");
    }
  }),
);

it.effect("keeps undecodable mutating exit failures outcome-uncertain", () =>
  Effect.gen(function* () {
    const processRunner: HerdrProcessRunner = () =>
      Effect.succeed({ ...success, code: 1, stdout: "", stderr: "connection closed" });
    const runner = makeHerdrCommandRunner({}, { processRunner });
    const result = yield* Effect.result(
      runner({
        args: ["agent", "start"],
        operation: "start side-session Pi",
        mutation: true,
        confirmedRejectionCodes: ["agent_pane_busy"],
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        code: "herdr_start_side_session_pi_outcome_uncertain",
        outcome: "uncertain",
      });
      expect(result.failure.herdrCode).toBeUndefined();
    }
  }),
);
