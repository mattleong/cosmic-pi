import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { formatDuration } from "pi-cosmic-core";
import { findOrUndefined } from "pi-cosmic-core/array";
import { deferredPromise } from "pi-cosmic-core/testing";
import { beforeAll, describe, vi } from "vitest";
import { makeResolvedConfig, waitUntil } from "./helpers.ts";
import { input, settingsHarnessWith, type SettingsHarnessOptions } from "./settings-harness.ts";

const settingsHarness = (options?: SettingsHarnessOptions) =>
  settingsHarnessWith(makeResolvedConfig({ configPath: "/tmp/openai-settings.json" }), options);

beforeAll(() => initTheme(undefined, false));

function renderedRow(component: Component, label: string): string | undefined {
  return findOrUndefined(component.render(100), (line) => Fn.pipe(line, Str.includes(label)));
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
  expect(renderedRow(component, "Usage refresh")).toContain("2m");
  return { h, write, closed, component };
});

interface LiveInvocation {
  generation: number;
  signal: AbortSignal | undefined;
  readonly controller: AbortController;
}

/** Each way the host retires an invocation while its menu import is still pending. */
const retirements: ReadonlyArray<readonly [string, (live: LiveInvocation) => void]> = [
  [
    "its session is replaced",
    (live) => {
      live.generation++;
    },
  ],
  [
    "its signal aborts and the live signal becomes undefined",
    (live) => {
      live.controller.abort();
      live.signal = undefined;
    },
  ],
  [
    "its signal aborts and the live signal becomes another signal",
    (live) => {
      live.controller.abort();
      live.signal = new AbortController().signal;
    },
  ],
];

describe("Better OpenAI settings controller", () => {
  for (const [reason, retire] of retirements)
    it.effect(`a delayed menu import cannot open after ${reason}`, () =>
      Effect.gen(function* () {
        const gate = deferredPromise<typeof import("../src/settings/menu.ts")>();
        const loadMenu = vi.fn(() => gate.promise);
        const controller = new AbortController();
        const live: LiveInvocation = { generation: 1, signal: controller.signal, controller };
        const h = settingsHarness({
          loadMenu,
          captureAuthority: () => {
            const token = live.generation;
            return () => token === live.generation;
          },
          signal: () => live.signal,
        });
        const pending = h.invoke("");
        yield* waitUntil(() => loadMenu.mock.calls.length > 0);
        retire(live);
        gate.resolve(yield* Effect.promise(() => import("../src/settings/menu.ts")));
        yield* Effect.promise(() => pending);
        h.surface.mount();
        expect(h.surface.editor).toBeUndefined();
        expect(h.notify).not.toHaveBeenCalled();
        // A fresh invocation still opens.
        const { closed } = yield* h.open;
        h.selectedComponent().handleInput?.(input.escape);
        yield* Effect.promise(() => closed);
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

  it.effect("saves OpenAI compaction from its top-level row and restores it when that fails", () =>
    Effect.gen(function* () {
      const write = deferredPromise();
      const updateSetting = vi.fn(() => write.promise);
      const h = settingsHarness({ updateSetting });
      const { closed } = yield* h.open;
      const component = h.selectedComponent();
      component.handleInput?.(input.down);
      component.handleInput?.(input.enter);
      expect(renderedRow(component, "OpenAI compaction")).toContain("on");
      // The save runs once the change is admitted, so it starts after the row shows the new value.
      yield* waitUntil(() => updateSetting.mock.calls.length > 0);

      write.reject(new Error("disk full"));
      yield* waitUntil(
        () => !Fn.pipe(renderedRow(component, "OpenAI compaction") ?? "", Str.includes(" on")),
      );
      expect(renderedRow(component, "OpenAI compaction")).toContain("off");
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
      component.handleInput?.(input.escape);
      yield* Effect.promise(() => closed);
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

  it.effect("status names every setting with its value and includes the diagnostics", () =>
    Effect.gen(function* () {
      const h = settingsHarness({ diagnosticLines: () => ["Current model: openai/gpt-5.5"] });
      yield* Effect.promise(() => h.invoke("status"));
      const text: unknown = h.notify.mock.lastCall?.[0];
      const level: unknown = h.notify.mock.lastCall?.[1];
      expect(level).toBe("info");
      const shown = Str.split(Predicate.isString(text) ? text : "", "\n");
      for (const id of ["fast.enabled", "image.enabled", "usage.refreshIntervalMs"])
        expect(Arr.some(shown, (line) => Fn.pipe(line, Str.includes(`(${id})`)))).toBe(true);
      expect(shown).toContain("Current model: openai/gpt-5.5");
    }),
  );
});
