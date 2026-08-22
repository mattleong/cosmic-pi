// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/strictEffectProvide:off
import { EventEmitter } from "node:events";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  awaitProcessClose,
  nodeProcessLayer,
  runBoundedProcessScoped,
  type ProcessCloseSource,
} from "../index.ts";

it.live("runs a bounded one-shot process", () =>
  Effect.gen(function* () {
    const result = yield* runBoundedProcessScoped({
      executable: process.execPath,
      args: ["-e", 'process.stdout.write("ready")'],
      environment: process.env,
      stdoutLimitBytes: 64,
      stderrLimitBytes: 64,
      timeoutMillis: 2_000,
    });
    expect(result).toMatchObject({
      code: 0,
      stdout: "ready",
      overflowed: false,
      timedOut: false,
      cleanupUnconfirmed: false,
      dispatched: true,
    });
  }).pipe(Effect.provide(nodeProcessLayer)),
);

it.live("terminates a process when bounded output overflows", () =>
  Effect.gen(function* () {
    const result = yield* runBoundedProcessScoped({
      executable: process.execPath,
      args: ["-e", 'process.stdout.write("0123456789")'],
      environment: process.env,
      stdoutLimitBytes: 4,
      stderrLimitBytes: 64,
      timeoutMillis: 2_000,
    });
    expect(result.overflowed).toBe(true);
    expect(result.stdout).toBe("0123");
    expect(result.cleanupUnconfirmed).toBe(false);
  }).pipe(Effect.provide(nodeProcessLayer)),
);

it.live("preserves a child termination signal", () =>
  Effect.gen(function* () {
    const result = yield* runBoundedProcessScoped({
      executable: process.execPath,
      args: ["-e", 'process.kill(process.pid, "SIGTERM")'],
      environment: process.env,
      stdoutLimitBytes: 64,
      stderrLimitBytes: 64,
      timeoutMillis: 2_000,
    });
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  }).pipe(Effect.provide(nodeProcessLayer)),
);

it.live("terminates a process at its deadline", () =>
  Effect.gen(function* () {
    const result = yield* runBoundedProcessScoped({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      environment: process.env,
      stdoutLimitBytes: 64,
      stderrLimitBytes: 64,
      timeoutMillis: 25,
      cleanupTimeoutMillis: 2_000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.cleanupUnconfirmed).toBe(false);
  }).pipe(Effect.provide(nodeProcessLayer)),
);

class TestCloseSource extends EventEmitter implements ProcessCloseSource {
  exitCode: number | null = null;
  signalCode: string | null = null;
  override once(event: "close", listener: () => void): this {
    return super.once(event, listener);
  }
  override off(event: "close", listener: () => void): this {
    return super.off(event, listener);
  }
}

it.effect("detaches a Node close listener after confirmation", () =>
  Effect.gen(function* () {
    const child = new TestCloseSource();
    const waiting = yield* awaitProcessClose(child, 1_000).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    child.exitCode = 0;
    child.emit("close");
    expect(yield* Fiber.join(waiting)).toBe(true);
    expect(child.listenerCount("close")).toBe(0);
  }),
);
