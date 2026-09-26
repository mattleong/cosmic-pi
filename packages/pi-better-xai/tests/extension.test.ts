import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { extensionApiFixture, extensionContextFixture } from "pi-cosmic-core/testing";
import {
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_HOST_QUERY,
  COSMIC_UI_HOST_STATE,
  COSMIC_UI_PROTOCOL_VERSION,
  type CosmicUiHostQuery,
} from "pi-cosmic-ui/protocol";
import { afterEach, vi } from "vitest";
import {
  registerBetterXaiApplication,
  type BetterXaiExtensionDependencies,
} from "../src/application.ts";
import betterXai from "../src/extension.ts";
import * as usageRequests from "../src/usage/request.ts";
import { usageSnapshot } from "./support/fixtures.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

const harness = (
  options: {
    readonly startupEffect?: BetterXaiExtensionDependencies["startupEffect"];
    /** Installs a Cosmic UI host-query responder reporting this footer ownership. */
    readonly cosmicUi?: { readonly active: () => boolean; readonly hidden?: string[] };
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "pi-better-xai-project-" });
    const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-better-xai-agent-" });
    const configDirectory = path.join(cwd, ".pi", "extensions");
    yield* fs.makeDirectory(configDirectory, { recursive: true });
    yield* fs.writeFileString(path.join(configDirectory, "pi-better-xai.json"), "{}\n");
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
    const { cosmicUi } = options;
    if (cosmicUi)
      vi.mocked(pi.events.emit).mockImplementation((name, data) => {
        if (name !== COSMIC_UI_HOST_QUERY) return;
        // SAFETY: The name guard narrows this payload to Cosmic UI's host-query protocol.
        (data as CosmicUiHostQuery).respond({
          active: cosmicUi.active(),
          ready: true,
          hidden: cosmicUi.hidden ?? [],
        });
      });
    const ctx = extensionContextFixture({
      cwd,
      mode: "tui",
      hasUI: true,
      model: { provider: "xai", id: "grok" },
      modelRegistry: {
        isUsingOAuth: () => true,
        getProviderAuth: () => Promise.resolve(undefined),
      },
      ui: { notify, setStatus, setFooter },
      isProjectTrusted: vi.fn(() => true),
    });

    if (options.startupEffect)
      registerBetterXaiApplication(pi, { startupEffect: options.startupEffect });
    else betterXai(pi);
    yield* Effect.addFinalizer(() =>
      invoke(handlers.get("session_shutdown")?.({ reason: "quit" }, ctx)),
    );
    return { handlers, commands, ctx, cwd, notify, setStatus, setFooter, pi };
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

/** Replaces each property with a getter that throws, as a hostile host would. */
const throwOnRead = <Target extends object>(
  target: Target,
  ...keys: Array<keyof Target & string>
) => {
  for (const key of keys)
    Object.defineProperty(target, key, {
      configurable: true,
      get() {
        throw new Error(`host-${key}-secret`);
      },
    });
};

