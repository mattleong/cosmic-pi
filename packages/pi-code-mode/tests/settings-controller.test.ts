import {
  initTheme,
  type ExtensionAPI,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import {
  extensionApiFixture,
  extensionContextFixture,
  opaqueFixture,
  plainTheme,
  yieldUntil,
} from "pi-cosmic-core/testing";
import { vi } from "vitest";
import type { SettingsSurfaceResult } from "../src/boundary/host-ui.ts";
import { InvalidCodeModeSettingError } from "../src/config/options.ts";
import {
  CodeModeConfigStore,
  type CodeModeConfigStoreContract,
  type CodeModeState,
} from "../src/config/store.ts";
import { registerCodeModeSettingsController } from "../src/settings/controller.ts";
import { codeModeStateFixture } from "./support/host.ts";

type CommandDefinition = Parameters<ExtensionAPI["registerCommand"]>[1];
type HostFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: SettingsSurfaceResult) => void,
) => Component & { dispose?(): void };

const makeHarness = (
  getState: () => CodeModeState,
  setSetting: CodeModeConfigStoreContract["setSetting"],
  input: () => Promise<string | undefined> = () => Promise.resolve(undefined),
  capturedSignal?: AbortSignal,
) => {
  const store: CodeModeConfigStoreContract = {
    snapshot: getState,
    setSetting,
    clearSetting: () => Effect.succeed(getState()),
  };
  initTheme();
  setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS));
  const commands = new Map<string, CommandDefinition>();
  const notify = vi.fn();
  const requestRender = vi.fn();
  const hostDone = vi.fn();
  const commandAbort = new AbortController();
  const order: string[] = [];
  let activeEditor: "select" | "custom" | "input" | undefined;
  let overlaps = 0;
  let runCount = 0;
  let customOpenCount = 0;
  let surface: Component | undefined;
  const tui: TUI = opaqueFixture({ requestRender });
  const keybindings: KeybindingsManager = opaqueFixture({
    matches: (_data: string, id: string) => id === "tui.select.confirm",
  });
  const enter = (slot: typeof activeEditor) => {
    if (activeEditor !== undefined) overlaps += 1;
    activeEditor = slot;
  };
  const leave = (slot: typeof activeEditor) => {
    if (activeEditor === slot) activeEditor = undefined;
  };
  const ctx = extensionContextFixture({
    mode: "tui" as const,
    hasUI: true,
    ui: {
      notify,
      select: () => {
        enter("select");
        order.push("select");
        return Promise.resolve("global").finally(() => leave("select"));
      },
      input: () => {
        enter("input");
        order.push("input");
        return input().finally(() => leave("input"));
      },
      custom: (factory: HostFactory) => {
        enter("custom");
        customOpenCount += 1;
        order.push("custom-open");
        const completed = Deferred.makeUnsafe<SettingsSurfaceResult>();
        surface = factory(tui, plainTheme, keybindings, (result) => {
          hostDone(result);
          order.push(`custom-close:${result._tag}`);
          leave("custom");
          void Deferred.doneUnsafe(completed, Effect.succeed(result));
        });
        return Effect.runPromise(Deferred.await(completed));
      },
    },
  });
  const pi = extensionApiFixture({
    registerCommand: (name: string, definition: CommandDefinition) =>
      commands.set(name, definition),
  });
  const run = <A, E>(
    effect: Effect.Effect<A, E, CodeModeConfigStore>,
    signal?: AbortSignal,
  ): Promise<A> => {
    runCount += 1;
    return Effect.runPromise(
      effect.pipe(Effect.provideService(CodeModeConfigStore, CodeModeConfigStore.of(store))),
      signal ? { signal } : undefined,
    );
  };
  registerCodeModeSettingsController(pi, {
    snapshot: getState,
    captureSignal: () => ({ _tag: "Captured", signal: capturedSignal ?? commandAbort.signal }),
    run,
  });
  return {
    commandAbort,
    hostDone,
    notify,
    open: () => Promise.resolve(commands.get("code-mode-settings")?.handler("", ctx)),
    order,
    overlaps: () => overlaps,
    runCount: () => runCount,
    customOpenCount: () => customOpenCount,
    surface: () => surface,
  };
};

const chooseCustomTimeout = (surface: Component | undefined): void => {
  surface?.handleInput?.("\u001b[B");
  surface?.handleInput?.("\r");
};

const rendered = (surface: Component | undefined): string => surface?.render(100).join("\n") ?? "";

