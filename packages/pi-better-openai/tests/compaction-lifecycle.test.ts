import { SessionManager, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { deferredPromise } from "pi-cosmic-core/testing";
import { afterEach, vi } from "vitest";
import { OPENAI_COMPACTION_DETAILS_TYPE } from "../src/compaction/protocol.ts";
import { projectOpenAIResponseInput } from "../src/compaction/projection.ts";
import { OpenAICompactionService } from "../src/compaction/service.ts";
import { extensionHarness } from "./extension-harness.ts";
import { serializedSnapshot, testModel } from "./helpers.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const checkpointedSession = (cwd: string) => {
  const manager = SessionManager.inMemory(cwd);
  manager.appendMessage({ role: "system", content: "system", timestamp: 0 });
  manager.appendMessage({ role: "user", content: "covered history", timestamp: 1 });
  const retained = manager.appendMessage({ role: "user", content: "tail question", timestamp: 2 });
  manager.appendCompaction(
    "owned",
    retained,
    100,
    {
      type: OPENAI_COMPACTION_DETAILS_TYPE,
      checkpoint: {
        version: 1,
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.5",
        output: [{ type: "compaction", encrypted_content: "encrypted" }],
        omittedEntryIds: [],
        createdAt: 0,
      },
    },
    true,
  );
  return manager;
};

const beforeCompactEvent = (signal: AbortSignal): SessionBeforeCompactEvent => ({
  type: "session_before_compact",
  preparation: {
    firstKeptEntryId: "retained",
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 100,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  },
  branchEntries: [],
  reason: "manual",
  willRetry: false,
  signal,
});

