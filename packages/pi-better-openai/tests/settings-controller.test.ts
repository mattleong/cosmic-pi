import { initTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { formatDuration, registerExtensionCommand, type JsonObject } from "pi-cosmic-core";
import {
  deferredPromise,
  extensionContextFixture,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { beforeAll, describe, vi } from "vitest";
import { initialFastSnapshot } from "../src/fast/controller.ts";
import { FastModeService } from "../src/fast/service.ts";
import { registerSettingsController } from "../src/settings/controller.ts";
import { OpenAIConfigService } from "../src/config/store.ts";
import { makeResolvedConfig, waitUntil } from "./helpers.ts";

beforeAll(() => initTheme(undefined, false));

interface SettingsHarnessOptions {
  readonly configDocument?: JsonObject;
  readonly updateSetting?: () => Promise<void>;
  readonly hostCustom?: ExtensionUIContext["custom"];
  readonly captureAuthority?: () => () => boolean;
}

function settingsHarness(options: SettingsHarnessOptions = {}) {
  let currentConfig = makeResolvedConfig({
    configPath: "/tmp/openai-settings.json",
  });
  const notify = vi.fn();
  const surface = fakeCustomSurfaceHost();
  const surfaceUi = surface.ctx.ui;
  const ctx = extensionContextFixture({
    ...surface.ctx,
    cwd: "/tmp",
    signal: undefined,
    ui: { custom: options.hostCustom ?? surfaceUi.custom.bind(surfaceUi), notify },
  });
  const host = recordingExtensionHost();
  const services = Layer.mergeAll(
    Layer.succeed(OpenAIConfigService, {
      get: Effect.sync(() => currentConfig),
      observe: () => Effect.void,
      updateSetting: () =>
        options.updateSetting ? Effect.promise(options.updateSetting) : Effect.void,
      persistFast: (_desiredActive, afterCommit) => afterCommit,
      readConfigDocument: Effect.sync(() => options.configDocument ?? {}),
    }),
    Layer.succeed(FastModeService, {
      recordInjection: () => undefined,
      initialize: () => Effect.void,
      setDesired: () => Effect.void,
      modelChanged: () => Effect.void,
    }),
  );

  registerSettingsController(
    registerExtensionCommand(host.pi, { name: "openai", description: "" }),
    {
      config: () => currentConfig,
      updateContext: vi.fn(),
      updateFooter: vi.fn(),
      formatDebugStatus: () => "diagnostics",
      fastProjection: MutableRef.make(initialFastSnapshot()),
      resetFastRoutingTransport: vi.fn(),
      run: (effect, signal) => Effect.runPromise(effect.pipe(Effect.provide(services)), { signal }),
      captureAuthority: options.captureAuthority ?? (() => () => true),
    },
  );

  const invoke = (args: string) =>
    Promise.resolve(host.commands.get("openai")!.handler(`settings ${args}`, ctx));
  const open = Effect.gen(function* () {
    const closed = invoke("");
    yield* waitUntil(() => {
      surface.mount();
      return surface.editor !== undefined;
    });
    return { closed };
  });
  const selectedComponent = () => {
    if (!surface.editor) throw new Error("settings component has not opened");
    return surface.editor;
  };
  const setRefreshInterval = (refreshIntervalMs: number) => {
    currentConfig = {
      ...currentConfig,
      usage: { ...currentConfig.usage, refreshIntervalMs },
    };
  };

  return { invoke, open, selectedComponent, setRefreshInterval, notify, surface };
}

const input = {
  down: "\u001b[B",
  enter: "\r",
  escape: "\u001b",
};

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
  component.handleInput?.(input.enter);
  expect(renderedRow(component, "Usage refresh")).toContain("120000");
  return { h, write, closed, component };
});

describe("Better OpenAI settings controller", () => {
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
