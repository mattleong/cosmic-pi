import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { expect, layer } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import {
  extensionContextFixture,
  failingTheme,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import {
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_HOST_QUERY,
  COSMIC_UI_HOST_STATE,
  COSMIC_UI_PROTOCOL_VERSION,
  type CosmicUiHostQuery,
} from "pi-cosmic-ui/protocol";
import { afterEach, vi } from "vitest";
import { registerBetterXaiApplication } from "../src/application.ts";
import * as usageRequests from "../src/usage/request.ts";
import * as configStore from "../src/config/store.ts";
import { usageSnapshot } from "./support/fixtures.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Pi's custom-surface factory, called here with partial hostile tui/theme/keybindings/done. */
type TestSurfaceFactory = (...host: unknown[]) => Component;

const harness = (
  options: {
    readonly startupEffect?: Parameters<typeof registerBetterXaiApplication>[1];
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

    const notify = vi.fn();
    const setStatus = vi.fn();
    const setFooter = vi.fn();
    const host = recordingExtensionHost({}, { events: { emit: vi.fn(), on: vi.fn() } });
    const { pi } = host;
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

    registerBetterXaiApplication(pi, options.startupEffect);
    yield* Effect.addFinalizer(() =>
      invoke(host.emit("session_shutdown", ctx, { reason: "quit" })),
    );
    const command = (args: string) => host.commands.get("xai")?.handler(args, ctx);
    return { emit: host.emit, command, ctx, cwd, notify, setStatus, setFooter, pi };
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
  for (const ending of ["shutdown", "failed replacement"] as const) {
    it.effect(
      `${ending} revokes an admitted settings commit without resurrection or stale notifications`,
      () =>
        Effect.gen(function* () {
          let starts = 0;
          const h = yield* harness({
            startupEffect: () =>
              ++starts === 1 ? Effect.void : Effect.die("replacement unavailable"),
          });
          const committed = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const modify = configStore.modifyConfig;
          const gatedModify: typeof modify = (path, update) =>
            modify(path, (raw) => {
              const modification = update(raw);
              return {
                ...modification,
                afterCommit: Deferred.succeed(committed, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(modification.afterCommit ?? Effect.void),
                ),
              };
            });
          vi.spyOn(configStore, "modifyConfig").mockImplementation(gatedModify);
          yield* invoke(h.emit("session_start", h.ctx, {}));
          const pending = h.command("settings usage.showResetTimes false");
          yield* Deferred.await(committed);
          h.notify.mockClear();
          const removal =
            ending === "shutdown"
              ? h.emit("session_shutdown", h.ctx, { reason: "quit" })
              : h.emit("session_start", { ...h.ctx }, {});
          yield* Deferred.succeed(release, undefined);
          yield* invoke(pending);
          yield* invoke(removal);
          if (ending === "shutdown") expect(h.notify).not.toHaveBeenCalled();
          else expect(h.notify).toHaveBeenCalledOnce(); // Only the current startup failure.
          h.setStatus.mockClear();
          h.emit("turn_end", h.ctx, {});
          yield* Effect.yieldNow;
          expect(h.setStatus).not.toHaveBeenCalled();
        }),
    );
  }

  it.effect("an interrupted usage command cannot warn after session retirement", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      vi.spyOn(usageRequests, "requestXaiUsage").mockReturnValue(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const h = yield* harness();
      yield* invoke(h.emit("session_start", h.ctx, {}));
      const pending = h.command("usage");
      yield* Deferred.await(started);
      h.notify.mockClear();
      const shutdown = h.emit("session_shutdown", h.ctx, { reason: "quit" });
      yield* invoke(pending);
      yield* invoke(shutdown);
      expect(h.notify).not.toHaveBeenCalled();
    }),
  );

  it.effect("contains hostile terminal-UI getters without aborting activation", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      throwOnRead(h.ctx, "mode", "hasUI");

      yield* invoke(h.emit("session_start", h.ctx, {}));

      expect(h.notify).not.toHaveBeenCalledWith(expect.any(String), "warning");
      h.notify.mockClear();
      yield* invoke(h.command("usage"));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
      h.notify.mockClear();
      yield* invoke(h.command("settings"));
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
      yield* invoke(h.emit("session_start", h.ctx, {}));
      yield* invoke(h.command("usage"));
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

      yield* invoke(h.emit("session_start", h.ctx, {}));

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

      yield* invoke(h.emit("session_start", h.ctx, {}));

      expect(cwdReads).toBe(1);
      expect(signalReads).toBe(1);
      expect(h.notify).not.toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("fails closed when session cwd cannot be materialized", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      throwOnRead(h.ctx, "cwd");

      yield* invoke(h.emit("session_start", h.ctx, {}));

      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
      h.notify.mockClear();
      yield* invoke(h.command("usage"));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("contains hostile signal and model getters at command and event boundaries", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* invoke(h.emit("session_start", h.ctx, {}));
      throwOnRead(h.ctx, "signal", "model");

      h.notify.mockClear();
      yield* invoke(h.command("usage"));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");

      h.notify.mockClear();
      yield* invoke(h.command("settings usage.showResetTimes false"));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");

      // The status report reads the model through the host guard, so it still reports.
      h.notify.mockClear();
      yield* invoke(h.command("settings status"));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "info");

      expect(() => h.emit("turn_end", h.ctx, {})).not.toThrow();
      expect(() => h.emit("model_select", h.ctx, {})).not.toThrow();

      // A readable model whose own fields throw is contained the same way.
      const model = { provider: "xai", id: "grok" };
      throwOnRead(model, "provider", "id");
      Object.defineProperty(h.ctx, "model", { configurable: true, value: model });
      h.notify.mockClear();
      yield* invoke(h.command("settings status"));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "info");
      expect(() => h.emit("model_select", h.ctx, {})).not.toThrow();
    }),
  );

  it.effect("reports synchronous, rejected, and factory-failed custom-surface opens", () =>
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
        // Pinned Pi rejects its custom Promise when the factory throws.
        (factory: TestSurfaceFactory) => {
          factory(
            { terminal: { rows: 24 }, requestRender: () => undefined },
            failingTheme({ message: "host-factory-secret" }),
            { matches: () => false, getKeys: () => [] },
            () => {
              throw new Error("host-done-secret");
            },
          );
          return Promise.resolve(undefined);
        },
      ]) {
        const h = yield* harness();
        yield* invoke(h.emit("session_start", h.ctx, {}));
        Object.defineProperty(h.ctx.ui, "custom", { configurable: true, value: open });

        h.notify.mockClear();
        yield* invoke(h.command("settings"));

        expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
        yield* invoke(h.emit("session_shutdown", h.ctx, { reason: "quit" }));
      }
    }),
  );

  it.effect("contains hostile surface factory, done, render, and input callbacks", () =>
    Effect.gen(function* () {
      initTheme(undefined, false);
      const h = yield* harness();
      yield* invoke(h.emit("session_start", h.ctx, {}));
      let renderResult: string[] | undefined;
      const custom = (factory: TestSurfaceFactory) => {
        const surface = factory(
          {
            terminal: { rows: 24 },
            requestRender() {
              throw new Error("host-render-secret");
            },
          },
          failingTheme({ message: "host-theme-secret", when: (token) => token === "dim" }),
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
          renderResult = surface.render(80);
        }).not.toThrow();
        expect(() => surface.invalidate()).not.toThrow();
        expect(() => surface.handleInput?.("j")).not.toThrow();
        expect(() => surface.handleInput?.(String.fromCharCode(27))).not.toThrow();
        return Promise.resolve(undefined);
      };
      Object.defineProperty(h.ctx.ui, "custom", { configurable: true, value: custom });

      h.notify.mockClear();
      yield* invoke(h.command("settings"));

      expect(renderResult).toEqual(expect.any(Array));
      expect(h.notify).not.toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("clears provider status on replacement and silently supersedes a stalled start", () =>
    Effect.gen(function* () {
      const stalled = stalledStartup();
      let starts = 0;
      const h = yield* harness({
        startupEffect: () => (++starts === 2 ? stalled.effect : Effect.void),
      });
      yield* invoke(h.emit("session_start", h.ctx, {}));
      h.setStatus.mockClear();
      h.notify.mockClear();

      const replacement = h.emit("session_start", h.ctx, {});
      yield* Deferred.await(stalled.started);

      expect(h.setStatus).toHaveBeenLastCalledWith("better-xai", undefined);
      expect(h.setFooter).not.toHaveBeenCalled();

      yield* invoke(Promise.all([replacement, h.emit("session_start", h.ctx, {})]));
      expect(stalled.interruptions()).toBe(1);
      expect(h.notify).not.toHaveBeenCalledWith(expect.any(String), "warning");
      yield* invoke(h.command("usage"));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("disposes and clears a runtime when startup is already aborted", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      controller.abort(new Error("already gone"));
      const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
      const h = yield* harness();
      h.ctx.signal = controller.signal;

      yield* invoke(h.emit("session_start", h.ctx, {}));

      expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
      h.notify.mockClear();
      yield* invoke(h.command("usage"));
      expect(h.notify).not.toHaveBeenCalled();
    }),
  );
});