describe("code mode settings controller surface ownership", () => {
  it.effect(
    "closes the list before input and reopens it from fresh state for every input outcome",
    () =>
      Effect.gen(function* () {
        const cases = [
          { name: "cancelled", input: () => Promise.resolve(undefined) },
          { name: "unavailable", input: () => Promise.reject(new Error("input unavailable")) },
          { name: "rejected", input: () => Promise.resolve("bad") },
        ] as const;
        for (const testCase of cases) {
          let state = codeModeStateFixture(
            { timeoutMs: 300_000 },
            { globalValues: { timeoutMs: 300_000 } },
          );
          const setSetting = vi.fn((_scope: string, id: string, value: string) => {
            if (testCase.name === "rejected")
              return Effect.fail(
                new InvalidCodeModeSettingError({ id, message: "rejected setting" }),
              );
            state = codeModeStateFixture(
              { timeoutMs: Number(value) },
              { globalValues: { timeoutMs: Number(value) } },
            );
            return Effect.succeed(state);
          });
          const h = makeHarness(() => state, setSetting, testCase.input);
          const opening = h.open();
          yield* yieldUntil(() => h.customOpenCount() === 1);
          chooseCustomTimeout(h.surface());
          yield* yieldUntil(() => h.customOpenCount() === 2);

          expect(h.customOpenCount(), testCase.name).toBe(2);
          expect(h.overlaps(), testCase.name).toBe(0);
          expect(h.order.indexOf("custom-close:PromptInteger"), testCase.name).toBeLessThan(
            h.order.indexOf("input"),
          );
          if (testCase.name === "rejected")
            expect(setSetting).toHaveBeenCalledWith("global", "timeoutMs", "bad");
          else expect(setSetting).not.toHaveBeenCalled();

          h.commandAbort.abort();
          yield* Effect.promise(() => opening);
        }
      }),
  );

  it.effect("joins an uninterruptible preset commit before custom input and reopen", () =>
    Effect.gen(function* () {
      let state = codeModeStateFixture(
        { enabled: true, timeoutMs: 300_000 },
        { globalValues: { enabled: true, timeoutMs: 300_000 } },
      );
      const commitStarted = Deferred.makeUnsafe<void>();
      const releaseCommit = Deferred.makeUnsafe<void>();
      let inputSawEnabled: boolean | undefined;
      const setSetting = vi.fn((_scope: string, id: string, value: string) => {
        const commit = Effect.sync(() => {
          const next = id === "enabled" ? value === "true" : Number(value);
          state = codeModeStateFixture(
            { ...state.config, [id]: next },
            { globalValues: { ...state.globalValues, [id]: next } },
          );
          return state;
        });
        return id === "enabled"
          ? Effect.uninterruptible(
              Deferred.succeed(commitStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCommit)),
                Effect.andThen(commit),
              ),
            )
          : commit;
      });
      const h = makeHarness(
        () => state,
        setSetting,
        () => {
          inputSawEnabled = state.config.enabled;
          return Promise.resolve("123");
        },
      );
      const opening = h.open();
      yield* yieldUntil(() => h.customOpenCount() === 1);
      h.surface()?.handleInput?.("\r");
      yield* Deferred.await(commitStarted);
      chooseCustomTimeout(h.surface());
      yield* yieldUntil(() => h.order.includes("custom-close:PromptInteger"));
      expect(h.order).not.toContain("input");
      expect(h.customOpenCount()).toBe(1);

      yield* Deferred.succeed(releaseCommit, undefined);
      yield* yieldUntil(() => h.customOpenCount() === 2);
      expect(inputSawEnabled).toBe(false);
      expect(rendered(h.surface())).toMatch(/Code Mode enabled.*false/);
      expect(rendered(h.surface())).toMatch(/Program timeout \(ms\).*123/);
      h.commandAbort.abort();
      yield* Effect.promise(() => opening);
    }),
  );

  it.effect("rolls an active failed write back to the persisted row value", () =>
    Effect.gen(function* () {
      const state = codeModeStateFixture({}, { globalValues: { enabled: true } });
      const setSetting = vi.fn(() =>
        Effect.fail(
          new InvalidCodeModeSettingError({ id: "enabled", message: "rejected setting" }),
        ),
      );
      const h = makeHarness(() => state, setSetting);
      const opening = h.open();
      yield* yieldUntil(() => h.customOpenCount() === 1);
      h.surface()?.handleInput?.("\r");
      yield* yieldUntil(() => h.notify.mock.calls.some((call) => call[1] === "error"));

      expect(setSetting).toHaveBeenCalledOnce();
      expect(rendered(h.surface())).toMatch(/Code Mode enabled.*true/);
      expect(rendered(h.surface())).not.toMatch(/Code Mode enabled.*false/);
      h.commandAbort.abort();
      yield* Effect.promise(() => opening);
    }),
  );

  it.effect("fails closed when the captured signal getter throws", () =>
    Effect.gen(function* () {
      const state = codeModeStateFixture();
      const setSetting = vi.fn(() => Effect.succeed(state));
      const hostileSignal = opaqueFixture({
        get aborted() {
          throw new Error("hostile aborted getter");
        },
      });
      const h = makeHarness(() => state, setSetting, undefined, hostileSignal);
      yield* Effect.promise(() => h.open());
      expect(h.runCount()).toBe(0);
      expect(h.customOpenCount()).toBe(0);
      expect(setSetting).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
    }),
  );

  it.effect("suppresses callbacks from a surface closed by session interruption", () =>
    Effect.gen(function* () {
      const state = codeModeStateFixture();
      const setSetting = vi.fn(() => Effect.succeed(state));
      const h = makeHarness(() => state, setSetting);
      const opening = h.open();
      yield* yieldUntil(() => h.customOpenCount() === 1);
      h.commandAbort.abort();
      yield* Effect.promise(() => opening);
      h.notify.mockClear();

      h.surface()?.handleInput?.("\r");
      yield* Effect.yieldNow;
      expect(setSetting).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
      expect(h.hostDone).toHaveBeenCalledOnce();
    }),
  );
});
