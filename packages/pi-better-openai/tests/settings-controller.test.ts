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
import * as MutableRef from "effect/MutableRef";
import { beforeAll, describe, vi } from "vitest";
import { DEFAULT_FOOTER_CONFIG, type FooterMode } from "../src/config/schema.ts";
import { initialFastSnapshot } from "../src/fast/controller.ts";
import { registerSettingsController } from "../src/settings/controller.ts";
import { makeResolvedConfig } from "./helpers.ts";

type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
type SettingsRun = Parameters<typeof registerSettingsController>[1]["run"];
type StubRunResult = void | Readonly<Record<string, never>>;
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

function settingsHarness(responses: Array<() => Promise<StubRunResult>>) {
  let command: RegisteredCommand | undefined;
  let component: Component | undefined;
  let currentConfig = makeResolvedConfig({
    configPath: "/tmp/openai-settings.json",
    footer: { ...DEFAULT_FOOTER_CONFIG, mode: "status" },
  });
  const requestRender = vi.fn();
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
    // SAFETY: The controller's registered custom factory returns its component synchronously.
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
      if (name === "openai-settings") command = value;
    },
  });
  const runImpl = vi.fn(() => responses.shift()?.() ?? Promise.resolve({}));
  const run: SettingsRun = <A>() =>
    runImpl().then((value) => {
      // SAFETY: The run queue supplies the result expected by the controller path under test.
      return value as A;
    });

  registerSettingsController(pi, {
    config: () => currentConfig,
    updateContext: vi.fn(),
    updateFooter: vi.fn(),
    hasTerminalUI: () => true,
    formatDebugStatus: () => "diagnostics",
    fastProjection: MutableRef.make(initialFastSnapshot()),
    resetFastRoutingTransport: vi.fn(),
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
  const setFooterMode = (mode: FooterMode) => {
    currentConfig = {
      ...currentConfig,
      footer: { ...currentConfig.footer, mode },
    };
  };

  return { invoke, open, selectedComponent, setFooterMode, requestRender, runImpl };
}

const input = {
  down: "\u001b[B",
  enter: "\r",
  escape: "\u001b",
};

function openFooterSubmenu(component: Component): void {
  component.handleInput?.(input.down);
  component.handleInput?.(input.down);
  component.handleInput?.(input.enter);
}

function renderedRow(component: Component, label: string): string | undefined {
  return component.render(100).find((line) => line.includes(label));
}

describe("Better OpenAI settings controller", () => {
  it.effect(
    "reconciles an optimistic submenu value from the authoritative successful projection",
    () =>
      Effect.gen(function* () {
        const write = deferred<StubRunResult>();
        const h = settingsHarness([
          () => Promise.resolve({}),
          () => write.promise,
          () => Promise.resolve({}),
        ]);
        const { closed } = yield* h.open;
        const component = h.selectedComponent();

        openFooterSubmenu(component);
        component.handleInput?.(input.enter);
        expect(renderedRow(component, "Footer mode")).toContain("off");

        h.setFooterMode("replace");
        write.resolve(undefined);
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            expect(renderedRow(component, "Footer mode")).toContain("replace");
          }),
        );

        component.handleInput?.(input.escape);
        expect(renderedRow(component, "Footer")).toContain("replace");
        component.handleInput?.(input.escape);
        yield* Effect.promise(() => closed);
      }),
  );

  it.effect("rolls back a failed optimistic value after the picker has closed", () =>
    Effect.gen(function* () {
      const write = deferred<StubRunResult>();
      const h = settingsHarness([
        () => Promise.resolve({}),
        () => write.promise,
        () => Promise.resolve({}),
      ]);
      const { closed } = yield* h.open;
      const component = h.selectedComponent();

      openFooterSubmenu(component);
      component.handleInput?.(input.enter);
      expect(renderedRow(component, "Footer mode")).toContain("off");
      component.handleInput?.(input.escape);
      component.handleInput?.(input.escape);
      yield* Effect.promise(() => closed);
      const rendersBeforeSettlement = h.requestRender.mock.calls.length;

      write.reject(new Error("runtime closed"));
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(h.requestRender.mock.calls.length).toBeGreaterThan(rendersBeforeSettlement);
        }),
      );
      expect(() => component.render(100)).not.toThrow();
      expect(renderedRow(component, "Footer")).toContain("status");
    }),
  );

  it.effect(
    "does not enter an inactive runtime for pure command branches and contains apply rejection",
    () =>
      Effect.gen(function* () {
        const h = settingsHarness([() => Promise.reject(new Error("runtime inactive"))]);

        yield* Effect.promise(() => h.invoke("help"));
        yield* Effect.promise(() => h.invoke("diagnostics"));
        yield* Effect.promise(() => h.invoke("unknown true"));
        expect(h.runImpl).not.toHaveBeenCalled();

        yield* Effect.promise(() => h.invoke("footer.mode off"));
        expect(h.runImpl).toHaveBeenCalledOnce();
      }),
  );
});
