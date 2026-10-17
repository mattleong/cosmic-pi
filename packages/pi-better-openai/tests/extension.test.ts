import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { JsonDocumentError, JsonDocumentStore, nodeFilePlatformLayer } from "pi-cosmic-core";
import { deferredPromise } from "pi-cosmic-core/testing";
import { afterEach, vi } from "vitest";
import { OPENAI_COMPACTION_DETAILS_TYPE } from "../src/compaction/protocol.ts";
import * as configStore from "../src/config/store.ts";
import { extensionHarness } from "./extension-harness.ts";
import { waitUntil } from "./helpers.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const invoke = (pending: Promise<void> | undefined): Effect.Effect<void> =>
  Effect.promise(() => Promise.resolve(pending));

const gateConfigCommits = Effect.gen(function* () {
  const committed = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let armed = false;
  let failLoads = false;
  const make = configStore.OpenAIConfigService.make;
  vi.spyOn(configStore.OpenAIConfigService, "make").mockImplementation((options) =>
    Effect.gen(function* () {
      const documents = yield* JsonDocumentStore;
      const gatedDocuments: typeof documents = {
        ...documents,
        exists: (path) =>
          failLoads
            ? Effect.fail(
                new JsonDocumentError({ operation: "exists", path, message: "unavailable" }),
              )
            : documents.exists(path),
        modifyObject: (path, update) =>
          documents.modifyObject(path, (raw) =>
            update(raw).pipe(
              Effect.map((modification) =>
                !armed
                  ? modification
                  : {
                      ...modification,
                      afterCommit: Deferred.succeed(committed, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.andThen(modification.afterCommit ?? Effect.void),
                      ),
                    },
              ),
            ),
          ),
      };
      return yield* make(options).pipe(Effect.provideService(JsonDocumentStore, gatedDocuments));
    }),
  );
  return {
    committed,
    release,
    failLoads: () => {
      failLoads = true;
    },
    arm: (value: boolean) => {
      armed = value;
    },
  };
});

