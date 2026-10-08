import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { deferredPromise } from "pi-cosmic-core/testing";
import {
  COSMIC_UI_HOST_QUERY,
  COSMIC_UI_HOST_STATE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_PROTOCOL_VERSION,
  type CosmicUiHostQuery,
} from "pi-cosmic-ui/protocol";
import { afterEach, vi } from "vitest";
import { OPENAI_COMPACTION_DETAILS_TYPE } from "../src/compaction/protocol.ts";
import * as configStore from "../src/config/store.ts";
import { extensionHarness } from "./extension-harness.ts";
import { waitUntil } from "./helpers.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const invoke = <ValueInput>(value: ValueInput): Effect.Effect<void> =>
  Effect.promise(() => Promise.resolve(value).then(() => undefined));

/** While armed, each config commit signals `committed`, then waits for `release`. */
const gateConfigCommits = Effect.gen(function* () {
  const committed = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let armed = false;
  const modify = configStore.modifyConfig;
  const gatedModify: typeof modify = (path, update) =>
    modify(path, (raw) => {
      const modification = update(raw);
      if (!armed) return modification;
      return {
        ...modification,
        afterCommit: Deferred.succeed(committed, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(modification.afterCommit ?? Effect.void),
        ),
      };
    });
  vi.spyOn(configStore, "modifyConfig").mockImplementation(gatedModify);
  return {
    committed,
    release,
    arm: (value: boolean) => {
      armed = value;
    },
  };
});

