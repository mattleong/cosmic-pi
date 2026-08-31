import {
  initTheme,
  type KeybindingsManager,
  type RegisteredCommand,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import { makeDefaultResolvedCosmicUiConfig } from "../src/config/schema.ts";
import type { CosmicUiService } from "../src/protocol/service.ts";
import { registerSettingsCommand } from "../src/settings/controller.ts";
import { extensionApiFixture, extensionContextFixture } from "./support/host.ts";

const flushSettlements = Effect.promise(() => Promise.resolve()).pipe(
  Effect.andThen(Effect.promise(() => Promise.resolve())),
);

const opaqueHostFixture = <Value>(value: Value): never => {
  // SAFETY: These tests supply every opaque host member exercised by the settings controller.
  return value as never;
};

function settingsHarness() {
  initTheme();
  setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS));
  let command: RegisteredCommand["handler"] | undefined;
  let surface: Component | undefined;
  let config = makeDefaultResolvedCosmicUiConfig();
  const updates: Array<Deferred.Deferred<unknown, Error>> = [];
  const modal = Deferred.makeUnsafe<unknown>();
  const notify = vi.fn();
  const requestRender = vi.fn();
  const tui: TUI = opaqueHostFixture({ requestRender });
  const theme: Theme = opaqueHostFixture({
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  });
  const keybindings: KeybindingsManager = opaqueHostFixture({ matches: () => false });
  const custom = <T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void,
    ) => Component | Promise<Component>,
  ): Promise<T> => {
    const created = factory(tui, theme, keybindings, (result) => {
      Effect.runSync(Deferred.succeed(modal, result));
    });
    if (created instanceof Promise) throw new Error("Expected a synchronous settings surface.");
    surface = created;
    // SAFETY: The modal Deferred receives only values supplied to the generic done callback.
    return Effect.runPromise(Deferred.await(modal)) as Promise<T>;
  };
  const ctx = extensionContextFixture({
    mode: "tui" as const,
    signal: new AbortController().signal,
    ui: { custom, notify },
  });
  const pi = extensionApiFixture({
    registerCommand(_name: string, definition: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      command = definition.handler;
    },
  });
  registerSettingsCommand(pi, {
    config: () => config,
    updateContext: () => undefined,
    update: () => undefined,
    run: <A, E>(
      _effect: Effect.Effect<A, E, CosmicUiService>,
      _signal?: AbortSignal,
    ): Promise<A> => {
      const update = Deferred.makeUnsafe<unknown, Error>();
      updates.push(update);
      // SAFETY: Each test settles this Deferred with the successful update result type.
      return Effect.runPromise(Deferred.await(update)) as Promise<A>;
    },
    callbacks: makeHostCallbackBoundary(),
  });
  const open = () => {
    if (!command) throw new Error("Settings command was not registered.");
    return command("", ctx);
  };
  const input = (data = "\r") => {
    if (!surface?.handleInput) throw new Error("Settings surface was not opened.");
    surface.handleInput(data);
  };
  const enabledLine = () =>
    surface?.render(100).find((line) => line.includes("Footer enabled")) ?? "";
  const densityLine = () =>
    surface?.render(100).find((line) => line.includes("Footer density")) ?? "";
  const setEnabled = (enabled: boolean) => {
    config = { ...config, footer: { ...config.footer, enabled } };
  };
  const setDensity = (density: "auto" | "comfortable" | "compact") => {
    config = { ...config, footer: { ...config.footer, density } };
  };
  const close = () => Effect.runSync(Deferred.succeed(modal, undefined));
  return {
    close,
    densityLine,
    enabledLine,
    input,
    notify,
    open,
    requestRender,
    setDensity,
    setEnabled,
    updates,
  };
}

describe("Cosmic UI settings controller", () => {
  it.effect("ignores stale success and failure settlements for a newer optimistic edit", () => {
    const h = settingsHarness();
    return Effect.gen(function* () {
      const opened = h.open();
      h.input();
      expect(h.enabledLine()).toContain("false");
      h.input();
      expect(h.enabledLine()).toContain("true");
      expect(h.updates).toHaveLength(2);

      h.setEnabled(false);
      yield* Deferred.succeed(h.updates[0]!, undefined);
      yield* flushSettlements;
      expect(h.enabledLine()).toContain("true");

      h.input();
      expect(h.enabledLine()).toContain("false");
      expect(h.updates).toHaveLength(3);
      h.setEnabled(true);
      yield* Deferred.fail(h.updates[1]!, new Error("stale failure"));
      yield* flushSettlements;
      expect(h.enabledLine()).toContain("false");
      expect(h.notify).not.toHaveBeenCalled();

      h.setEnabled(false);
      yield* Deferred.succeed(h.updates[2]!, undefined);
      yield* flushSettlements;
      expect(h.enabledLine()).toContain("false");
      h.close();
      yield* Effect.promise(() => opened);
    });
  });

  it.effect("keeps generations independent across setting rows", () => {
    const h = settingsHarness();
    return Effect.gen(function* () {
      const opened = h.open();
      h.input();
      expect(h.enabledLine()).toContain("false");
      h.input("j");
      h.input();
      expect(h.densityLine()).toContain("comfortable");
      expect(h.updates).toHaveLength(2);

      h.setEnabled(true);
      yield* Deferred.fail(h.updates[0]!, new Error("enabled failure"));
      yield* flushSettlements;
      expect(h.enabledLine()).toContain("true");
      expect(h.notify).toHaveBeenCalledOnce();

      h.setDensity("comfortable");
      yield* Deferred.succeed(h.updates[1]!, undefined);
      yield* flushSettlements;
      h.close();
      yield* Effect.promise(() => opened);
    });
  });

  it.effect("settles current updates from the latest projection and rolls failures back", () => {
    const h = settingsHarness();
    return Effect.gen(function* () {
      const opened = h.open();
      h.input();
      expect(h.enabledLine()).toContain("false");
      h.setEnabled(true);
      yield* Deferred.succeed(h.updates[0]!, undefined);
      yield* flushSettlements;
      expect(h.enabledLine()).toContain("true");

      h.input();
      expect(h.enabledLine()).toContain("false");
      h.setEnabled(true);
      yield* Deferred.fail(h.updates[1]!, new Error("current failure"));
      yield* flushSettlements;
      expect(h.enabledLine()).toContain("true");
      expect(h.notify).toHaveBeenCalledOnce();
      expect(h.notify).toHaveBeenCalledWith("Unable to update Cosmic UI configuration.", "error");
      expect(h.requestRender).toHaveBeenCalled();
      h.close();
      yield* Effect.promise(() => opened);
    });
  });
});