layer(nodeFilePlatformLayer)("Better OpenAI session boundary", (it) => {
  for (const setting of ["fast.enabled"] as const) {
    it.effect(
      `shutdown revokes publication and notifications from an admitted ${setting} commit`,
      () =>
        Effect.gen(function* () {
          const h = yield* extensionHarness({ config: { persistState: true } });
          const gate = yield* gateConfigCommits;
          yield* h.emit("session_start");
          gate.arm(true);
          const pending = h.commands.get("openai")?.handler(`settings ${setting} true`, h.ctx);
          yield* Deferred.await(gate.committed);
          h.notify.mockClear();
          const shutdown = yield* h
            .emit("session_shutdown")
            .pipe(Effect.forkScoped({ startImmediately: true }));
          yield* Effect.yieldNow;
          yield* Deferred.succeed(gate.release, undefined);
          yield* invoke(pending);
          yield* Fiber.join(shutdown);
          expect(h.notify).not.toHaveBeenCalled();
          h.setStatus.mockClear();
          yield* h.emit("agent_start");
          expect(h.setStatus).not.toHaveBeenCalled();
          const requestHook = h.handlers.get("before_provider_request")?.[0];
          const injection = () =>
            Effect.promise(() =>
              Promise.resolve(
                requestHook?.({ type: "before_provider_request", payload: {} }, h.ctx),
              ),
            );
          expect(yield* injection()).toBeUndefined();
          gate.arm(false);
          yield* h.emit("session_start");
          if (setting === "fast.enabled") {
            expect(yield* injection()).toBeDefined();
          }
          yield* h.emit("session_shutdown");
        }),
    );
  }

  it.effect("a failed replacement cannot regain the retired session's publication authority", () =>
    Effect.gen(function* () {
      const h = yield* extensionHarness();
      const gate = yield* gateConfigCommits;
      yield* h.emit("session_start");
      gate.arm(true);
      const pending = h.commands.get("openai")?.handler("settings image.enabled true", h.ctx);
      yield* Deferred.await(gate.committed);
      gate.failLoads();
      const replacement = yield* h
        .emit("session_start", { ...h.ctx })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(gate.release, undefined);
      yield* invoke(pending);
      yield* Fiber.join(replacement);
      h.setStatus.mockClear();
      yield* h.emit("agent_start");
      expect(h.setStatus).not.toHaveBeenCalled();
      yield* h.emit("session_shutdown");
    }),
  );

  it.effect(
    "repairs the full context hook with prompt and tools, and aborts a mismatched native prefix",
    () =>
      Effect.gen(function* () {
        const h = yield* extensionHarness();
        const manager = SessionManager.inMemory(h.ctx.cwd);
        manager.appendMessage({
          role: "system",
          content: "system authority",
          toolsAdded: [{ name: "read", description: "read", parameters: { type: "object" } }],
          timestamp: 0,
        });
        manager.appendMessage({ role: "user", content: "covered history", timestamp: 1 });
        const retained = manager.appendMessage({ role: "user", content: "retained", timestamp: 2 });
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
        const ctx = { ...h.ctx, sessionManager: manager, abort: vi.fn() };
        yield* h.emit("session_start", ctx);
        const handler = h.handlers.get("context_with_system")[0]!;
        const messages = manager.buildSessionContext().messages;
        const result = yield* Effect.promise(() =>
          Promise.resolve(handler({ type: "context_with_system", messages }, ctx)),
        );
        const repaired = result ? result.messages : undefined;
        if (!repaired) throw new Error("Expected a repaired context");
        expect(repaired[0]?.role).toBe("system");
        expect(getCurrentSystemPrompt(repaired)).toBe("system authority");
        expect(getCurrentTools(repaired).map((tool) => tool.name)).toEqual(["read"]);
        expect(
          repaired.some((message) => "content" in message && message.content === "covered history"),
        ).toBe(true);
        expect(ctx.abort).not.toHaveBeenCalled();
        const rejected = yield* Effect.promise(() =>
          Promise.resolve(
            handler({ type: "context_with_system", messages: messages.slice(1) }, ctx),
          ),
        );
        expect(rejected).toBeUndefined();
        expect(ctx.abort).toHaveBeenCalledOnce();
        yield* h.emit("session_shutdown", ctx);
      }),
  );

  it.effect("activates only the replacement after its preview loader wins", () =>
    Effect.gen(function* () {
      const loads = [deferredPromise(), deferredPromise()];
      const signals: AbortSignal[] = [];
      let loadIndex = 0;
      const h = yield* extensionHarness({
        dependencies: {
          loadPreviewSettings: (_cwd, _projectTrusted, signal) => {
            if (signal) signals.push(signal);
            return loads[loadIndex++]!.promise;
          },
        },
      });
      const replacement = { ...h.ctx };

      const first = yield* h
        .emit("session_start")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* waitUntil(() => loadIndex === 1);
      const second = yield* h
        .emit("session_start", replacement)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* waitUntil(() => loadIndex === 2);
      loads[1]!.resolve();
      yield* Fiber.join(first);
      yield* Fiber.join(second);

      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      expect(h.tools).toHaveLength(1);

      loads[0]!.resolve();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(h.tools).toHaveLength(1);
      yield* h.emit("session_shutdown", replacement);
    }),
  );

  it.effect("shutdown aborts a stalled preview loader without activating", () =>
    Effect.gen(function* () {
      const load = deferredPromise();
      let loaderSignal: AbortSignal | undefined;
      const h = yield* extensionHarness({
        dependencies: {
          loadPreviewSettings: (_cwd, _projectTrusted, signal) => {
            loaderSignal = signal;
            return load.promise;
          },
        },
      });
      const startup = yield* h
        .emit("session_start")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* waitUntil(() => loaderSignal !== undefined);

      const shutdown = yield* h
        .emit("session_shutdown")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Fiber.join(startup);
      yield* Fiber.join(shutdown);

      expect(loaderSignal?.aborted).toBe(true);
      expect(h.tools).toHaveLength(0);
      load.resolve();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(h.tools).toHaveLength(0);
      expect(h.notify).not.toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );
});
