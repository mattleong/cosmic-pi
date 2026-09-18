// Local host observation deviation, not an upstream suite.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodeMode } from "../src/index.js";

describe("host result observation", () => {
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
