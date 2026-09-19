// Local host observation deviation, not an upstream suite.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodeMode } from "../src/index.js";
import { vi } from "vitest";
import { setDeadlineClockForTesting } from "../src/interpreter/confinement.js";

describe("host result observation", () => {
  for (const phase of ["copy", "serialization"] as const) {
    it.effect(`never observes success when final ${phase} exceeds the deadline`, () =>
      Effect.gen(function* () {
        let now = 0;
        let observedOk: boolean | undefined;
        setDeadlineClockForTesting(() => now);
        const fromEntries = Object.fromEntries;
        const stringify = JSON.stringify;
        const copy = vi.spyOn(Object, "fromEntries").mockImplementation((entries) => {
          const result = fromEntries(entries);
          if (phase === "copy" && result.lateProjection === true) now = 100;
          return result;
        });
        const serialize = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
          const result = stringify(...args);
          if (phase === "serialization" && result === '{"lateProjection":true}') now = 100;
          return result;
        });
        try {
          const result = yield* CodeMode.execute({
            code: "return { lateProjection: true };",
            limits: { timeoutMs: 50, maxOutputBytes: 1000 },
            onResult: (value) => {
              observedOk = value.ok;
            },
          });
          expect(result).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } });
          expect(observedOk).toBe(false);
        } finally {
          copy.mockRestore();
          serialize.mockRestore();
          setDeadlineClockForTesting(undefined);
        }
      }),
    );
  }
  it.effect(
    "observes validated full output before bounding without changing the returned result",
    () =>
      Effect.gen(function* () {
        let observed = "";
        const options = {
          code: 'console.log("kept log"); return "😀".repeat(100);',
          limits: { maxOutputBytes: 32 },
        };
        const original = yield* CodeMode.execute(options);
        const result = yield* CodeMode.execute({
          ...options,
          onResult: (result) => {
            expect(result.ok).toBe(true);
            if (result.ok) observed = String(result.value);
            expect(result.logs).toEqual(["kept log"]);
          },
        });
        expect(observed).toBe("😀".repeat(100));
        expect(result).toEqual(original);
      }),
  );
  it.effect(
    "contains observer failure and never observes rejected opaque return data as success",
    () =>
      Effect.gen(function* () {
        const code = "return new Uint8Array([1]);";
        let observedOk: boolean | undefined;
        const original = yield* CodeMode.execute({ code });
        const result = yield* CodeMode.execute({
          code,
          onResult: (value) => {
            observedOk = value.ok;
            throw new Error("capture failed");
          },
        });
        expect(observedOk).toBe(false);
        expect(result).toEqual(original);
      }),
  );
  it.effect("observes a bounded failed Result for a thrown shared DAG", () =>
    Effect.gen(function* () {
      const observed: Array<CodeMode.Result> = [];
      const result = yield* CodeMode.execute({
        // Eighteen levels exceed the projection budget without making a regressed walk unbounded.
        code: "let a = [0]; for (let i = 0; i < 18; i++) a = [a, a]; throw a;",
        limits: { maxOutputBytes: 32 },
        onResult: (value) => {
          observed.push(value);
        },
      });
      expect(result).toMatchObject({ ok: false, error: { kind: "ExecutionFailure" } });
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ ok: false, error: { kind: "ExecutionFailure" } });
      if (result.ok || observed[0]?.ok !== false) throw new Error("expected failure");
      expect(new TextEncoder().encode(result.error.message).length).toBeLessThanOrEqual(32);
      expect(observed[0].error.message.length).toBeLessThan(128);
    }),
  );

  it.effect("observes normalized failure and its pre-failure logs", () =>
    Effect.gen(function* () {
      let message = "";
      const result = yield* CodeMode.execute({
        code: 'console.log("before"); throw new Error("later");',
        limits: { maxOutputBytes: 1 },
        onResult: (value) => {
          if (!value.ok) message = value.error.message;
          expect(value.logs).toEqual(["before"]);
        },
      });
      expect(result.ok).toBe(false);
      expect(message).toContain("later");
    }),
  );
});
