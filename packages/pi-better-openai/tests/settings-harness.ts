import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { registerExtensionCommand, type JsonObject } from "pi-cosmic-core";
import { extensionContextFixture, recordingExtensionHost } from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { vi } from "vitest";
import { initialFastSnapshot } from "../src/fast/controller.ts";
import { FastModeService } from "../src/fast/service.ts";
import { registerSettingsController } from "../src/settings/controller.ts";
import { OpenAIConfigService } from "../src/config/store.ts";
import type { ResolvedConfig } from "../src/config/schema.ts";
import { waitUntil } from "./helpers.ts";

export interface SettingsHarnessOptions {
  readonly configDocument?: JsonObject;
  readonly updateSetting?: () => Promise<void>;
  readonly hostCustom?: ExtensionUIContext["custom"];
  readonly captureAuthority?: () => () => boolean;
  readonly loadMenu?: () => PromiseLike<typeof import("../src/settings/menu.ts")>;
  readonly signal?: () => AbortSignal | undefined;
  readonly diagnosticLines?: (ctx: ExtensionContext) => ReadonlyArray<string>;
}

/** `/openai settings` against fake config and fast-mode services, on a fake custom surface. */
export function settingsHarnessWith(
  initialConfig: ResolvedConfig,
  options: SettingsHarnessOptions = {},
) {
  let currentConfig = initialConfig;
  const notify = vi.fn();
  const surface = fakeCustomSurfaceHost();
  const surfaceUi = surface.ctx.ui;
  const baseContext = extensionContextFixture({
    ...surface.ctx,
    cwd: "/tmp",
    signal: undefined,
    ui: { custom: options.hostCustom ?? surfaceUi.custom.bind(surfaceUi), notify },
  });
  const ctx = {
    ...baseContext,
    get signal() {
      return options.signal?.();
    },
  };
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
      diagnosticLines: options.diagnosticLines ?? (() => ["Current model: none"]),
      fastProjection: MutableRef.make(initialFastSnapshot()),
      resetFastRoutingTransport: vi.fn(),
      run: (effect, signal) => Effect.runPromise(effect.pipe(Effect.provide(services)), { signal }),
      captureAuthority: options.captureAuthority ?? (() => () => true),
      ...(options.loadMenu && { loadMenu: options.loadMenu }),
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

export const input = {
  up: "\u001b[A",
  down: "\u001b[B",
  enter: "\r",
  escape: "\u001b",
};
