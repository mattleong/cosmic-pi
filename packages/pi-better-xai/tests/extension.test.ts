import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach, vi } from "vitest";
import betterXai, {
  betterXaiWithDependencies,
  type BetterXaiExtensionDependencies,
} from "../src/extension.ts";
import { extensionApiFixture, extensionContextFixture } from "./support/host.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

type Handler = ExtensionHandler<any, any>;
type Command = NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>;
type TestSurface = {
  readonly render?: (width: number) => string[];
  readonly invalidate?: () => void;
  readonly handleInput?: (data: string) => void;
};
type TestSurfaceFactory = (
  tui: { readonly terminal?: { readonly rows: number }; readonly requestRender: () => void },
  theme: {
    readonly bold: (text: string) => string;
    readonly fg: (color: string, text: string) => string;
  },
  keybindings: {
    readonly matches: (data: string, id: string) => boolean;
    readonly getKeys?: (id: string) => readonly string[];
  },
  done: (result: undefined) => void,
) => TestSurface;

const harness = (dependencies?: BetterXaiExtensionDependencies) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "pi-better-xai-project-" });
    const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-better-xai-agent-" });
    const configDirectory = path.join(cwd, ".pi", "extensions");
    yield* fs.makeDirectory(configDirectory, { recursive: true });
    yield* fs.writeFileString(
      path.join(configDirectory, "pi-better-xai.json"),
      '{"usage":{"enabled":false},"footer":{"mode":"status"}}\n',
    );
    yield* Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", agentDir));

    const handlers = new Map<string, Handler>();
    const commands = new Map<string, Command>();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const setFooter = vi.fn();
    const pi = extensionApiFixture({
      on(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
      registerCommand(name: string, options: { handler: Command }) {
        commands.set(name, options.handler);
      },
      events: { emit: vi.fn(), on: vi.fn() },
    });
    const ctx = extensionContextFixture({
      cwd,
      mode: "tui",
      hasUI: true,
      model: { provider: "xai", id: "grok" },
      modelRegistry: {
        isUsingOAuth: () => true,
        getApiKeyForProvider: () => Promise.resolve(undefined),
      },
      ui: { notify, setStatus, setFooter },
      isProjectTrusted: vi.fn(() => true),
    });

    if (dependencies) betterXaiWithDependencies(pi, dependencies);
    else betterXai(pi);
    return { handlers, commands, ctx, cwd, notify, setStatus, setFooter };
  });

function stalledStartup() {
  const started = Deferred.makeUnsafe<void>();
  let interruptions = 0;
  const effect = Deferred.succeed(started, undefined).pipe(
    Effect.andThen(Effect.never),
    Effect.ensuring(Effect.sync(() => void interruptions++)),
  );
  return { effect, started, interruptions: () => interruptions };
}

const invoke = <ValueInput>(value: ValueInput): Effect.Effect<void> =>
  Effect.promise(() => Promise.resolve(value).then(() => undefined));