layer(nodeFilePlatformLayer)("compaction session authority", (it) => {
  for (const model of [testModel(), testModel("other", "anthropic", "anthropic-messages")])
    it.effect(`repairs a disabled checkpoint on ${model.provider}`, () =>
      Effect.gen(function* () {
        const h = yield* extensionHarness();
        const manager = checkpointedSession(h.cwd);
        const ctx = { ...h.ctx, model, sessionManager: manager };
        yield* h.emit("session_start", ctx);
        const result = yield* Effect.promise(() =>
          Promise.resolve(
            h.handlers.get("context_with_system")[0]!(
              { type: "context_with_system", messages: manager.buildSessionContext().messages },
              ctx,
            ),
          ),
        );
        expect(
          result &&
            Arr.some(
              result.messages ?? [],
              (message) => "content" in message && message.content === "covered history",
            ),
        ).toBe(true);
        yield* h.emit("session_shutdown", ctx);
      }),
    );

  it.effect("shutdown cancels delayed compaction without late projection", () =>
    Effect.gen(function* () {
      const started = deferredPromise();
      const gate = deferredPromise();
      const make = OpenAICompactionService.make;
      const projected = vi.fn();
      vi.spyOn(OpenAICompactionService, "make").mockImplementation((options) =>
        make(options).pipe(
          Effect.map((service) => ({
            ...service,
            compact: (event) =>
              Effect.promise(() => {
                started.resolve();
                return gate.promise;
              }).pipe(
                Effect.andThen(Effect.sync(projected)),
                Effect.andThen(service.compact(event)),
              ),
          })),
        ),
      );
      const h = yield* extensionHarness({ config: { compaction: { enabled: true } } });
      yield* h.emit("session_start");
      const pending = h.handlers.get("session_before_compact")[0]!(
        beforeCompactEvent(new AbortController().signal),
        h.ctx,
      );
      yield* Effect.promise(() => started.promise);
      h.notify.mockClear();
      yield* h.emit("session_shutdown");
      expect(yield* Effect.promise(() => Promise.resolve(pending))).toEqual({ cancel: true });
      gate.resolve();
      yield* Effect.yieldNow;
      expect(projected).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
    }),
  );

  it.effect("concurrent checkpoint injection works even with a version mismatch", () =>
    Effect.gen(function* () {
      const h = yield* extensionHarness({
        config: { compaction: { enabled: true } },
        dependencies: { piAiVersions: { host: "host", projection: "other" } },
      });
      const manager = checkpointedSession(h.cwd);
      manager.appendMessage({ role: "user", content: "uncovered question", timestamp: 3 });
      const model = testModel();
      const ctx = { ...h.ctx, model, sessionManager: manager };
      yield* h.emit("session_start", ctx);
      const inject = h.handlers.get("before_provider_request")[0]!;
      const event = {
        type: "before_provider_request" as const,
        payload: { input: projectOpenAIResponseInput(model, manager.getBranch()) },
      };
      const results = yield* Effect.promise(() =>
        Promise.all([inject(event, ctx), inject(event, ctx)]),
      );
      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toMatchObject({
        input: [{ type: "compaction", encrypted_content: "encrypted" }, expect.any(Object)],
      });
      expect(serializedSnapshot(results[0])).not.toContain("covered history");
      expect(serializedSnapshot(results[0])).toContain("uncovered question");
      yield* h.emit("session_shutdown", ctx);
    }),
  );

  for (const replacement of [undefined, new AbortController().signal])
    it.effect(
      `aborted checkpoint injection cannot regain authority from ${replacement ? "a new signal" : "a cleared signal"}`,
      () =>
        Effect.gen(function* () {
          const started = deferredPromise();
          const gate = deferredPromise();
          const make = OpenAICompactionService.make;
          vi.spyOn(OpenAICompactionService, "make").mockImplementation((options) =>
            make(options).pipe(
              Effect.map((service) => ({
                ...service,
                inject: (payload) =>
                  Effect.promise(() => {
                    started.resolve();
                    return gate.promise;
                  }).pipe(Effect.andThen(service.inject(payload))),
              })),
            ),
          );
          const controller = new AbortController();
          let signal: AbortSignal | undefined = controller.signal;
          const h = yield* extensionHarness({ config: { compaction: { enabled: true } } });
          const manager = checkpointedSession(h.cwd);
          const ctx = {
            ...h.ctx,
            sessionManager: manager,
            get signal() {
              return signal;
            },
          };
          yield* h.emit("session_start");
          const pending = h.handlers.get("before_provider_request")[0]!(
            { type: "before_provider_request", payload: { input: [] } },
            ctx,
          );
          yield* Effect.promise(() => started.promise);
          controller.abort();
          signal = replacement;
          gate.resolve();
          expect(yield* Effect.promise(() => Promise.resolve(pending))).toBeUndefined();
          yield* h.emit("session_shutdown");
        }),
    );

  it.effect("retirement discards pending provider payload changes", () =>
    Effect.gen(function* () {
      const h = yield* extensionHarness();
      h.getFlag.mockReturnValue(true);
      yield* h.emit("session_start");
      const pending = h.handlers.get("before_provider_request")[0]!(
        { type: "before_provider_request", payload: {} },
        h.ctx,
      );
      const shutdown = h.handlers.get("session_shutdown")[0]!(
        { type: "session_shutdown", reason: "quit" },
        h.ctx,
      );

      const result = yield* Effect.promise(() => Promise.resolve(pending));
      yield* Effect.promise(() => Promise.resolve(shutdown));

      expect(result).toBeUndefined();
    }),
  );

  it.effect("retired context repair cannot abort or notify the host", () =>
    Effect.gen(function* () {
      const h = yield* extensionHarness();
      const manager = checkpointedSession(h.cwd);
      const ctx = { ...h.ctx, sessionManager: manager, abort: vi.fn() };
      yield* h.emit("session_start", ctx);
      h.notify.mockClear();
      const pending = h.handlers.get("context_with_system")[0]!(
        { type: "context_with_system", messages: manager.buildSessionContext().messages },
        ctx,
      );
      const shutdown = h.handlers.get("session_shutdown")[0]!(
        { type: "session_shutdown", reason: "quit" },
        ctx,
      );

      const result = yield* Effect.promise(() => Promise.resolve(pending));
      yield* Effect.promise(() => Promise.resolve(shutdown));

      expect(result).toBeUndefined();
      expect(ctx.abort).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
    }),
  );

  it.effect("retired compaction cancels without offering native fallback or notifying", () =>
    Effect.gen(function* () {
      const h = yield* extensionHarness();
      yield* h.emit("session_start");
      h.notify.mockClear();
      const pending = h.handlers.get("session_before_compact")[0]!(
        beforeCompactEvent(yield* Effect.abortSignal),
        h.ctx,
      );
      const shutdown = h.handlers.get("session_shutdown")[0]!(
        { type: "session_shutdown", reason: "quit" },
        h.ctx,
      );

      const result = yield* Effect.promise(() => Promise.resolve(pending));
      yield* Effect.promise(() => Promise.resolve(shutdown));

      expect(result).toEqual({ cancel: true });
      expect(h.notify).not.toHaveBeenCalled();
    }),
  );

  for (const projection of ["1.4.0", "1.5.0"])
    it.effect(`warns about Pi compaction only for a mismatched pi-ai ${projection}`, () =>
      Effect.gen(function* () {
        const h = yield* extensionHarness({
          config: { compaction: { enabled: true } },
          dependencies: { piAiVersions: { host: "1.4.0", projection } },
        });
        yield* h.emit("session_start");
        h.notify.mockClear();
        const result = yield* Effect.promise(() =>
          Promise.resolve(
            h.handlers.get("session_before_compact")[0]!(
              beforeCompactEvent(new AbortController().signal),
              h.ctx,
            ),
          ),
        );
        expect(result).toBeUndefined();
        if (projection === "1.4.0") expect(h.notify).not.toHaveBeenCalled();
        else expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
        yield* h.emit("session_shutdown");
      }),
    );
});
