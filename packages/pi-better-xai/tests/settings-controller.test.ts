import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { beforeAll, describe, vi } from "vitest";
import { registerExtensionCommand, type InvalidSettingError } from "pi-cosmic-core";
import {
  deferredPromise,
  extensionContextFixture,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { DEFAULT_USAGE_CONFIG, type ResolvedConfig } from "../src/config/schema.ts";
import { registerSettingsController } from "../src/settings/controller.ts";

type SettingsRun = Parameters<typeof registerSettingsController>[1]["run"];
type StubRunResult = Result.Result<void, InvalidSettingError>;

beforeAll(() => initTheme(undefined, false));

const eventually = (assertion: () => void) => Effect.promise(() => vi.waitFor(assertion));

const initialConfig = (): ResolvedConfig => ({
  configPath: "/tmp/pi-better-xai.json",
  projectConfigPath: "/tmp/pi-better-xai.json",
  globalConfigPath: "/agent/pi-better-xai.json",
  projectConfigExists: true,
  globalConfigExists: false,
  usage: DEFAULT_USAGE_CONFIG,
});

function settingsHarness(responses: Array<() => Promise<StubRunResult>>) {
  const currentConfig = initialConfig();
  let configAvailability: "available" | "throws" | "undefined" = "available";
  const notify = vi.fn();
  const host = fakeCustomSurfaceHost();
  const ctx = extensionContextFixture({
    ...host.ctx,
    cwd: "/tmp",
    signal: undefined,
    ui: { ...host.ctx.ui, notify },
  });
  const extension = recordingExtensionHost();
  const runImpl = vi.fn(() => responses.shift()?.() ?? Promise.resolve(Result.succeed(undefined)));
  const run: SettingsRun = <A>() =>
    runImpl().then((value) => {
      // SAFETY: The response queue supplies the matched settlement expected by the controller.
      return value as A;
    });

  registerSettingsController(
    registerExtensionCommand(extension.pi, { name: "xai", description: "" }),
    {
      config: () => {
        if (configAvailability === "throws") throw new Error("projection unavailable");
        return configAvailability === "available" ? currentConfig : undefined;
      },
      updateFooter: vi.fn(),
      formatDebugStatus: () => "diagnostics",
      captureAuthority: () => () => true,
      run,
    },
  );

  const open = Effect.gen(function* () {
    const closed = Promise.resolve(extension.commands.get("xai")!.handler("settings ", ctx));
    yield* eventually(() => {
      host.mount();
      expect(host.editor).toBeDefined();
    });
    return { closed };
  });
  const selectedComponent = (): Component => {
    if (!host.editor) throw new Error("settings component has not opened");
    return host.editor;
  };
  const makeConfigUnavailable = (mode: "throws" | "undefined" = "throws") => {
    configAvailability = mode;
  };

  return { makeConfigUnavailable, open, selectedComponent, notify };
}

const input = {
  enter: "\r",
  quit: "q",
};

function renderedRow(component: Component, label: string): string | undefined {
  return component.render(100).find((line) => line.includes(label));
}

// The shared picker's newest-choice latch and typed-failure rollback are proved in Cosmic UI.
describe("Better xAI settings controller", () => {
  it.effect.each(["throws", "undefined"] as const)(
    "warns and restores the pre-edit value when config %s after runtime rejection",
    (mode) =>
      Effect.gen(function* () {
        const write = deferredPromise<StubRunResult>();
        const h = settingsHarness([() => write.promise]);
        const { closed } = yield* h.open;
        const component = h.selectedComponent();
        h.notify.mockImplementation(() => {
          throw new Error("host-notification-failure");
        });

        component.handleInput?.(input.enter);
        expect(renderedRow(component, "Usage refresh")).toContain("120000");
        h.makeConfigUnavailable(mode);
        write.reject(new Error("runtime unavailable"));
        yield* eventually(() => {
          expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/available/u), "warning");
          expect(renderedRow(component, "Usage refresh")).toContain("60000");
        });

        component.handleInput?.(input.quit);
        yield* Effect.promise(() => closed);
      }),
  );
});
