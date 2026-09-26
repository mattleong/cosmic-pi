// Code Mode's Pi boundary owns preview preparation, registration currency, and snapshots.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vitest";
import { CodeModeConfigStore } from "../src/config/store.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { codeModeStateFixture } from "./support/host.ts";
import {
  applicationHarness,
  cleanupApplications,
  temporaryDirectory,
} from "./support/application.ts";

afterEach(cleanupApplications);

describe("code mode application lifecycle at the Pi boundary", () => {
  it.effect(
    "interrupts a pending preview load on replacement and registers only the replacement",
    () =>
      Effect.gen(function* () {
        const firstCwd = temporaryDirectory("pi-code-mode-lc-cwd-");
        const secondCwd = temporaryDirectory("pi-code-mode-lc-cwd-");
        const previewStarted = Deferred.makeUnsafe<void>();
        let firstSignal: AbortSignal | undefined;
        // The registered tool is never executed in this lifecycle test.
        const makeNestedDefinitions = vi.fn(() => opaqueFixture({}));
        const h = applicationHarness({
          loadSettings: (cwd, _trusted, signal) => {
            if (cwd !== firstCwd) return Promise.resolve(opaqueFixture({}));
            firstSignal = signal;
            void Deferred.doneUnsafe(previewStarted, Effect.void);
            return Promise.race([]);
          },
          makeNestedDefinitions,
        });
        const firstCtx = h.makeContext({ cwd: firstCwd });
        const firstStart = h.start(firstCtx);
        yield* Deferred.await(previewStarted);

        const secondCtx = h.makeContext({ cwd: secondCwd });
        const secondStart = h.start(secondCtx, "new");
        yield* Effect.promise(() => Promise.all([firstStart, secondStart]));

        expect(firstSignal?.aborted).toBe(true);
        expect(h.registerTool).toHaveBeenCalledTimes(1);
        expect(makeNestedDefinitions).toHaveBeenCalledTimes(1);
        expect(makeNestedDefinitions).toHaveBeenCalledWith(secondCwd);
        yield* Effect.promise(() => h.shutdown(secondCtx));
      }),
  );

  it.effect("interrupts a pending preview load on shutdown without registering", () =>
    Effect.gen(function* () {
      const previewStarted = Deferred.makeUnsafe<void>();
      let previewSignal: AbortSignal | undefined;
      const h = applicationHarness({
        loadSettings: (_cwd, _trusted, signal) => {
          previewSignal = signal;
          void Deferred.doneUnsafe(previewStarted, Effect.void);
          return Promise.race([]);
        },
      });
      const ctx = h.makeContext();
      const starting = h.start(ctx);
      yield* Deferred.await(previewStarted);
      const shutdown = h.shutdown(ctx);
      yield* Effect.promise(() => Promise.all([starting, shutdown]));

      expect(previewSignal?.aborted).toBe(true);
      expect(h.registerTool).not.toHaveBeenCalled();
      expect(h.activeTools()).not.toContain("code_mode");
    }),
  );

  it.effect("uses preview defaults when preview settings fail", () =>
    Effect.gen(function* () {
      const h = applicationHarness({
        loadSettings: () => Promise.reject(new Error("preview settings unavailable")),
      });
      const ctx = h.makeContext();
      yield* Effect.promise(() => h.start(ctx));
      expect(h.registerTool).toHaveBeenCalledTimes(1);
      yield* Effect.promise(() => h.shutdown(ctx));
    }),
  );

  it.effect("skips preview preparation and registration when unavailable or disabled", () =>
    Effect.gen(function* () {
      const untrustedLoad = vi.fn(() => Promise.resolve(opaqueFixture({})));
      const untrusted = applicationHarness({ loadSettings: untrustedLoad });
      const untrustedCtx = untrusted.makeContext({ trusted: false });
      yield* Effect.promise(() => untrusted.start(untrustedCtx));
      expect(untrustedLoad).not.toHaveBeenCalled();
      expect(untrusted.registerTool).not.toHaveBeenCalled();
      yield* Effect.promise(() => untrusted.shutdown(untrustedCtx));

      const disabledLoad = vi.fn(() => Promise.resolve(opaqueFixture({})));
      const disabled = applicationHarness({ loadSettings: disabledLoad });
      disabled.writeGlobalConfig('{"enabled":false}\n');
      const disabledCtx = disabled.makeContext();
      yield* Effect.promise(() => disabled.start(disabledCtx));
      expect(disabledLoad).not.toHaveBeenCalled();
      expect(disabled.registerTool).not.toHaveBeenCalled();
      yield* Effect.promise(() => disabled.shutdown(disabledCtx));
    }),
  );

  it.effect("contains a throwing definition factory and leaves the tool inactive", () =>
    Effect.gen(function* () {
      const h = applicationHarness({
        makeNestedDefinitions: () => {
          throw new Error("definition factory failed");
        },
      });
      const ctx = h.makeContext();
      yield* Effect.promise(() => h.start(ctx));

      expect(h.registerTool).not.toHaveBeenCalled();
      expect(h.activeTools()).not.toContain("code_mode");
      expect(h.notify.mock.calls.some((call) => call[1] === "warning")).toBe(true);
      yield* Effect.promise(() => h.shutdown(ctx));
    }),
  );

  it.effect("does not register when settings disable Code Mode during preview loading", () =>
    Effect.gen(function* () {
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const previewStarted = Deferred.makeUnsafe<void>();
      const releasePreview = Deferred.makeUnsafe<void>();
      const h = applicationHarness({
        loadSettings: () => {
          void Deferred.doneUnsafe(previewStarted, Effect.void);
          return runPromise(Deferred.await(releasePreview)).then(() => opaqueFixture({}));
        },
      });
      const ctx = h.makeContext({ signal: new AbortController().signal });
      const starting = h.start(ctx);
      yield* Deferred.await(previewStarted);

      yield* Effect.promise(() => h.command("global enabled false", ctx));
      yield* Deferred.succeed(releasePreview, undefined);
      yield* Effect.promise(() => starting);

      expect(h.registerTool).not.toHaveBeenCalled();
      expect(h.activeTools()).not.toContain("code_mode");
      yield* Effect.promise(() => h.shutdown(ctx));
    }),
  );

  it.effect(
    "rejects a deactivated session's late publication until its replacement publishes",
    () =>
      Effect.gen(function* () {
        const firstCwd = temporaryDirectory("pi-code-mode-lc-cwd-");
        const secondCwd = temporaryDirectory("pi-code-mode-lc-cwd-");
        const commit = Deferred.makeUnsafe<void>();
        const release = Deferred.makeUnsafe<void>();
        const nextStart = Deferred.makeUnsafe<void>();
        const publishNext = Deferred.makeUnsafe<void>();
        const initial = codeModeStateFixture({ catalogBudget: 2_000 });
        const stale = codeModeStateFixture({ catalogBudget: 7 });
        const replacement = codeModeStateFixture({ catalogBudget: 99 });
        let latePublicationAttempted = false;
        const h = applicationHarness({
          makeLayer: ({ cwd }, publish) => {
            const store = (state: typeof initial, setSetting = () => Effect.succeed(state)) =>
              CodeModeConfigStore.of({
                snapshot: () => state,
                setSetting,
                clearSetting: () => Effect.succeed(state),
              });
            if (cwd === secondCwd)
              return Layer.effect(
                CodeModeConfigStore,
                Deferred.succeed(nextStart, undefined).pipe(
                  Effect.andThen(Deferred.await(publishNext)),
                  Effect.andThen(
                    Effect.sync(() => {
                      publish(replacement);
                      return store(replacement);
                    }),
                  ),
                ),
              );
            const late = Deferred.succeed(commit, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                Effect.sync(() => {
                  latePublicationAttempted = true;
                  publish(stale);
                  return stale;
                }),
              ),
            );
            return Layer.effect(
              CodeModeConfigStore,
              Effect.sync(() => {
                publish(initial);
                return store(initial, () => Effect.uninterruptible(late));
              }),
            );
          },
        });
        const firstCtx = h.makeContext({ cwd: firstCwd });
        yield* Effect.promise(() => h.start(firstCtx));
        const oldWrite = h.command("global catalogBudget 7", firstCtx);
        yield* Deferred.await(commit);

        const secondCtx = h.makeContext({ cwd: secondCwd });
        const replacing = h.start(secondCtx, "new");
        h.notify.mockClear();
        yield* Effect.promise(() => h.command("status", secondCtx));
        expect(h.notify.mock.calls.map((call) => call[1])).toEqual(["warning"]);

        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(nextStart);
        expect(latePublicationAttempted).toBe(true);
        h.notify.mockClear();
        yield* Effect.promise(() => h.command("status", secondCtx));
        expect(h.notify.mock.calls.map((call) => call[1])).toEqual(["warning"]);

        yield* Deferred.succeed(publishNext, undefined);
        yield* Effect.promise(() => Promise.all([oldWrite, replacing]));
        h.notify.mockClear();
        yield* Effect.promise(() => h.command("status", secondCtx));
        expect(h.notify.mock.calls.map((call) => call[1])).toEqual(["info"]);
        expect(h.registerTool).toHaveBeenCalledTimes(2);
        yield* Effect.promise(() => h.shutdown(secondCtx));
      }),
  );

  it.effect(
    "revokes result IDs on tree navigation and gives the replacement a fresh registry",
    () =>
      Effect.gen(function* () {
        const h = applicationHarness();
        const ctx = h.makeContext();
        yield* Effect.promise(() => h.start(ctx));
        yield* Effect.promise(() => h.command("global maxOutputBytes 600", ctx));
        const original = h.registerTool.mock.calls.at(-1)![0];
        const retainedId = (tool: typeof original, callId: string, code: string) =>
          Effect.promise(() => tool.execute(callId, { code }, undefined, undefined, ctx)).pipe(
            Effect.flatMap((result) =>
              Schema.decodeUnknownEffect(Schema.Struct({ resultId: Schema.String }))(
                result.details,
              ),
            ),
            Effect.map(({ resultId }) => resultId),
          );
        const id = yield* retainedId(original, "retain", 'return "x".repeat(5000);');
        expect(id).toBeTruthy();
        yield* Effect.promise(() => h.tree(ctx));
        const replacement = h.registerTool.mock.calls.at(-1)![0];
        const read = yield* Effect.promise(() =>
          replacement.execute("read", { action: "result.read", id }, undefined, undefined, ctx),
        );
        expect(read.content).toEqual([
          { type: "text", text: expect.stringContaining("unavailable") },
        ]);
        yield* Effect.promise(() =>
          expect(
            original.execute("stale", { action: "result.read", id }, undefined, undefined, ctx),
          ).rejects.toThrow(),
        );
        const freshId = yield* retainedId(replacement, "fresh", 'return "y".repeat(5000);');
        expect(freshId).not.toBe(id);
        yield* Effect.promise(() => h.shutdown(ctx));
        yield* Effect.promise(() =>
          expect(
            replacement.execute(
              "closed",
              { action: "result.read", id: freshId },
              undefined,
              undefined,
              ctx,
            ),
          ).rejects.toThrow(),
        );
      }),
  );

  it.effect(
    "disabling interrupts active and queued dispatch without closing settings or reviving on enable",
    () =>
      Effect.gen(function* () {
        const queued = Deferred.makeUnsafe<void>();
        const signals: AbortSignal[] = [];
        const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
        const lateRead = Deferred.makeUnsafe<{
          content: { type: "text"; text: string }[];
          details: object;
        }>();
        const write = vi.fn(() =>
          Promise.resolve({ content: [{ type: "text", text: "written" }], details: {} }),
        );
        const h = applicationHarness({
          makeNestedDefinitions: () =>
            nestedToolDefinitionsFixture({
              read: {
                execute: (_id: string, _args: { readonly path: string }, signal: AbortSignal) => {
                  signals.push(signal);
                  return runPromise(Deferred.await(lateRead));
                },
              },
              write: { execute: write },
            }),
        });
        const ctx = h.makeContext();
        yield* Effect.promise(() => h.start(ctx));
        yield* Effect.promise(() => h.command("global maxToolCalls 100", ctx));
        const hasCounts = Schema.is(
          Schema.Struct({
            counts: Schema.Struct({
              total: Schema.Finite,
              queued: Schema.Finite,
              running: Schema.Finite,
            }),
          }),
        );
        const tool = h.registerTool.mock.calls.at(-1)![0];
        const pending = tool.execute(
          "in-flight",
          {
            code: 'await Promise.all(Array.from({length:40}, (_, i) => tools.pi.read({path:String(i)}))); return await tools.pi.write({path:"forbidden",content:"no"});',
          },
          undefined,
          (update) => {
            const details = update.details;
            if (
              hasCounts(details) &&
              details.counts.total === 40 &&
              details.counts.queued > 0 &&
              details.counts.running > 0
            )
              Deferred.doneUnsafe(queued, Effect.void);
          },
          ctx,
        );
        yield* Deferred.await(queued);
        expect(signals.length).toBeGreaterThan(0);
        expect(signals.length).toBeLessThan(40);
        const dispatched = signals.length;
        yield* Effect.promise(() => h.command("global enabled false", ctx));
        const result = yield* Effect.promise(() => pending);
        expect(result.details).toMatchObject({ cancelled: true });
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(signals).toHaveLength(dispatched);
        expect(write).not.toHaveBeenCalled();
        yield* Effect.promise(() => h.command("global enabled true", ctx));
        yield* Effect.promise(() =>
          expect(
            tool.execute("stale", { code: "return 1;" }, undefined, undefined, ctx),
          ).rejects.toThrow(),
        );
        yield* Effect.promise(() => h.start(ctx, "reload"));
        const replacement = h.registerTool.mock.calls.at(-1)![0];
        const fresh = yield* Effect.promise(() =>
          replacement.execute("fresh", { code: "return 1;" }, undefined, undefined, ctx),
        );
        expect(fresh.content).toEqual([{ type: "text", text: "1" }]);
        yield* Deferred.succeed(lateRead, {
          content: [{ type: "text" as const, text: "late" }],
          details: {},
        });
        yield* Effect.promise(() => runPromise(Deferred.await(lateRead)));
        expect(write).not.toHaveBeenCalled();
        expect(signals).toHaveLength(dispatched);
        yield* Effect.promise(() => h.shutdown(ctx));
      }),
  );

  it.effect("preserves unrelated active-tool order and duplicates during reconciliation", () =>
    Effect.gen(function* () {
      const h = applicationHarness({}, ["read", "read", "bash"]);
      const ctx = h.makeContext();
      yield* Effect.promise(() => h.start(ctx));
      expect(h.activeTools()).toEqual(["read", "read", "bash", "code_mode"]);

      yield* Effect.promise(() => h.shutdown(ctx));
      expect(h.activeTools()).toEqual(["read", "read", "bash"]);
    }),
  );
});
