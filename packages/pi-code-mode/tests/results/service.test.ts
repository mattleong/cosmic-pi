import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Context from "effect/Context";
import { CodeModeResults } from "../../src/results/service.ts";
import { RESULT_MAX_BYTES, RESULT_MAX_ENTRIES } from "../../src/results/model.ts";

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

  it.effect("keeps prepared artifacts hidden and non-evicting until one commit", () =>
    Effect.gen(function* () {
      const results = yield* CodeModeResults;
      const seeds: Array<string | undefined> = [];
      for (let index = 0; index < RESULT_MAX_ENTRIES; index++)
        seeds.push(yield* results.put(`seed-${index}`, "succeeded"));
      const prepared = yield* results.prepare("pending", "failed", "failure-receipt");
      const dropped = yield* results.prepare("dropped", "succeeded");
      expect(dropped).toBeDefined();
      for (const id of seeds) expect(yield* results.get(id!)).toBeDefined();
      const id = yield* prepared!.commit;
      expect(yield* results.get(id!)).toMatchObject({
        text: "pending",
        outcome: "failed",
        kind: "failure-receipt",
      });
      expect(yield* prepared!.commit).toBeUndefined();
      // Only the published artifact displaced the oldest seed; the dropped one never counted.
      expect(yield* results.get(seeds[0]!)).toBeUndefined();
      for (const seed of seeds.slice(1)) expect(yield* results.get(seed!)).toBeDefined();
      expect(yield* results.prepare("x".repeat(RESULT_MAX_BYTES + 1), "succeeded")).toBeUndefined();
    }).pipe(Effect.provide(CodeModeResults.layer)),
  );

  it.effect("orders eviction by publication and revokes prepared artifacts at close", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(CodeModeResults.layer, scope);
      const results = Context.get(context, CodeModeResults);
      const earlier = yield* results.prepare("prepared first", "succeeded");
      const later = yield* results.prepare("prepared second", "succeeded");
      const laterId = yield* later!.commit;
      const earlierId = yield* earlier!.commit;
      for (let index = 0; index < RESULT_MAX_ENTRIES - 1; index++)
        yield* results.put(String(index), "succeeded");
      expect(yield* results.get(laterId!)).toBeUndefined();
      expect((yield* results.get(earlierId!))?.text).toBe("prepared first");
      const revoked = yield* results.prepare("revoked", "succeeded");
      yield* Scope.close(scope, Exit.void);
      expect(yield* revoked!.commit).toBeUndefined();
      expect(yield* results.prepare("late", "succeeded")).toBeUndefined();
    }),
  );
});
