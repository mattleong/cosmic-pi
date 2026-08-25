import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach, vi } from "vitest";
import betterOpenAI, {
  betterOpenAIWithDependencies,
  type BetterOpenAIExtensionDependencies,
} from "../src/extension.ts";

type Handler = ExtensionHandler<any, any>;
type Command = NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>;
afterEach(() => {
  vi.unstubAllEnvs();
});

interface TestConfigDocument {
  readonly persistState: boolean;
  readonly usage: {
    readonly enabled: boolean;
    readonly showOnlyOnSubscriptionModels?: boolean;
  };
  readonly footer: { readonly mode: string };
  readonly image: { readonly enabled: boolean };
}

// Pure fixture serialization stays outside Effect code on purpose: the runtime under
// test owns schema decoding of this persisted document.
const encodeConfigDocument = (config: TestConfigDocument): string => JSON.stringify(config);

const harness = (dependencies?: BetterOpenAIExtensionDependencies) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "openai-extension-" });
    const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "openai-agent-" });
    yield* fs.makeDirectory(path.join(cwd, ".pi", "extensions"), { recursive: true });
    yield* fs.writeFileString(
      path.join(cwd, ".pi", "extensions", "pi-better-openai.json"),
      encodeConfigDocument({
        persistState: false,
        usage: { enabled: false },
        footer: { mode: "status" },
        image: { enabled: false },
      }),
    );
    yield* Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", agentDir));
    const handlers = new Map<string, Handler[]>();
    const commands = new Map<string, Command>();
    let tool: any;
    let toolActivations = 0;
    const piFixture = {
      on(name: string, handler: Handler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: Command }) {
        commands.set(name, options.handler);
      },
      registerFlag: vi.fn(),
      getFlag: vi.fn(() => false),
      getThinkingLevel: vi.fn(() => "off"),
      registerTool(value: any) {
        tool = value;
        toolActivations++;
      },
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
      events: { emit: vi.fn(), on: vi.fn() },
    };
    // SAFETY: Better OpenAI registration uses only the ExtensionAPI methods implemented here.
    const pi = piFixture as typeof piFixture & ExtensionAPI;
    const contextFixture = {
      cwd,
      mode: "rpc",
      hasUI: true,
      model: { provider: "openai", id: "gpt-5.5" },
      modelRegistry: {
        isUsingOAuth: () => true,
        getApiKeyForProvider: () => Promise.resolve(undefined),
      },
      ui: { notify: vi.fn(), setStatus: vi.fn(), setFooter: vi.fn() },
      sessionManager: {
        getEntries: () => [],
        getBranch: () => [],
        buildContextEntries: () => [],
        getLeafId: () => null,
        getCwd: () => cwd,
        getSessionName: () => undefined,
      },
      getContextUsage: () => ({ contextWindow: 100, percent: 1 }),
      getSystemPrompt: () => "system",
      isProjectTrusted: vi.fn(() => true),
    };
    // SAFETY: This harness supplies every context member exercised by events and commands.
    const ctx = contextFixture as typeof contextFixture & ExtensionCommandContext;
    if (dependencies) betterOpenAIWithDependencies(pi, dependencies);
    else betterOpenAI(pi);
    const emit = (name: string, event: any = {}, useCtx = ctx): Effect.Effect<void> =>
      Effect.forEach(
        handlers.get(name) ?? [],
        (handler) => Effect.promise(() => Promise.resolve(handler(event, useCtx))),
        { discard: true },
      );
    return {
      ctx,
      handlers,
      commands,
      get tool() {
        return tool;
      },
      get toolActivations() {
        return toolActivations;
      },
      pi,
      emit,
    };
  });

function deferredPromise() {
  const handle = Deferred.makeUnsafe<void>();
  return {
    promise: Effect.runPromise(Deferred.await(handle)),
    resolve: () => {
      Effect.runSync(Deferred.succeed(handle, undefined));
    },
  };
}

const invoke = <ValueInput>(value: ValueInput): Effect.Effect<void> =>
  Effect.promise(() => Promise.resolve(value).then(() => undefined));

const waitUntil = (predicate: () => boolean): Effect.Effect<void> =>
  Effect.promise(() =>
    vi.waitFor(() => {
      expect(predicate()).toBe(true);
    }),
  );

