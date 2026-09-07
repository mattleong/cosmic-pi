import {
  initTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { beforeAll, describe, vi } from "vitest";
import { InvalidSettingError } from "pi-cosmic-core";
import type { ResolvedConfig } from "../src/config/schema.ts";
import { registerSettingsController } from "../src/settings/controller.ts";

type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
type SettingsRun = Parameters<typeof registerSettingsController>[1]["run"];
type StubRunResult = Result.Result<void, InvalidSettingError>;
type TestCustomFactory<Value> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: Value) => void,
) => Component | Promise<Component>;

beforeAll(() => initTheme(undefined, false));

function testDouble<Value>(value: Partial<Value>): Value {
  // SAFETY: Each call builds an owned test double for the named host contract.
  return value as Value;
}

function deferred<Value>() {
  const handle = Deferred.makeUnsafe<Value, Error>();
  return {
    promise: Effect.runPromise(Deferred.await(handle)),
    resolve: (value: Value) => {
      Effect.runSync(Deferred.succeed(handle, value));
    },
    reject: (error: Error) => {
      Effect.runSync(Deferred.fail(handle, error));
    },
  };
}

const initialConfig = (): ResolvedConfig => ({
  configPath: "/tmp/pi-better-xai.json",
  projectConfigPath: "/tmp/pi-better-xai.json",
  globalConfigPath: "/agent/pi-better-xai.json",
  projectConfigExists: true,
  globalConfigExists: false,
  usage: {
    refreshIntervalMs: 60_000,
    showOnlyOnSubscriptionModels: true,
    showResetTimes: true,
  },
});

function settingsHarness(responses: Array<() => Promise<StubRunResult>>) {
  let command: RegisteredCommand | undefined;
  let component: Component | undefined;
  let currentConfig = initialConfig();
  let configAvailability: "available" | "throws" | "undefined" = "available";
  const requestRender = vi.fn();
  const updateFooter = vi.fn();
  const notify = vi.fn();
  const custom: ExtensionUIContext["custom"] = <Value>(
    factory: TestCustomFactory<Value>,
  ): Promise<Value> => {
    const completion = Deferred.makeUnsafe<Value>();
    const created = factory(
      testDouble<TUI>({ requestRender }),
      testDouble<Theme>({
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      }),
      testDouble<KeybindingsManager>({ matches: () => false }),
      (value) => {
        Effect.runSync(Deferred.succeed(completion, value));
      },
    );
    // SAFETY: The controller's custom factory returns its component synchronously.
    component = created as Component;
    return Effect.runPromise(Deferred.await(completion));
  };
  const ui = testDouble<ExtensionUIContext>({ custom, notify });
  const ctx = testDouble<ExtensionCommandContext>({
    cwd: "/tmp",
    mode: "tui",
    hasUI: true,
    signal: undefined,
    ui,
  });
  const pi = testDouble<ExtensionAPI>({
    registerCommand(name: string, value: RegisteredCommand) {
      if (name === "xai-settings") command = value;
    },
  });
  const runImpl = vi.fn(() => responses.shift()?.() ?? Promise.resolve(Result.succeed(undefined)));
  const run: SettingsRun = <A>() =>
    runImpl().then((value) => {
      // SAFETY: The response queue supplies the matched settlement expected by the controller.
      return value as A;
    });

  registerSettingsController(pi, {
    config: () => {
      if (configAvailability === "throws") throw new Error("projection unavailable");
      return configAvailability === "available" ? currentConfig : undefined;
    },
    updateFooter,
    formatDebugStatus: () => "diagnostics",
    captureSignal: () => ({ _tag: "Captured", signal: undefined }),
    run,
  });

  const invoke = (args: string): Promise<void> => {
    if (!command) throw new Error("settings command was not registered");
    return Promise.resolve(command.handler(args, ctx));
  };
  const open = Effect.gen(function* () {
    const closed = invoke("");
    yield* Effect.promise(() =>
      vi.waitFor(() => {
        expect(component).toBeDefined();
      }),
    );
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
  const makeConfigUnavailable = (mode: "throws" | "undefined" = "throws") => {
    configAvailability = mode;
  };

  return {
    invoke,
    makeConfigUnavailable,
    open,
    selectedComponent,
    setRefreshInterval,
    notify,
    requestRender,
    updateFooter,
  };
}

const input = {
  enter: "\r",
  quit: "q",
};

function renderedRow(component: Component, label: string): string | undefined {
  return component.render(100).find((line) => line.includes(label));
}

describe("Better xAI settings controller", () => {
  it.effect("keeps a newer optimistic value when an older apply settles", () =>
    Effect.gen(function* () {
      const first = deferred<StubRunResult>();
      const second = deferred<StubRunResult>();
      const h = settingsHarness([() => first.promise, () => second.promise]);
      const { closed } = yield* h.open;
      const component = h.selectedComponent();

      component.handleInput?.(input.enter);
      expect(renderedRow(component, "Usage refresh")).toContain("120000");
      component.handleInput?.(input.enter);
      expect(renderedRow(component, "Usage refresh")).toContain("300000");

      h.setRefreshInterval(120000);
      first.resolve(Result.succeed(undefined));
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(h.updateFooter).toHaveBeenCalledOnce();
        }),
      );
      expect(renderedRow(component, "Usage refresh")).toContain("300000");

      h.notify.mockImplementation((message: string) => {
        if (message === "Invalid value for usage.refreshIntervalMs.")
          throw new Error("host-notification-failure");
      });
      second.resolve(
        Result.fail(
          new InvalidSettingError({
            id: "usage.refreshIntervalMs",
            message: "Invalid value for usage.refreshIntervalMs.",
          }),
        ),
      );
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(h.notify).toHaveBeenCalledWith(
            "Invalid value for usage.refreshIntervalMs.",
            "error",
          );
          expect(renderedRow(component, "Usage refresh")).toContain("120000");
        }),
      );

      component.handleInput?.(input.quit);
      yield* Effect.promise(() => closed);
    }),
  );

  it.effect.each(["throws", "undefined"] as const)(
    "warns and restores the pre-edit value when config %s after runtime rejection",
    (mode) =>
      Effect.gen(function* () {
        const write = deferred<StubRunResult>();
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
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            expect(h.notify).toHaveBeenCalledWith(
              "Better xAI settings are unavailable.",
              "warning",
            );
            expect(renderedRow(component, "Usage refresh")).toContain("60000");
          }),
        );

        component.handleInput?.(input.quit);
        yield* Effect.promise(() => closed);
      }),
  );

  it.effect("provides help, diagnostics, and validation feedback without session config", () =>
    Effect.gen(function* () {
      const h = settingsHarness([]);

      h.makeConfigUnavailable("undefined");
      yield* Effect.promise(() => h.invoke("help"));
      expect(h.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("usage.refreshIntervalMs"),
        "info",
      );
      yield* Effect.promise(() => h.invoke("diagnostics"));
      expect(h.notify).toHaveBeenLastCalledWith("diagnostics", "info");
      yield* Effect.promise(() => h.invoke("unknown true"));
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("unknown"), "error");
      yield* Effect.promise(() => h.invoke("usage.refreshIntervalMs"));
      expect(h.notify).toHaveBeenLastCalledWith(expect.any(String), "error");
      yield* Effect.promise(() => h.invoke("usage.showResetTimes invalid"));
      expect(h.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("usage.showResetTimes"),
        "error",
      );
      yield* Effect.promise(() => h.invoke(""));
      expect(h.notify).toHaveBeenLastCalledWith(expect.any(String), "warning");
    }),
  );
});
