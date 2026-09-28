import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { RESULT_MAX_ENTRIES } from "../src/results/model.ts";
import { CodeModeResults, type ResultsContract } from "../src/results/service.ts";
import type { CodeModeToolDetails } from "../src/tools/format.ts";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { codeModeStateFixture } from "./support/host.ts";
import { executeHarness, textOf, type ExecuteHarnessOptions } from "./support/execute.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";
import { utf8ByteLength } from "../src/tools/limits.ts";
import type { CodeModeInput } from "../src/tools/result-read.ts";

const json = Schema.fromJsonString(Schema.Unknown);
const pageFromJson = Schema.fromJsonString(
  Schema.Struct({
    outcome: Schema.String,
    kind: Schema.String,
    text: Schema.String,
    offset: Schema.Number,
    total: Schema.Number,
    next: Schema.NullOr(Schema.Number),
  }),
);
function harness(
  results: ResultsContract,
  {
    config,
    available,
    bash,
    ...environment
  }: ExecuteHarnessOptions & {
    readonly available?: () => boolean;
    readonly bash?: () => Promise<string>;
  } = {},
) {
  let writes = 0;
  let failure: CodeModeToolDetails | undefined;
  const state = codeModeStateFixture({ maxOutputBytes: 600, ...config });
  const write = {
    execute: () => {
      writes++;
      return Promise.resolve({ content: [{ type: "text", text: "written" }], details: {} });
    },
  };
  const { call } = executeHarness({
    ...environment,
    results,
    cwd: "/project",
    getState: () => ({ ...state, available: available?.() ?? state.available }),
    definitions: nestedToolDefinitionsFixture({
      read: write,
      write,
      edit: write,
      grep: write,
      find: write,
      ls: write,
      bash: {
        execute: () =>
          (bash?.() ?? Promise.resolve("done")).then((text) => ({
            content: [{ type: "text", text }],
            details: {},
          })),
      },
    }),
    retainFailureDetails: (_id, details) => {
      failure = details;
    },
  });
  return {
    run: (params: CodeModeInput, signal?: AbortSignal) => call(params, { signal }),
    writes: () => writes,
    failure: () => failure,
  };
}

