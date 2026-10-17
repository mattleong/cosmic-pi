import { initTheme, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import {
  deferredPromise,
  extensionApiFixture,
  extensionContextFixture,
  macrotask,
  yieldUntil,
} from "pi-cosmic-core/testing";
import {
  defaultResolvedCosmicUiConfig,
  type ResolvedCosmicUiConfig,
} from "../src/config/schema.ts";
import type { CosmicUiService } from "../src/protocol/service.ts";
import { registerSettingsCommand } from "../src/settings/controller.ts";
import { fakeCustomSurfaceHost } from "../src/testing/custom-surface.ts";

function settingsHarness() {
  initTheme();
  setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS));
  let command: RegisteredCommand["handler"] | undefined;
  let config = defaultResolvedCosmicUiConfig();
  const updates: Array<Deferred.Deferred<void, Error>> = [];
  const notify = vi.fn();
  const afterApply = vi.fn();
  let current = true;
  const host = fakeCustomSurfaceHost();
  const mounted = deferredPromise();
  const ctx = extensionContextFixture({
    mode: "tui" as const,
    signal: new AbortController().signal,
    ui: {
      custom: (factory, options) => {
        const opened = host.custom(factory, options);
        host.mount();
        mounted.resolve();
        return opened;
      },
      notify,
    },
  });
  const pi = extensionApiFixture({
    registerCommand(_name: string, definition: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      command = definition.handler;
    },
  });
  registerSettingsCommand(pi, {
    config: () => config,
    updateContext: () => undefined,
    update: afterApply,
    captureAuthority: () => () => current,
    run: <E>(_effect: Effect.Effect<void, E, CosmicUiService>, _signal?: AbortSignal) => {
      const update = Deferred.makeUnsafe<void, Error>();
      updates.push(update);
      return Effect.runPromise(Deferred.await(update));
    },
  });
  const input = (data = "\r") => {
    if (!host.editor?.handleInput) throw new Error("Settings surface was not opened.");
    host.editor.handleInput(data);
  };
  return {
    host,
    input,
    notify,
    afterApply,
    updates,
    mounted: () => mounted.promise,
    started: (count: number) => yieldUntil(() => updates.length >= count).pipe(Effect.orDie),
    open: () => {
      if (!command) throw new Error("Settings command was not registered.");
      return command("settings", ctx);
    },
    close: () => input("\u001b"),
    line: (label: string) =>
      host.editor
        ?.render(100)
        .filter((line) => line.includes(label))
        .join("\n") ?? "",
    retire: () => {
      current = false;
    },
    setFooter: (footer: Partial<ResolvedCosmicUiConfig["footer"]>) => {
      config = { ...config, footer: { ...config.footer, ...footer } };
    },
  };
}

const withSettings = <A, E>(body: (h: ReturnType<typeof settingsHarness>) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const h = settingsHarness();
    const opened = h.open();
    yield* Effect.promise(h.mounted);
    yield* body(h);
    h.close();
    yield* Effect.promise(() => opened);
  });

describe("Cosmic UI settings controller", () => {
  for (const outcome of ["success", "failure"] as const) {
    it.effect(`retired picker ${outcome} cannot notify, repaint or run afterApply`, () =>
      withSettings((h) =>
        Effect.gen(function* () {
          h.input();
          yield* h.started(1);
          h.notify.mockClear();
          const renders = h.host.renders;
          h.afterApply.mockClear();
          h.retire();
          if (outcome === "success") yield* Deferred.succeed(h.updates[0]!, undefined);
          else yield* Deferred.fail(h.updates[0]!, new Error("unavailable"));
          yield* macrotask;
          expect(h.notify).not.toHaveBeenCalled();
          expect(h.host.renders).toBe(renders);
          expect(h.afterApply).not.toHaveBeenCalled();
        }),
      ),
    );
  }

  it.effect("ignores stale success and failure settlements for a newer optimistic edit", () =>
    withSettings((h) =>
      Effect.gen(function* () {
        h.input();
        expect(h.line("Custom footer")).toContain("false");
        h.input();
        expect(h.line("Custom footer")).toContain("true");
        yield* h.started(1);
        expect(h.updates).toHaveLength(1);

        h.setFooter({ enabled: false });
        yield* Deferred.succeed(h.updates[0]!, undefined);
        yield* h.started(2);
        expect(h.line("Custom footer")).toContain("true");

        h.input();
        expect(h.line("Custom footer")).toContain("false");
        expect(h.updates).toHaveLength(2);
        h.setFooter({ enabled: true });
        yield* Deferred.fail(h.updates[1]!, new Error("stale failure"));
        yield* h.started(3);
        expect(h.line("Custom footer")).toContain("false");
        expect(h.notify).not.toHaveBeenCalled();

        h.setFooter({ enabled: false });
        yield* Deferred.succeed(h.updates[2]!, undefined);
        yield* macrotask;
        expect(h.line("Custom footer")).toContain("false");
      }),
    ),
  );

  it.effect("keeps generations independent across setting rows and rolls failures back", () =>
    withSettings((h) =>
      Effect.gen(function* () {
        h.input();
        expect(h.line("Custom footer")).toContain("false");
        h.input("j");
        h.input();
        expect(h.line("Footer density")).toContain("comfortable");
        yield* h.started(1);
        expect(h.updates).toHaveLength(1);

        h.setFooter({ enabled: true });
        const renders = h.host.renders;
        yield* Deferred.fail(h.updates[0]!, new Error("enabled failure"));
        yield* h.started(2);
        expect(h.line("Custom footer")).toContain("true");
        expect(h.notify).toHaveBeenCalledExactlyOnceWith(expect.any(String), "error");
        expect(h.host.renders).toBeGreaterThan(renders);

        h.setFooter({ density: "comfortable" });
        yield* Deferred.succeed(h.updates[1]!, undefined);
        yield* macrotask;
      }),
    ),
  );
});
