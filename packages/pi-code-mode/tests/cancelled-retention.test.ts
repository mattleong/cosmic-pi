import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { CodeModeResult } from "../src/engine/diagnostic.ts";
import { RESULT_MAX_BYTES, RESULT_MAX_ENTRIES } from "../src/results/model.ts";
import { CodeModeResults, type ResultsContract } from "../src/results/service.ts";
import type { CodeModeToolDetails } from "../src/tools/format.ts";
import { textOf } from "./support/execute.ts";
import { resultResponseFixture } from "./support/results.ts";

const OUTPUT = "x".repeat(2_000);
const SUCCEEDED: CodeModeResult = { ok: true, value: OUTPUT, truncated: true };
const FAILED: CodeModeResult = {
  ok: false,
  error: { kind: "ExecutionFailure", message: "ROOT-DIAGNOSTIC" },
};

interface Delivered {
  readonly text: string;
  readonly details: CodeModeToolDetails | undefined;
  readonly thrown: boolean;
}

/** Settles one response; a published execution failure throws its model-visible text. */
const deliver = (settle: () => Promise<AgentToolResult<CodeModeToolDetails>>) =>
  Effect.tryPromise(settle).pipe(
    Effect.match({
      onSuccess: (result): Delivered => ({
        text: textOf(result),
        details: result.details,
        thrown: false,
      }),
      onFailure: (failure): Delivered => ({
        text: failure.cause instanceof Error ? failure.cause.message : "non-Error rejection",
        details: undefined,
        thrown: true,
      }),
    }),
  );

/** A session runner that holds the settled retention value until the test releases it. */
const heldRunner = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  return {
    run: <A>(effect: Effect.Effect<A>) =>
      runPromise(
        Effect.gen(function* () {
          const value = yield* effect;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return value;
        }),
      ),
    entered: Deferred.await(entered),
    release: Deferred.succeed(release, undefined),
  };
});

const seed = (results: ResultsContract, texts: ReadonlyArray<string>) =>
  Effect.forEach(texts, (text) => results.put(text, "succeeded"));

const expectRetained = (
  results: ResultsContract,
  ids: ReadonlyArray<string | undefined>,
  texts: ReadonlyArray<string>,
) =>
  Effect.forEach(ids, (id, index) =>
    Effect.map(results.get(id!), (artifact) => {
      expect(artifact?.text === texts[index], `saved result ${index}`).toBe(true);
    }),
  );

const smallSeeds = Array.from({ length: RESULT_MAX_ENTRIES }, (_, index) => `SEED-${index}`);