describe("output recovery without replay", () => {
  it.effect(
    "rechecks publication after held retention without losing settled mutation receipts",
    () =>
      Effect.gen(function* () {
        const results = yield* CodeModeResults;
        // A full store: any artifact stored for a revoked delivery would evict a seed.
        const seeds: Array<string | undefined> = [];
        for (let index = 0; index < RESULT_MAX_ENTRIES; index++)
          seeds.push(yield* results.put(`SEED-${index}`, "succeeded"));
        for (const failed of [false, true]) {
          for (const revoke of ["abort", "replacement", "unavailable"] as const) {
            for (const refuseRetention of [false, true]) {
              const entered = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              let current = true;
              let available = true;
              const controller = new AbortController();
              const h = harness(
                {
                  ...results,
                  prepare: (text, outcome, kind) =>
                    Effect.gen(function* () {
                      yield* Deferred.succeed(entered, undefined);
                      yield* Deferred.await(release);
                      if (refuseRetention) return yield* Effect.die("store unavailable");
                      return yield* results.prepare(text, outcome, kind);
                    }),
                },
                {
                  isCurrent: () => current,
                  available: () => available,
                  config: { maxOutputBytes: 3000 },
                },
              );
              const pending = yield* Effect.promise(() =>
                h.run(
                  {
                    code:
                      'await tools.pi.write({path:"x",content:"secret"}); ' +
                      (failed
                        ? 'throw new Error("OLD-DIAGNOSTIC");'
                        : 'return "OLD-OUTPUT".repeat(1000);'),
                  },
                  controller.signal,
                ),
              ).pipe(Effect.forkChild);
              yield* Deferred.await(entered);
              if (revoke === "replacement") current = false;
              else if (revoke === "unavailable") available = false;
              else controller.abort();
              if (revoke === "unavailable") {
                expect(current).toBe(true);
                expect(controller.signal.aborted).toBe(false);
              }
              yield* Deferred.succeed(release, undefined);
              const delivered = yield* Fiber.join(pending);
              expect(delivered.details.cancelled).toBe(true);
              expect(delivered.details.resultId).toBeUndefined();
              expect(delivered.details.executionReceipts).toMatchObject({
                completed: 1,
                unknown: 0,
              });
              expect(textOf(delivered)).toContain("cancelled");
              expect(textOf(delivered)).toContain(
                `Original execution: ${failed ? "failed" : "succeeded"}`,
              );
              expect(textOf(delivered)).not.toContain("OLD-OUTPUT");
              expect(textOf(delivered)).not.toContain("OLD-DIAGNOSTIC");
              expect(h.failure()).toBeUndefined();
              expect(h.writes()).toBe(1);
            }
          }
        }
        for (const [index, id] of seeds.entries())
          expect((yield* results.get(id!))?.text).toBe(`SEED-${index}`);
      }).pipe(Effect.provide(CodeModeResults.layer)),
  );
  it.effect("mutates once and continues the initial page exactly with original outcome", () =>
    Effect.gen(function* () {
      const results = yield* CodeModeResults;
      const h = harness(results);
      const initial = yield* Effect.promise(() =>
        h.run({
          code: 'await tools.pi.write({path:"x",content:"private-body"}); return "😀x".repeat(1000);',
        }),
      );
      const id = initial.details.resultId!;
      expect(id).toBeTruthy();
      expect(utf8ByteLength(textOf(initial))).toBeLessThanOrEqual(600);
      const first = yield* Schema.decodeEffect(pageFromJson)(textOf(initial));
      expect(first.next).not.toBeNull();
      let offset = first.next ?? 0;
      let reconstructed = first.text;
      for (let count = 0; count < 100; count++) {
        const result = yield* Effect.promise(() =>
          h.run({ action: "result.read", id, offset, limit: 200 }),
        );
        const raw = textOf(result);
        expect(utf8ByteLength(raw)).toBeLessThanOrEqual(600);
        const page = yield* Schema.decodeEffect(pageFromJson)(raw);
        expect(page.outcome).toBe("succeeded");
        expect(page.kind).toBe("output");
        expect(result.details.resultRead).toEqual({
          status: "page",
          id,
          originalOutcome: "succeeded",
          offset: page.offset,
          end: page.offset + page.text.length,
          next: page.next,
          total: page.total,
        });
        reconstructed += page.text;
        if (page.next === null) break;
        expect(page.next).toBeGreaterThan(offset);
        offset = page.next;
      }
      expect(reconstructed).toBe("😀x".repeat(1000));
      expect(h.writes()).toBe(1);
      expect(textOf(initial)).not.toContain("private-body");
    }).pipe(Effect.provide(CodeModeResults.layer)),
  );

  it.effect("retains completed mutations despite a later throw or child output refusal", () =>
    Effect.gen(function* () {
      const results = yield* CodeModeResults;
      for (const config of [{}, { maxCumulativeChildOutputBytes: 0 }]) {
        const h = harness(results, { config });
        yield* Effect.promise(() =>
          expect(
            h.run({
              code: 'await tools.pi.write({path:"x",content:"do-not-retain-body"}); throw new Error("later failure");',
            }),
          ).rejects.toThrow(),
        );
        const details = h.failure()!;
        expect(details.executionReceipts).toMatchObject({ total: 1, completed: 1, unknown: 0 });
        const artifact = yield* results.get(details.resultId!);
        expect(artifact?.outcome).toBe("failed");
        expect(artifact?.kind).toBe("failure-receipt");
        expect(artifact?.text).not.toContain("do-not-retain-body");
        const page = yield* Effect.promise(() =>
          h.run({ action: "result.read", id: details.resultId! }),
        );
        expect((yield* Schema.decodeEffect(pageFromJson)(textOf(page))).outcome).toBe("failed");
        expect(page.details.resultRead).toMatchObject({
          status: "page",
          originalOutcome: "failed",
        });
        expect(h.writes()).toBe(1);
      }
    }).pipe(Effect.provide(CodeModeResults.layer)),
  );

  it.effect("keeps MCP validation repair action-specific on the actual guest path", () =>
    Effect.gen(function* () {
      const results = yield* CodeModeResults;
      const h = harness(results, { config: { maxOutputBytes: 3000 } });
      for (const input of [
        { action: "result.read", offset: -1 },
        { action: "tools.call", server: "TOP_SECRET", tool: 123 },
      ]) {
        const literal = yield* Schema.encodeEffect(json)(input);
        const result = yield* Effect.promise(() =>
          h.run({
            code: `try { await tools.mcp.request(${literal}); } catch(e) { return e.message; }`,
          }),
        );
        const text = textOf(result);
        expect(text).toContain("outcome=not-sent");
        expect(text).not.toContain("TOP_SECRET");
        if (input.action === "result.read") {
          expect(text).toContain("result.read");
          expect(text).not.toContain("tools.describe");
          expect(text).not.toContain("tools.search");
        } else {
          expect(text).toContain("tools.call");
          expect(text).not.toContain("result.read");
        }
      }
      expect(h.writes()).toBe(0);
    }).pipe(Effect.provide(CodeModeResults.layer)),
  );

  it.effect("rejects mixed execution forms before starting a program", () =>
    Effect.gen(function* () {
      const results = yield* CodeModeResults;
      const h = harness(results);
      const code = 'await tools.pi.write({path:"x",content:"bad"});';
      for (const extra of [{ id: "old-result" }, { offset: 1 }, { action: "unknown" }]) {
        const request = opaqueFixture({ code, ...extra });
        yield* Effect.promise(() => expect(h.run(request)).rejects.toThrow("No execution was run"));
      }
      expect(h.writes()).toBe(0);
    }).pipe(Effect.provide(CodeModeResults.layer)),
  );

  it.effect("keeps small success unchanged and reports no-hook recovery unavailable", () =>
    Effect.gen(function* () {
      const results = yield* CodeModeResults;
      const small = harness(results);
      const success = yield* Effect.promise(() => small.run({ code: 'return "unchanged";' }));
      expect(textOf(success)).toBe("unchanged");
      expect(success.details.resultId).toBeUndefined();
      const old = harness(results, {
        executeCodeMode: () => Effect.succeed({ ok: true, value: "cut", truncated: true }),
      });
      const unavailable = yield* Effect.promise(() => old.run({ code: "unused" }));
      expect(textOf(unavailable)).toContain("runtime-unavailable");
      expect(unavailable.details.resultId).toBeUndefined();
    }).pipe(Effect.provide(CodeModeResults.layer)),
  );

  it.effect(
    "does not dispatch code attached to a read and revokes read publication after replacement",
    () =>
      Effect.gen(function* () {
        const results = yield* CodeModeResults;
        const id = yield* results.put("sensitive old output", "succeeded");
        let current = true;
        const h = harness(results, {
          isCurrent: () => current,
          runInSession: (effect) =>
            Effect.runPromise(effect).then((value) => {
              current = false;
              return value;
            }),
        });
        const read = yield* Effect.promise(() => h.run({ action: "result.read", id: id! }));
        expect(textOf(read)).not.toContain("sensitive old output");
        expect(textOf(read)).toContain("revoked");
        expect(read.details.resultRead).toEqual({ status: "error", code: "revoked" });
        const safe = harness(results);
        const request = opaqueFixture({
          action: "result.read",
          id: id!,
          code: 'await tools.pi.write({path:"x",content:"bad"})',
        });
        const invalid = yield* Effect.promise(() => safe.run(request));
        expect(textOf(invalid)).toContain("Invalid result.read");
        expect(invalid.details.resultRead).toEqual({ status: "error", code: "invalid-input" });
        expect(safe.writes()).toBe(0);
      }).pipe(Effect.provide(CodeModeResults.layer)),
  );

  it.live("records pending native work as unknown after timeout and ignores late settlement", () =>
    Effect.gen(function* () {
      const results = yield* CodeModeResults;
      const pending = yield* Deferred.make<string>();
      const h = harness(results, {
        // The deadline also covers starting Node; bash never settles, so it still expires.
        config: { timeoutMs: 2_000, maxOutputBytes: 3000 },
        bash: () => Effect.runPromise(Deferred.await(pending)),
      });
      yield* Effect.promise(() =>
        expect(
          h.run({
            code: 'await tools.pi.write({path:"x",content:"secret"}); await tools.pi.bash({command:"sleep 10"});',
          }),
        ).rejects.toThrow(),
      );
      const details = h.failure()!;
      expect(details.executionReceipts).toMatchObject({ total: 2, completed: 1, unknown: 1 });
      const before = yield* Schema.encodeEffect(json)(details.executionReceipts);
      yield* Deferred.succeed(pending, "late result");
      yield* Effect.yieldNow;
      expect(yield* Schema.encodeEffect(json)(details.executionReceipts)).toBe(before);
      expect((yield* results.get(details.resultId!))?.outcome).toBe("failed");
      expect(h.writes()).toBe(1);
    }).pipe(Effect.provide(CodeModeResults.layer)),
  );
});