layer(nodeFilePlatformLayer)("Better OpenAI session boundary", (it) => {
  for (const setting of ["image.enabled", "fast.enabled"] as const) {
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
          vi.mocked(h.ctx.ui.notify).mockClear();
          const shutdown = yield* h
            .emit("session_shutdown")
            .pipe(Effect.forkScoped({ startImmediately: true }));
          yield* Effect.yieldNow;
          yield* Deferred.succeed(gate.release, undefined);
          yield* invoke(pending);
          yield* Fiber.join(shutdown);
          expect(h.ctx.ui.notify).not.toHaveBeenCalled();
          vi.mocked(h.ctx.ui.setStatus).mockClear();
          yield* h.emit("agent_start");
          expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
          const requestHook = h.handlers.get("before_provider_request")?.[0];
          const injection = () =>
            Effect.promise(() => Promise.resolve(requestHook?.({ payload: {} }, h.ctx)));
          expect(yield* injection()).toBeUndefined();
          // The committed setting is durable, and a later session may legitimately use it.
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
      vi.spyOn(configStore, "resolveConfig").mockReturnValue(
        Effect.fail(
          new configStore.OpenAIConfigError({
            operation: "read",
            path: "test",
            message: "unavailable",
          }),
        ),
      );
      const replacement = yield* h
        .emit("session_start", {}, { ...h.ctx })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(gate.release, undefined);
      yield* invoke(pending);
      yield* Fiber.join(replacement);
      vi.mocked(h.ctx.ui.setStatus).mockClear();
      yield* h.emit("agent_start");
      expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
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
              rawInputCount: 1,
              createdAt: 0,
              tokensBefore: 100,
            },
          },
          true,
        );
        const ctx = { ...h.ctx, sessionManager: manager, abort: vi.fn() };
        yield* h.emit("session_start", {}, ctx);
        const handler = h.handlers.get("context_with_system")![0]!;
        const messages = manager.buildSessionContext().messages;
        const repaired = yield* Effect.promise(() =>
          Promise.resolve(handler({ type: "context_with_system", messages }, ctx)),
        );
        expect(repaired.messages[0]?.role).toBe("system");
        expect(getCurrentSystemPrompt(repaired.messages)).toBe("system authority");
        expect(getCurrentTools(repaired.messages).map((tool) => tool.name)).toEqual(["read"]);
        expect(
          repaired.messages.some(
            (message: { content: unknown }) => message.content === "covered history",
          ),
        ).toBe(true);
        expect(ctx.abort).not.toHaveBeenCalled();
        const rejected = yield* Effect.promise(() =>
          Promise.resolve(
            handler({ type: "context_with_system", messages: messages.slice(1) }, ctx),
          ),
        );
        expect(rejected).toBeUndefined();
        expect(ctx.abort).toHaveBeenCalledOnce();
        yield* h.emit("session_shutdown", {}, ctx);
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
        .emit("session_start", {}, replacement)
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
      yield* h.emit("session_shutdown", {}, replacement);
    }),
  );

  it.effect("treats preview loader failure as best effort", () =>
    Effect.gen(function* () {
      const h = yield* extensionHarness({
        dependencies: {
          loadPreviewSettings: () => Promise.reject(new Error("settings unavailable")),
        },
      });

      yield* h.emit("session_start");

      expect(h.tools).toHaveLength(1);
      vi.mocked(h.ctx.ui.notify).mockClear();
      yield* invoke(h.commands.get("openai")?.handler("usage", h.ctx));
      expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "warning");
      yield* h.emit("session_shutdown");
    }),
  );

  it.effect("reports a success-path command defect instead of swallowing it", () =>
    Effect.gen(function* () {
      let resets = 0;
      const h = yield* extensionHarness({
        dependencies: {
          resetOpenAICodexTransport: () => {
            resets++;
            if (resets > 1) throw new Error("transport reset defect");
          },
        },
      });
      yield* h.emit("session_start");
      vi.mocked(h.ctx.ui.notify).mockClear();

      yield* invoke(h.commands.get("openai")?.handler("fast", h.ctx));

      expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "warning");
      yield* h.emit("session_shutdown");
    }),
  );

  it.effect("does not report image cancellation as message-delivery failure", () =>
    Effect.gen(function* () {
      const h = yield* extensionHarness({ config: { image: { enabled: true } } });
      yield* h.emit("session_start");
      const controller = new AbortController();
      controller.abort(new Error("cancel image"));
      h.ctx.signal = controller.signal;
      vi.mocked(h.ctx.ui.notify).mockClear();

      yield* invoke(h.commands.get("openai")?.handler("image cancelled prompt", h.ctx));

      expect(h.ctx.ui.notify).not.toHaveBeenCalledWith(expect.any(String), "warning");
      yield* h.emit("session_shutdown");
    }),
  );

  it.effect("keeps the replacement context current after deactivating the previous runtime", () =>
    Effect.gen(function* () {
      const h = yield* extensionHarness({
        config: { usage: { showOnlyOnSubscriptionModels: true } },
      });
      yield* h.emit("session_start");
      const replacement = { ...h.ctx };
      yield* h.emit("session_start", {}, replacement);
      vi.mocked(h.ctx.ui.notify).mockClear();

      const selected = {
        ...replacement,
        model: { ...replacement.model, provider: "anthropic", id: "claude" },
      };
      yield* h.emit("model_select", { model: selected.model }, selected);
      yield* invoke(h.commands.get("openai")?.handler("usage", selected));

      expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.any(String), "warning");
      yield* h.emit("session_shutdown", {}, selected);
    }),
  );

  it.effect("uses one visibility policy for Cosmic contributions and default-footer fallback", () =>
    Effect.gen(function* () {
      const h = yield* extensionHarness();
      const ctx = { ...h.ctx, mode: "tui" as const };
      vi.mocked(h.pi.getFlag).mockReturnValue(true);
      let active = true;
      let hidden: string[] = [];
      vi.mocked(h.pi.events.emit).mockImplementation((name, data) => {
        if (name === COSMIC_UI_HOST_QUERY) {
          // SAFETY: Only the typed host query is emitted under this name.
          (data as CosmicUiHostQuery).respond({ active, ready: true, hidden });
        }
      });
      yield* h.emit("session_start", {}, ctx);
      const stateListener = vi
        .mocked(h.pi.events.on)
        .mock.calls.find(([name]) => name === COSMIC_UI_HOST_STATE)?.[1];
      const publish = () =>
        stateListener?.({ version: COSMIC_UI_PROTOCOL_VERSION, active, ready: true, hidden });
      expect(h.pi.events.emit).toHaveBeenCalledWith(
        COSMIC_UI_FOOTER_UPSERT,
        expect.objectContaining({ contribution: expect.objectContaining({ id: "openai.fast" }) }),
      );
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("better-openai", undefined);

      active = false;
      publish();
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("better-openai", expect.any(String));
      hidden = ["openai.fast"];
      publish();
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("better-openai", undefined);
      expect(h.pi.events.emit).toHaveBeenCalledWith(
        COSMIC_UI_FOOTER_REMOVE,
        expect.objectContaining({ id: "openai.fast" }),
      );

      hidden = [];
      publish();
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("better-openai", expect.any(String));
      yield* h.emit("session_shutdown", {}, ctx);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("better-openai", undefined);
      expect(ctx.ui.setFooter).not.toHaveBeenCalled();
    }),
  );

  it.effect("fails closed when terminal UI capability getters throw during activation", () =>
    Effect.gen(function* () {
      const h = yield* extensionHarness();
      Object.defineProperty(h.ctx, "mode", {
        configurable: true,
        get() {
          throw new Error("host mode unavailable");
        },
      });

      yield* h.emit("session_start");
      expect(h.ctx.ui.setFooter).not.toHaveBeenCalled();
      yield* invoke(
        h.commands.get("openai")?.handler("settings usage.showResetTimes false", h.ctx),
      );
      yield* h.emit("session_shutdown");
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
      expect(h.ctx.ui.notify).not.toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("disposes and clears a runtime when startup is already aborted", () =>
    Effect.gen(function* () {
      const h = yield* extensionHarness();
      const controller = new AbortController();
      controller.abort(new Error("already gone"));
      h.ctx.signal = controller.signal;
      yield* h.emit("session_start");
      expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "warning");
      expect(h.tools).toHaveLength(0);
    }),
  );

  it.effect.each(["cwd", "signal"] as const)(
    "fails closed and deactivates the prior runtime when the session %s getter throws",
    (property) =>
      Effect.gen(function* () {
        const h = yield* extensionHarness();
        yield* h.emit("session_start");
        vi.mocked(h.ctx.ui.notify).mockClear();
        const replacement = { ...h.ctx };
        Object.defineProperty(replacement, property, {
          configurable: true,
          get() {
            throw new Error(`${property} unavailable`);
          },
        });

        yield* h.emit("session_start", {}, replacement);

        expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "warning");
        yield* Effect.promise(() =>
          expect(
            h.tools.at(-1)!.execute("call", { prompt: "x" }, undefined, undefined, h.ctx),
          ).rejects.toThrow("has not started"),
        );
      }),
  );

  it.effect("materializes one dynamic signal for both model-change forks", () =>
    Effect.gen(function* () {
      const h = yield* extensionHarness();
      yield* h.emit("session_start");
      let reads = 0;
      Object.defineProperty(h.ctx, "signal", {
        configurable: true,
        get() {
          reads++;
          if (reads > 1) throw new Error("signal was read again");
          return undefined;
        },
      });

      yield* h.emit("model_select", {}, h.ctx);

      expect(reads).toBe(1);
      yield* h.emit("session_shutdown", {}, h.ctx);
    }),
  );
});