layer(nodeFilePlatformLayer)("Better xAI Effect boundary", (it) => {
  it.effect("contains hostile terminal-UI getters without aborting activation", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      throwOnRead(h.ctx, "mode", "hasUI");

      yield* invoke(h.handlers.get("session_start")?.({}, h.ctx));

      expect(h.notify).not.toHaveBeenCalledWith(expect.any(String), "warning");
      h.notify.mockClear();
      yield* invoke(h.commands.get("xai-usage")?.("", h.ctx));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
      h.notify.mockClear();
      yield* invoke(h.commands.get("xai-settings")?.("", h.ctx));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "info");
    }),
  );

  it.effect("restores status fallback when Cosmic UI releases footer ownership", () =>
    Effect.gen(function* () {
      vi.spyOn(usageRequests, "requestXaiUsage").mockReturnValue(
        Effect.succeed({ snapshot: usageSnapshot(10, 25) }),
      );
      let active = false;
      const h = yield* harness({ cosmicUi: { active: () => active } });
      yield* invoke(h.handlers.get("session_start")?.({}, h.ctx));
      yield* invoke(h.commands.get("xai-usage")?.("", h.ctx));
      expect(h.setStatus).toHaveBeenLastCalledWith("better-xai", expect.any(String));
      const fallback = h.setStatus.mock.lastCall?.[1];
      expect(fallback).not.toBe("");
      const stateListener = vi
        .mocked(h.pi.events.on)
        .mock.calls.find(([name]) => name === COSMIC_UI_HOST_STATE)?.[1];
      const publish = (next: boolean) => {
        active = next;
        stateListener?.({ version: COSMIC_UI_PROTOCOL_VERSION, active, ready: true, hidden: [] });
      };

      publish(true);
      expect(h.setStatus).toHaveBeenLastCalledWith("better-xai", undefined);

      publish(false);
      expect(h.setStatus).toHaveBeenLastCalledWith("better-xai", fallback);
      expect(h.setFooter).not.toHaveBeenCalled();
    }),
  );

  it.effect("removes Cosmic contributions when usage is hidden", () =>
    Effect.gen(function* () {
      const h = yield* harness({ cosmicUi: { active: () => true, hidden: ["xai.usage"] } });

      yield* invoke(h.handlers.get("session_start")?.({}, h.ctx));

      expect(h.pi.events.emit).toHaveBeenCalledWith(
        COSMIC_UI_FOOTER_REMOVE,
        expect.objectContaining({ owner: "pi-better-xai", id: "xai.usage" }),
      );
      expect(h.setFooter).not.toHaveBeenCalled();
      expect(h.setStatus).not.toHaveBeenCalledWith("better-xai", expect.any(String));
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
      expect(h.notify).not.toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("fails closed when session cwd cannot be materialized", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      throwOnRead(h.ctx, "cwd");

      yield* invoke(h.handlers.get("session_start")?.({}, h.ctx));

      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
      h.notify.mockClear();
      yield* invoke(h.commands.get("xai-usage")?.("", h.ctx));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("contains hostile signal getters at command and event boundaries", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* invoke(h.handlers.get("session_start")?.({}, h.ctx));
      throwOnRead(h.ctx, "signal");

      h.notify.mockClear();
      yield* invoke(h.commands.get("xai-usage")?.("", h.ctx));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");

      h.notify.mockClear();
      yield* invoke(h.commands.get("xai-settings")?.("usage.showResetTimes false", h.ctx));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");

      expect(() => h.handlers.get("turn_end")?.({}, h.ctx)).not.toThrow();
      expect(() => h.handlers.get("model_select")?.({}, h.ctx)).not.toThrow();
    }),
  );

  it.effect("fails closed when interactive settings capability getters throw", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* invoke(h.handlers.get("session_start")?.({}, h.ctx));
      throwOnRead(h.ctx.ui, "custom");

      h.notify.mockClear();
      yield* invoke(h.commands.get("xai-settings")?.("", h.ctx));

      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "info");
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

        h.notify.mockClear();
        yield* invoke(h.commands.get("xai-settings")?.("", h.ctx));

        expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
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
        expect(() => surface.handleInput?.(String.fromCharCode(27))).not.toThrow();
        return Promise.resolve(undefined);
      };
      Object.defineProperty(h.ctx.ui, "custom", { configurable: true, value: custom });

      h.notify.mockClear();
      yield* invoke(h.commands.get("xai-settings")?.("", h.ctx));

      expect(renderResult).toEqual(expect.any(Array));
      expect(h.notify).not.toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("reports a throwing settings factory as a failed open", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* invoke(h.handlers.get("session_start")?.({}, h.ctx));
      // Pinned Pi rejects its custom Promise when the factory throws.
      const custom = (factory: TestSurfaceFactory) => {
        factory(
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
        return Promise.resolve(undefined);
      };
      Object.defineProperty(h.ctx.ui, "custom", { configurable: true, value: custom });

      h.notify.mockClear();
      yield* invoke(h.commands.get("xai-settings")?.("", h.ctx));

      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("clears provider status before replacement startup settles", () =>
    Effect.gen(function* () {
      const stalled = stalledStartup();
      let starts = 0;
      const h = yield* harness({
        startupEffect: () => (++starts === 1 ? Effect.void : stalled.effect),
      });
      yield* invoke(h.handlers.get("session_start")?.({}, h.ctx));
      h.setStatus.mockClear();

      const replacement = h.handlers.get("session_start")?.({}, h.ctx);
      yield* Deferred.await(stalled.started);

      expect(h.setStatus).toHaveBeenLastCalledWith("better-xai", undefined);
      expect(h.setFooter).not.toHaveBeenCalled();
      yield* invoke(h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx));
      yield* invoke(replacement);
    }),
  );

  it.effect("replacement immediately interrupts a stalled session startup", () =>
    Effect.gen(function* () {
      const stalled = stalledStartup();
      let starts = 0;
      const h = yield* harness({
        startupEffect: () => (++starts === 1 ? stalled.effect : Effect.void),
      });
      const first = h.handlers.get("session_start")?.({}, h.ctx);
      yield* Deferred.await(stalled.started);

      const second = h.handlers.get("session_start")?.({}, h.ctx);
      yield* invoke(Promise.all([first, second]));

      expect(stalled.interruptions()).toBe(1);
      expect(h.notify).not.toHaveBeenCalledWith(expect.any(String), "warning");
      h.notify.mockClear();
      yield* invoke(h.commands.get("xai-usage")?.("", h.ctx));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
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
        expect(h.notify).not.toHaveBeenCalledWith(expect.any(String), "warning");
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
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
      h.notify.mockClear();
      h.notify.mockImplementation(() => {
        throw new Error("host-notification-secret");
      });
      yield* invoke(h.commands.get("xai-usage")?.("", h.ctx));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
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
      expect(h.notify).not.toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );
});