layer(nodeFilePlatformLayer)("Better OpenAI session boundary", (it) => {
  it.effect("activates only the replacement after its preview loader wins", () =>
    Effect.gen(function* () {
      const loads = [deferredPromise(), deferredPromise()];
      const signals: AbortSignal[] = [];
      let loadIndex = 0;
      const h = yield* harness({
        loadPreviewSettings: (_cwd, _projectTrusted, signal) => {
          if (signal) signals.push(signal);
          return loads[loadIndex++]!.promise;
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
      expect(h.toolActivations).toBe(1);

      loads[0]!.resolve();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(h.toolActivations).toBe(1);
      yield* invoke(h.commands.get("openai-usage")?.("", replacement));
      expect(replacement.ui.notify).toHaveBeenCalledWith("Usage display is disabled.", "warning");
      yield* h.emit("session_shutdown", {}, replacement);
    }),
  );

  it.effect("treats preview loader failure as best effort", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        loadPreviewSettings: () => Promise.reject(new Error("settings unavailable")),
      });

      yield* h.emit("session_start");

      expect(h.toolActivations).toBe(1);
      yield* invoke(h.commands.get("openai-usage")?.("", h.ctx));
      expect(h.ctx.ui.notify).toHaveBeenCalledWith("Usage display is disabled.", "warning");
      yield* h.emit("session_shutdown");
    }),
  );

  it.effect("reports a success-path command defect instead of swallowing it", () =>
    Effect.gen(function* () {
      let resets = 0;
      const h = yield* harness({
        resetOpenAICodexTransport: () => {
          resets++;
          if (resets > 1) throw new Error("transport reset defect");
        },
      });
      yield* h.emit("session_start");
      vi.mocked(h.ctx.ui.notify).mockClear();

      yield* invoke(h.commands.get("fast")?.("", h.ctx));

      expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "warning");
      yield* h.emit("session_shutdown");
    }),
  );

  it.effect("does not report image cancellation as message-delivery failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const h = yield* harness();
      yield* fs.writeFileString(
        path.join(h.ctx.cwd, ".pi", "extensions", "pi-better-openai.json"),
        encodeConfigDocument({
          persistState: false,
          usage: { enabled: false },
          footer: { mode: "off" },
          image: { enabled: true },
        }),
      );
      yield* h.emit("session_start");
      const controller = new AbortController();
      controller.abort(new Error("cancel image"));
      h.ctx.signal = controller.signal;
      vi.mocked(h.ctx.ui.notify).mockClear();

      yield* invoke(h.commands.get("openai-image")?.("cancelled prompt", h.ctx));

      expect(h.ctx.ui.notify).not.toHaveBeenCalledWith(expect.any(String), "warning");
      yield* h.emit("session_shutdown");
    }),
  );

  it.effect("keeps the replacement context current after deactivating the previous runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const h = yield* harness();
      const configPath = path.join(h.ctx.cwd, ".pi", "extensions", "pi-better-openai.json");
      yield* fs.writeFileString(
        configPath,
        encodeConfigDocument({
          persistState: false,
          usage: { enabled: true, showOnlyOnSubscriptionModels: true },
          footer: { mode: "off" },
          image: { enabled: false },
        }),
      );
      yield* h.emit("session_start");
      const replacement = { ...h.ctx };
      yield* h.emit("session_start", {}, replacement);
      vi.mocked(h.ctx.ui.notify).mockClear();

      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const selected = {
        ...replacement,
        model: { ...replacement.model, provider: "anthropic", id: "claude" },
      };
      yield* h.emit("model_select", { model: selected.model }, selected);
      yield* invoke(h.commands.get("openai-usage")?.("", selected));

      expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(
        "Usage hidden: current model is not an OpenAI subscription model.",
        "warning",
      );
      yield* h.emit("session_shutdown", {}, selected);
    }),
  );

  it.effect("fails closed when terminal UI capability getters throw during activation", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      Object.defineProperty(h.ctx, "mode", {
        configurable: true,
        get() {
          throw new Error("host mode unavailable");
        },
      });

      yield* h.emit("session_start");
      expect(h.ctx.ui.setFooter).not.toHaveBeenCalled();
      yield* invoke(h.commands.get("openai-settings")?.("usage.enabled false", h.ctx));
      yield* h.emit("session_shutdown");
    }),
  );

  it.effect("shutdown aborts a stalled preview loader without activating", () =>
    Effect.gen(function* () {
      const load = deferredPromise();
      let loaderSignal: AbortSignal | undefined;
      const h = yield* harness({
        loadPreviewSettings: (_cwd, _projectTrusted, signal) => {
          loaderSignal = signal;
          return load.promise;
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
      expect(h.toolActivations).toBe(0);
      load.resolve();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(h.toolActivations).toBe(0);
      expect(h.ctx.ui.notify).not.toHaveBeenCalledWith("Better OpenAI failed to start.", "warning");
    }),
  );

  it.effect("disposes and clears a runtime when startup is already aborted", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const controller = new AbortController();
      controller.abort(new Error("already gone"));
      h.ctx.signal = controller.signal;
      yield* h.emit("session_start");
      expect(h.ctx.ui.notify).toHaveBeenCalledWith("Better OpenAI failed to start.", "warning");
      expect(h.tool).toBeUndefined();
    }),
  );

  it.effect.each(["cwd", "signal"] as const)(
    "fails closed and deactivates the prior runtime when the session %s getter throws",
    (property) =>
      Effect.gen(function* () {
        const h = yield* harness();
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

        expect(h.ctx.ui.notify).toHaveBeenCalledWith("Better OpenAI failed to start.", "warning");
        yield* Effect.promise(() =>
          expect(
            h.tool.execute("call", { prompt: "x" }, undefined, undefined, h.ctx),
          ).rejects.toThrow("has not started"),
        );
      }),
  );

  it.effect("materializes one dynamic signal for both model-change forks", () =>
    Effect.gen(function* () {
      const h = yield* harness();
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