layer(nodeFilePlatformLayer)("Better xAI Effect boundary", (it) => {
  it.effect("contains hostile terminal-UI getters without aborting activation", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      Object.defineProperties(h.ctx, {
        mode: {
          configurable: true,
          get() {
            throw new Error("host-mode-secret");
          },
        },
        hasUI: {
          configurable: true,
          get() {
            throw new Error("host-ui-secret");
          },
        },
      });

      yield* invoke(h.handlers.get("session_start")?.({}, h.ctx));

      expect(h.notify).not.toHaveBeenCalledWith("Better xAI failed to start.", "warning");
      yield* invoke(h.commands.get("xai-usage")?.("", h.ctx));
      expect(h.notify).toHaveBeenCalledWith("Usage display is disabled.", "warning");
      yield* invoke(h.commands.get("xai-settings")?.("", h.ctx));
      expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Better xAI settings"), "info");
      yield* invoke(h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx));
    }),
  );

  it.effect("materializes session cwd and signal exactly once", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const controller = new AbortController();
      let cwdReads = 0;
      let signalReads = 0;
      Object.defineProperties(h.ctx, {
        cwd: {
          configurable: true,
          get() {
            cwdReads++;
            if (cwdReads > 1) throw new Error("host-cwd-reread-secret");
            return h.cwd;
          },
        },
        signal: {
          configurable: true,
          get() {
            signalReads++;
            if (signalReads > 1) throw new Error("host-signal-reread-secret");
            return controller.signal;
          },
        },
      });

      yield* invoke(h.handlers.get("session_start")?.({}, h.ctx));

      expect(cwdReads).toBe(1);
      expect(signalReads).toBe(1);
      expect(h.notify).not.toHaveBeenCalledWith("Better xAI failed to start.", "warning");
      yield* invoke(h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx));
    }),
  );

  it.effect("fails closed when session cwd cannot be materialized", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      Object.defineProperty(h.ctx, "cwd", {
        configurable: true,
        get() {
          throw new Error("host-cwd-secret");
        },
      });

      let startup: unknown;
      expect(() => {
        startup = h.handlers.get("session_start")?.({}, h.ctx);
      }).not.toThrow();
      yield* invoke(startup);

      expect(h.notify).toHaveBeenCalledWith("Better xAI failed to start.", "warning");
      yield* invoke(h.commands.get("xai-usage")?.("", h.ctx));
      expect(h.notify).toHaveBeenCalledWith("xAI usage is unavailable.", "warning");
    }),
  );

  it.effect("contains hostile signal getters at command and event boundaries", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* invoke(h.handlers.get("session_start")?.({}, h.ctx));
      Object.defineProperty(h.ctx, "signal", {
        configurable: true,
        get() {
          throw new Error("host-signal-secret");
        },
      });

      let usage: unknown;
      expect(() => {
        usage = h.commands.get("xai-usage")?.("", h.ctx);
      }).not.toThrow();
      yield* invoke(usage);
      expect(h.notify).toHaveBeenCalledWith("xAI usage is unavailable.", "warning");

      let settings: unknown;
      expect(() => {
        settings = h.commands.get("xai-settings")?.("usage.showResetTimes false", h.ctx);
      }).not.toThrow();
      yield* invoke(settings);
      expect(h.notify).toHaveBeenCalledWith("Better xAI settings are unavailable.", "warning");

      expect(() => h.handlers.get("turn_end")?.({}, h.ctx)).not.toThrow();
      expect(() => h.handlers.get("model_select")?.({}, h.ctx)).not.toThrow();
      yield* invoke(h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx));
    }),
  );

  it.effect("fails closed when interactive settings capability getters throw", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* invoke(h.handlers.get("session_start")?.({}, h.ctx));
      Object.defineProperty(h.ctx.ui, "custom", {
        configurable: true,
        get() {
          throw new Error("host-custom-capability-secret");
        },
      });

      let command: unknown;
      expect(() => {
        command = h.commands.get("xai-settings")?.("", h.ctx);
      }).not.toThrow();
      yield* invoke(command);

      expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Better xAI settings"), "info");
      yield* invoke(h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx));
    }),
  );

  it.effect("contains synchronous and rejected custom-surface opens", () =>
    Effect.gen(function* () {
      for (const open of [
        () => {
          throw new Error("host-custom-open-secret");
        },
        () =>
          // Deliberately hostile foreign thenable boundary fixture: the proxy fabricates a
          // rejecting `then` at lookup time without ever defining a thenable object shape.
          new Proxy(
            {},
            {
              get: (_target, property) =>
                property === "then"
                  ? (_resolve: (value: undefined) => void, reject: (error: Error) => void) => {
                      reject(new Error("host-custom-thenable-secret"));
                    }
                  : undefined,
            },
          ),
      ]) {
        const h = yield* harness();
        yield* invoke(h.handlers.get("session_start")?.({}, h.ctx));
        Object.defineProperty(h.ctx.ui, "custom", { configurable: true, value: open });

        let command: unknown;
        expect(() => {
          command = h.commands.get("xai-settings")?.("", h.ctx);
        }).not.toThrow();
        yield* invoke(command);

        expect(h.notify).toHaveBeenCalledWith("Unable to open Better xAI settings.", "warning");
        yield* invoke(h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx));
      }
    }),
  );

  it.effect("contains hostile surface factory, done, render, and input callbacks", () =>
    Effect.gen(function* () {
      initTheme(undefined, false);
      const h = yield* harness();
      yield* invoke(h.handlers.get("session_start")?.({}, h.ctx));
      let renderResult: string[] | undefined;
      const custom = (factory: TestSurfaceFactory) => {
        const surface = factory(
          {
            terminal: { rows: 24 },
            requestRender() {
              throw new Error("host-render-secret");
            },
          },
          {
            bold: (text) => text,
            fg(color, text) {
              if (color === "dim") throw new Error("host-theme-secret");
              return text;
            },
          },
          {
            matches() {
              throw new Error("host-keybinding-secret");
            },
            getKeys: () => [],
          },
          () => {
            throw new Error("host-done-secret");
          },
        );
        expect(() => {
          renderResult = surface.render?.(80);
        }).not.toThrow();
        expect(() => surface.invalidate?.()).not.toThrow();
        expect(() => surface.handleInput?.("j")).not.toThrow();
        expect(() => surface.handleInput?.("\u001b")).not.toThrow();
        return Promise.resolve(undefined);
      };
      Object.defineProperty(h.ctx.ui, "custom", { configurable: true, value: custom });

      yield* invoke(h.commands.get("xai-settings")?.("", h.ctx));

      expect(renderResult).toEqual(expect.any(Array));
      expect(h.notify).not.toHaveBeenCalledWith("Unable to open Better xAI settings.", "warning");
      yield* invoke(h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx));
    }),
  );

  it.effect("degrades a throwing settings factory to an inert surface", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* invoke(h.handlers.get("session_start")?.({}, h.ctx));
      const custom = (factory: TestSurfaceFactory) => {
        const surface = factory(
          { terminal: { rows: 24 }, requestRender: () => undefined },
          {
            bold: (text) => text,
            fg() {
              throw new Error("host-factory-secret");
            },
          },
          { matches: () => false, getKeys: () => [] },
          () => {
            throw new Error("host-done-secret");
          },
        );
        expect(() => surface.render?.(80)).not.toThrow();
        expect(() => surface.handleInput?.("j")).not.toThrow();
        return Promise.resolve(undefined);
      };
      Object.defineProperty(h.ctx.ui, "custom", { configurable: true, value: custom });

      yield* invoke(h.commands.get("xai-settings")?.("", h.ctx));

      expect(h.notify).toHaveBeenCalledWith("Unable to open Better xAI settings.", "warning");
      yield* invoke(h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx));
    }),
  );

  it.effect("replacement immediately interrupts a stalled session startup", () =>
    Effect.gen(function* () {
      const stalled = stalledStartup();
      const h = yield* harness({
        startupEffect: (generation) => (generation === 1 ? stalled.effect : Effect.void),
      });
      const first = h.handlers.get("session_start")?.({}, h.ctx);
      yield* Deferred.await(stalled.started);

      const second = h.handlers.get("session_start")?.({}, h.ctx);
      yield* invoke(Promise.all([first, second]));

      expect(stalled.interruptions()).toBe(1);
      expect(h.notify).not.toHaveBeenCalledWith("Better xAI failed to start.", "warning");
      yield* invoke(h.commands.get("xai-usage")?.("", h.ctx));
      expect(h.notify).toHaveBeenCalledWith("Usage display is disabled.", "warning");
      yield* invoke(h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx));
    }),
  );

  it.effect(
    "host abort immediately interrupts a stalled session startup and removes its listener",
    () =>
      Effect.gen(function* () {
        const stalled = stalledStartup();
        const controller = new AbortController();
        const addEventListener = vi.spyOn(controller.signal, "addEventListener");
        const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
        const h = yield* harness({ startupEffect: () => stalled.effect });
        h.ctx.signal = controller.signal;
        const startup = h.handlers.get("session_start")?.({}, h.ctx);
        yield* Deferred.await(stalled.started);
        const hostAbortListener = addEventListener.mock.calls[0]?.[1];

        controller.abort();
        yield* invoke(startup);

        expect(stalled.interruptions()).toBe(1);
        expect(hostAbortListener).toBeTypeOf("function");
        expect(removeEventListener).toHaveBeenCalledWith("abort", hostAbortListener);
        expect(h.notify).not.toHaveBeenCalledWith("Better xAI failed to start.", "warning");
      }),
  );

  it.effect("disposes and clears a runtime when startup is already aborted", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      controller.abort(new Error("already gone"));
      const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
      const h = yield* harness();
      h.ctx.signal = controller.signal;

      yield* invoke(h.handlers.get("session_start")?.({}, h.ctx));

      expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(h.notify).toHaveBeenCalledWith("Better xAI failed to start.", "warning");
      h.notify.mockImplementation(() => {
        throw new Error("host-notification-secret");
      });
      yield* invoke(h.commands.get("xai-usage")?.("", h.ctx));
      expect(h.notify).toHaveBeenCalledWith("xAI usage is unavailable.", "warning");
    }),
  );

  it.effect("shutdown immediately interrupts a stalled session startup", () =>
    Effect.gen(function* () {
      const stalled = stalledStartup();
      const h = yield* harness({ startupEffect: () => stalled.effect });
      const startup = h.handlers.get("session_start")?.({}, h.ctx);
      yield* Deferred.await(stalled.started);

      const shutdown = h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
      yield* invoke(Promise.all([startup, shutdown]));

      expect(stalled.interruptions()).toBe(1);
      expect(h.notify).not.toHaveBeenCalledWith("Better xAI failed to start.", "warning");
    }),
  );
});
