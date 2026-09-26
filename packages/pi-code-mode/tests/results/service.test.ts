import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Context from "effect/Context";
import { CodeModeResults } from "../../src/results/service.ts";
import { RESULT_MAX_BYTES } from "../../src/results/model.ts";

describe("session output retention", () => {
  it.effect(
    "evicts oldest settled records, not most recently read, and rejects oversized output",
    () =>
      Effect.gen(function* () {
        const results = yield* CodeModeResults;
        const first = yield* results.put("first", "failed");
        for (let index = 0; index < 31; index++) yield* results.put(String(index), "succeeded");
        expect((yield* results.get(first!))?.outcome).toBe("failed");
        const last = yield* results.put("last", "cancelled");
        expect(yield* results.get(first!)).toBeUndefined();
        expect((yield* results.get(last!))?.outcome).toBe("cancelled");
        expect(yield* results.put("x".repeat(RESULT_MAX_BYTES + 1), "succeeded")).toBeUndefined();
      }).pipe(Effect.provide(CodeModeResults.layer)),
  );

  it.effect("bounds session memory conservatively and closes escaped service capabilities", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(CodeModeResults.layer, scope);
      const results = Context.get(context, CodeModeResults);
      const text = "x".repeat(RESULT_MAX_BYTES);
      const first = yield* results.put(text, "succeeded");
      yield* results.put(text, "succeeded");
      const last = yield* results.put(text, "succeeded");
      expect(yield* results.get(first!)).toBeUndefined();
      expect((yield* results.get(last!))?.text).toBe(text);
      yield* Scope.close(scope, Exit.void);
      expect(yield* results.get(last!)).toBeUndefined();
      expect(yield* results.put("late", "failed")).toBeUndefined();
    }),
  );
});
