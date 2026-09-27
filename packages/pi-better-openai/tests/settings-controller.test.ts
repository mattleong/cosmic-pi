import {
  initTheme,
  type ExtensionAPI,
  type ExtensionUIContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { redactDiagnosticValue, formatDuration, registerExtensionCommand } from "pi-cosmic-core";
import {
  deferredPromise,
  extensionApiFixture,
  extensionContextFixture,
  opaqueFixture,
  plainTheme,
} from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { beforeAll, describe, vi } from "vitest";
import { initialFastSnapshot } from "../src/fast/controller.ts";
import { registerSettingsController } from "../src/settings/controller.ts";
import { makeResolvedConfig, waitUntil } from "./helpers.ts";

type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
type SettingsRun = Parameters<typeof registerSettingsController>[1]["run"];
type StubRunResult = Result.Result<void, Error> | Schema.Json;
type TestCustomFactory<Value> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: Value) => void,
) => Component | Promise<Component>;

beforeAll(() => initTheme(undefined, false));

function settingsHarness(
  responses: Array<() => Promise<StubRunResult>>,
  hostCustom?: ExtensionUIContext["custom"],
) {
  let command: RegisteredCommand | undefined;
  let component: Component | undefined;
  let currentConfig = makeResolvedConfig({
    configPath: "/tmp/openai-settings.json",
  });
  const requestRender = vi.fn();
  const notify = vi.fn();
  const custom: ExtensionUIContext["custom"] = <Value>(
    factory: TestCustomFactory<Value>,
  ): Promise<Value> => {
    const completion = deferredPromise<Value>();
    const created = factory(
      opaqueFixture({ requestRender }),
      plainTheme,
      opaqueFixture({ matches: () => false }),
      completion.resolve,
    );
    // SAFETY: The controller's registered custom factory returns its component synchronously.
    component = created as Component;
    return completion.promise;
  };
  const ctx = extensionContextFixture({
    cwd: "/tmp",
    mode: "tui",
    hasUI: true,
    signal: undefined,
    ui: { custom: hostCustom ?? custom, notify },
  });
  const pi = extensionApiFixture({
    registerCommand(name: string, value: RegisteredCommand) {
      if (name === "openai") command = value;
    },
  });
  const runImpl = vi.fn(() => responses.shift()?.() ?? Promise.resolve({}));
  const run: SettingsRun = <A>() =>
    runImpl().then((value) => {
      // SAFETY: The run queue supplies the result expected by the controller path under test.
      return value as A;
    });

  registerSettingsController(registerExtensionCommand(pi, { name: "openai", description: "" }), {
    config: () => currentConfig,
    updateContext: vi.fn(),
    updateFooter: vi.fn(),
    formatDebugStatus: () => "diagnostics",
    fastProjection: MutableRef.make(initialFastSnapshot()),
    resetFastRoutingTransport: vi.fn(),
    run,
  });

  const invoke = (args: string): Promise<void> => {
    if (!command) throw new Error("settings command was not registered");
    return Promise.resolve(command.handler(`settings ${args}`, ctx));
  };
  const open = Effect.gen(function* () {
    const closed = invoke("");
    yield* waitUntil(() => component !== undefined);
    return { closed };
  });
  const selectedComponent = () => {
    if (!component) throw new Error("settings component has not opened");
    return component;
  };
  const setRefreshInterval = (refreshIntervalMs: number) => {
    currentConfig = {
      ...currentConfig,
      usage: { ...currentConfig.usage, refreshIntervalMs },
    };
  };

  return { invoke, open, selectedComponent, setRefreshInterval, notify, requestRender };
}

const input = {
  down: "\u001b[B",
  enter: "\r",
  escape: "\u001b",
};

function renderedRow(component: Component, label: string): string | undefined {
  return component.render(100).find((line) => line.includes(label));
}

// Opens the usage refresh submenu and optimistically selects 120000 while its write is pending.
const beginRefreshWrite = Effect.gen(function* () {
  const write = deferredPromise<StubRunResult>();
  const h = settingsHarness([
    () => Promise.resolve({}),
    () => write.promise,
    () => Promise.resolve({}),
  ]);
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
  it.effect(
    "reconciles an optimistic submenu value from the authoritative successful projection",
    () =>
      Effect.gen(function* () {
        const { h, write, closed, component } = yield* beginRefreshWrite;

        h.setRefreshInterval(15000);
        write.resolve(Result.succeed(undefined));
        yield* waitUntil(() => renderedRow(component, "Usage refresh")?.includes("15000") === true);

        component.handleInput?.(input.escape);
        expect(renderedRow(component, "Usage")).toContain("15s");
        component.handleInput?.(input.escape);
        yield* Effect.promise(() => closed);
      }),
  );

  it.effect("warns and rolls back a failed optimistic value after the picker has closed", () =>
    Effect.gen(function* () {
      const { h, write, closed, component } = yield* beginRefreshWrite;
      component.handleInput?.(input.escape);
      component.handleInput?.(input.escape);
      yield* Effect.promise(() => closed);
      const rendersBeforeSettlement = h.requestRender.mock.calls.length;

      write.reject(new Error("runtime closed"));
      yield* waitUntil(() => h.requestRender.mock.calls.length > rendersBeforeSettlement);
      expect(() => component.render(100)).not.toThrow();
      expect(renderedRow(component, "Usage")).toContain(formatDuration(60_000));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("renders redacted config as terminal-safe JSON", () =>
    Effect.gen(function* () {
      // Assemble the synthetic credential so source snapshots do not mistake this fixture for a secret.
      const syntheticToken = ["sk", "private-token-123456"].join("-");
      const redactedConfig = redactDiagnosticValue({
        access: syntheticToken,
        message: "before\u001b]2;unsafe-title\u0007after",
        enabled: true,
      });
      const h = settingsHarness([() => Promise.resolve(redactedConfig)]);
      const { closed } = yield* h.open;
      const component = h.selectedComponent();

      for (let index = 0; index < 4; index += 1) component.handleInput?.(input.down);
      component.handleInput?.(input.enter);
      component.handleInput?.(input.down);
      component.handleInput?.(input.down);
      component.handleInput?.(input.enter);

      const rendered = component.render(100).join("\n");
      expect(rendered).toContain("Redacted config");
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

  it.effect("contains a throwing picker factory and a rejecting custom surface", () =>
    Effect.gen(function* () {
      const hostileTheme: Theme = opaqueFixture({
        ...plainTheme,
        fg: () => {
          throw new Error("host-theme-secret");
        },
      });
      for (const custom of [
        // The shared fake models pinned Pi, which rejects `custom` when its factory throws.
        fakeCustomSurfaceHost({ theme: hostileTheme }).ctx.ui.custom,
        () => Promise.reject(new Error("host-custom-secret")),
      ]) {
        const h = settingsHarness([], custom);
        yield* Effect.promise(() => h.invoke(""));
        expect(h.notify).toHaveBeenCalledExactlyOnceWith(
          expect.not.stringContaining("secret"),
          "warning",
        );
      }
    }),
  );
});