describe("cancelled output retention", () => {
  it.effect("does not spend saved-result capacity on responses already cancelled", () =>
    Effect.gen(function* () {
      const results = yield* CodeModeResults;
      const [sentinel] = yield* seed(results, ["SENTINEL"]);
      for (const cancel of ["abort", "revoke"] as const) {
        for (const settle of ["succeeded", "failed", "unsettled"] as const) {
          for (let attempt = 0; attempt <= RESULT_MAX_ENTRIES; attempt++) {
            const response = resultResponseFixture({
              results,
              aborted: () => cancel === "abort",
              current: () => cancel !== "revoke",
              capture: () => ({ status: "captured", text: OUTPUT }),
            });
            const delivered = yield* deliver(() =>
              settle === "unsettled"
                ? response.failure("ROOT-DIAGNOSTIC")
                : response.success(settle === "succeeded" ? SUCCEEDED : FAILED),
            );
            expect(delivered.thrown).toBe(false);
            expect(delivered.details).toMatchObject({ cancelled: true });
            expect(delivered.details?.resultId).toBeUndefined();
            expect(delivered.text).toContain(
              `Original execution: ${settle === "unsettled" ? "cancelled" : settle}`,
            );
          }
        }
      }
      expect((yield* results.get(sentinel!))?.text).toBe("SENTINEL");
    }).pipe(Effect.provide(CodeModeResults.layer)),
  );

  it.effect.each(["entries", "bytes"] as const)(
    "keeps saved results when cancellation wins after retention is prepared (%s pressure)",
    (pressure) =>
      Effect.gen(function* () {
        const results = yield* CodeModeResults;
        const texts =
          pressure === "entries"
            ? smallSeeds
            : ["a", "b"].map((fill) => fill.repeat(RESULT_MAX_BYTES));
        // Either candidate displaces the oldest seed when it is actually published.
        const candidate = pressure === "entries" ? OUTPUT : "c".repeat(6 * 1024 * 1024);
        const ids = yield* seed(results, texts);
        for (const cancel of ["abort", "revoke"] as const) {
          for (const result of [SUCCEEDED, FAILED]) {
            let aborted = false;
            let current = true;
            const held = yield* heldRunner;
            const response = resultResponseFixture({
              results,
              run: held.run,
              aborted: () => aborted,
              current: () => current,
              capture: () => ({ status: "captured", text: candidate }),
            });
            const pending = yield* deliver(() => response.success(result)).pipe(Effect.forkChild);
            // The storage Effect has settled; its host Promise continuation has not run yet.
            yield* held.entered;
            if (cancel === "abort") aborted = true;
            else current = false;
            yield* held.release;
            const delivered = yield* Fiber.join(pending);
            expect(delivered.thrown).toBe(false);
            expect(delivered.details).toMatchObject({ cancelled: true });
            expect(delivered.details?.resultId).toBeUndefined();
            expect(delivered.details?.initialPreview).toBeUndefined();
            expect(delivered.text).toContain(
              `Original execution: ${result.ok ? "succeeded" : "failed"}`,
            );
          }
        }
        yield* expectRetained(results, ids, texts);
        const published = yield* deliver(() =>
          resultResponseFixture({
            results,
            capture: () => ({ status: "captured", text: candidate }),
          }).success(SUCCEEDED),
        );
        expect(published.details?.resultId).toBeDefined();
        expect(yield* results.get(ids[0]!)).toBeUndefined();
        yield* expectRetained(results, ids.slice(1), texts.slice(1));
      }).pipe(Effect.provide(CodeModeResults.layer)),
  );

  it.effect.each(["succeeded", "failed"] as const)(
    "publishes a concurrent %s execution while a cancelled retention settles",
    (outcome) =>
      Effect.gen(function* () {
        const results = yield* CodeModeResults;
        const ids = yield* seed(results, smallSeeds);
        let aborted = false;
        const held = yield* heldRunner;
        const pending = yield* deliver(() =>
          resultResponseFixture({
            results,
            run: held.run,
            aborted: () => aborted,
            capture: () => ({ status: "captured", text: "CANCELLED-OUTPUT" }),
          }).success(SUCCEEDED),
        ).pipe(Effect.forkChild);
        yield* held.entered;
        let retained: CodeModeToolDetails | undefined;
        const concurrent = yield* deliver(() =>
          resultResponseFixture({
            results,
            capture: () => ({ status: "captured", text: "PUBLISHED-OUTPUT" }),
            retain: (details) => {
              retained = details;
            },
          }).success(outcome === "succeeded" ? SUCCEEDED : FAILED),
        );
        aborted = true;
        yield* held.release;
        const late = yield* Fiber.join(pending);
        expect(late.details?.resultId).toBeUndefined();
        expect(late.text).toContain("Original execution: succeeded");

        expect(concurrent.thrown).toBe(outcome === "failed");
        const id = (concurrent.thrown ? retained : concurrent.details)?.resultId;
        expect(id).toBeDefined();
        expect(concurrent.text).toContain(id!);
        const artifact = yield* results.get(id!);
        expect(artifact).toMatchObject({
          outcome,
          kind: outcome === "succeeded" ? "output" : "failure-receipt",
        });
        expect(artifact?.text).toContain("PUBLISHED-OUTPUT");
        if (outcome === "succeeded") {
          expect(concurrent.details?.initialPreview).toMatchObject({
            id,
            status: "page",
            originalOutcome: "succeeded",
          });
        }
        // Only the published artifact displaced the oldest seed.
        expect(yield* results.get(ids[0]!)).toBeUndefined();
        yield* expectRetained(results, ids.slice(1), smallSeeds.slice(1));
      }).pipe(Effect.provide(CodeModeResults.layer)),
  );

  it.effect("publishes no ID when the session store closes while retention settles", () =>
    Effect.gen(function* () {
      for (const revoked of [true, false]) {
        const scope = yield* Scope.make();
        const results = Context.get(
          yield* Layer.buildWithScope(CodeModeResults.layer, scope),
          CodeModeResults,
        );
        let current = true;
        const held = yield* heldRunner;
        const pending = yield* deliver(() =>
          resultResponseFixture({
            results,
            run: held.run,
            current: () => current,
            capture: () => ({ status: "captured", text: OUTPUT }),
          }).success(SUCCEEDED),
        ).pipe(Effect.forkChild);
        yield* held.entered;
        yield* Scope.close(scope, Exit.void);
        // Replacement makes the session non-current; the closed store also refuses by itself.
        if (revoked) current = false;
        yield* held.release;
        const delivered = yield* Fiber.join(pending);
        expect(delivered.details?.resultId).toBeUndefined();
        expect(delivered.details?.initialPreview).toBeUndefined();
        expect(delivered.details?.cancelled === true).toBe(revoked);
        expect(delivered.text).toContain(revoked ? "revoked" : "retention-limit");
      }
    }),
  );
});
