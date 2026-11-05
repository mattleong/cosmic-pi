import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { formatDuration } from "pi-cosmic-core";
import { deferredPromise } from "pi-cosmic-core/testing";
import { beforeAll, describe, vi } from "vitest";
import { makeResolvedConfig, waitUntil } from "./helpers.ts";
import { input, settingsHarnessWith, type SettingsHarnessOptions } from "./settings-harness.ts";

const settingsHarness = (options?: SettingsHarnessOptions) =>
  settingsHarnessWith(makeResolvedConfig({ configPath: "/tmp/openai-settings.json" }), options);

beforeAll(() => initTheme(undefined, false));

function renderedRow(component: Component, label: string): string | undefined {
  return Option.getOrUndefined(
    Arr.findFirst(component.render(100), (line) => Fn.pipe(line, Str.includes(label))),
  );
}

const beginRefreshWrite = Effect.gen(function* () {
  const write = deferredPromise();
  const h = settingsHarness({ updateSetting: () => write.promise });
  const { closed } = yield* h.open;
  const component = h.selectedComponent();
  component.handleInput?.(input.down);
  component.handleInput?.(input.down);
  component.handleInput?.(input.enter);
  // Enter opens the interval's choices; the next one is chosen and applied optimistically.
  component.handleInput?.(input.enter);
  component.handleInput?.(input.down);
  component.handleInput?.(input.enter);
  expect(renderedRow(component, "Refresh interval")).toContain("2m");
  return { h, write, closed, component };
});

describe("Better OpenAI settings controller", () => {
  it.effect("a delayed menu import cannot open for a retired invocation", () =>
    Effect.gen(function* () {
      const gate = deferredPromise<typeof import("../src/settings/menu.ts")>();
      const loadMenu = vi.fn(() => gate.promise);
      let generation = 1;
      const h = settingsHarness({
        loadMenu,
        captureAuthority: () => {
          const token = generation;
          return () => token === generation;
        },
      });
      const pending = h.invoke("");
      yield* waitUntil(() => loadMenu.mock.calls.length > 0);
      generation++;
      gate.resolve(yield* Effect.promise(() => import("../src/settings/menu.ts")));
      yield* Effect.promise(() => pending);
      h.surface.mount();
      expect(h.surface.editor).toBeUndefined();
      expect(h.notify).not.toHaveBeenCalled();
      const { closed } = yield* h.open;
      h.selectedComponent().handleInput?.(input.escape);
      yield* Effect.promise(() => closed);
    }),
  );

  for (const replacement of [undefined, new AbortController().signal])
    it.effect(
      `an aborted menu import stays retired when the live signal becomes ${replacement ? "another signal" : "undefined"}`,
      () =>
        Effect.gen(function* () {
          const controller = new AbortController();
          let signal: AbortSignal | undefined = controller.signal;
          const gate = deferredPromise<typeof import("../src/settings/menu.ts")>();
          const loadMenu = vi.fn(() => gate.promise);
          const h = settingsHarness({ loadMenu, signal: () => signal });
          const pending = h.invoke("");
          yield* waitUntil(() => loadMenu.mock.calls.length > 0);
          controller.abort();
          signal = replacement;
          gate.resolve(yield* Effect.promise(() => import("../src/settings/menu.ts")));
          yield* Effect.promise(() => pending);
          h.surface.mount();
          expect(h.surface.editor).toBeUndefined();
          expect(h.notify).not.toHaveBeenCalled();
        }),
    );

  it.effect("menu import failure settles with a warning instead of opening a surface", () =>
    Effect.gen(function* () {
      const h = settingsHarness({ loadMenu: () => Promise.reject(new Error("unavailable")) });
      yield* Effect.promise(() => h.invoke(""));
      h.surface.mount();
      expect(h.surface.editor).toBeUndefined();
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("closes a picker whose session was replaced instead of accepting unsaved changes", () =>
    Effect.gen(function* () {
      let generation = 1;
      const h = settingsHarness({
        captureAuthority: () => {
          const token = generation;
          return () => token === generation;
        },
      });
      const { closed } = yield* h.open;
      generation++;
      h.selectedComponent().handleInput?.(input.enter);
      yield* Effect.promise(() => closed);
      expect(h.surface.editor).toBeUndefined();
      expect(h.notify).not.toHaveBeenCalled();
    }),
  );

  it.effect("warns and rolls back a failed optimistic value after the picker has closed", () =>
    Effect.gen(function* () {
      const { h, write, closed, component } = yield* beginRefreshWrite;
      component.handleInput?.(input.escape);
      component.handleInput?.(input.escape);
      yield* Effect.promise(() => closed);
      const rendersBeforeSettlement = h.surface.renders;

      write.reject(new Error("runtime closed"));
      yield* waitUntil(() => h.surface.renders > rendersBeforeSettlement);
      expect(() => component.render(100)).not.toThrow();
      expect(renderedRow(component, "Usage")).toContain(formatDuration(60_000));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("renders redacted config as terminal-safe JSON", () =>
    Effect.gen(function* () {
      const syntheticToken = Arr.join(["sk", "private-token-123456"], "-");
      const h = settingsHarness({
        configDocument: {
          access: syntheticToken,
          message: "before\u001b]2;unsafe-title\u0007after",
          enabled: true,
        },
      });
      const { closed } = yield* h.open;
      const component = h.selectedComponent();

      for (let index = 0; index < 4; index += 1) component.handleInput?.(input.down);
      component.handleInput?.(input.enter);
      component.handleInput?.(input.down);
      component.handleInput?.(input.down);
      component.handleInput?.(input.enter);

      const rendered = Arr.join(component.render(100), "\n");
      expect(rendered).toContain("[REDACTED]");
      expect(rendered).not.toContain(syntheticToken);
      expect(rendered).not.toContain("\u001b");
      expect(rendered).not.toContain("\u0007");

      component.handleInput?.(input.escape);
      component.handleInput?.(input.escape);
      component.handleInput?.(input.escape);
      yield* Effect.promise(() => closed);
    }),
  );
});
