import { initTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  deferredPromise,
  extensionContextFixture,
  opaqueFixture,
  plainTheme,
} from "pi-cosmic-core/testing";
import { vi } from "vitest";
import { BACKGROUND_TASK_SETTINGS } from "../src/config/options.ts";
import { DEFAULT_BACKGROUND_TASK_CONFIG } from "../src/config/schema.ts";
import { taskSettingsSubcommand, type TaskSettingsActions } from "../src/settings/controller.ts";

const harness = (options: { readonly trusted?: boolean; readonly started?: boolean } = {}) => {
  const write = vi.fn<TaskSettingsActions["write"]>(() => Promise.resolve());
  const read = vi.fn<TaskSettingsActions["read"]>(() => Promise.resolve({}));
  const command = taskSettingsSubcommand({
    config: () =>
      options.started === false
        ? undefined
        : { ...DEFAULT_BACKGROUND_TASK_CONFIG, shellPath: "/bin/\u001b[31mzsh\nspoof" },
    read,
    write,
  });
  const notify = vi.fn();
  const ctx = extensionContextFixture({
    cwd: "/project",
    mode: "rpc",
    hasUI: true,
    isProjectTrusted: () => options.trusted ?? true,
    ui: { notify },
  });
  const run = (args: string) => Effect.promise(() => Promise.resolve(command.handler(args, ctx)));
  return { write, read, notify, run };
};

/** The settings list opened in a terminal, driven by keys. */
const pickerHarness = (trusted: boolean) => {
  initTheme();
  setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS));
  let surface: Component | undefined;
  const modal = deferredPromise<unknown>();
  const write = vi.fn<TaskSettingsActions["write"]>(() => Promise.resolve());
  const command = taskSettingsSubcommand({
    config: () => DEFAULT_BACKGROUND_TASK_CONFIG,
    read: () => Promise.resolve({}),
    write,
  });
  const tui: TUI = opaqueFixture({ requestRender: () => undefined });
  const keybindings: KeybindingsManager = opaqueFixture({ matches: () => false });
  const custom = <T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void,
    ) => Component | Promise<Component>,
  ): Promise<T> => {
    const created = factory(tui, plainTheme, keybindings, modal.resolve);
    if (created instanceof Promise) throw new Error("Expected a synchronous settings surface.");
    surface = created;
    // SAFETY: The modal settles only with values supplied to the generic done callback.
    return modal.promise as Promise<T>;
  };
  const ctx = extensionContextFixture({
    cwd: "/project",
    mode: "tui" as const,
    hasUI: true,
    signal: new AbortController().signal,
    isProjectTrusted: () => trusted,
    ui: { custom, notify: vi.fn() },
  });
  const opened = Promise.resolve(command.handler("", ctx));
  const input = (data: string) => surface?.handleInput?.(data);
  return { write, input, opened, close: () => modal.resolve(undefined), isOpen: () => !!surface };
};

const flush = Effect.callback<void>((resume) => {
  const handle = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(handle));
});

describe("/tasks settings", () => {
  it.effect("shows the settings this session started with, without terminal controls", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run("status");
      const [message, level] = h.notify.mock.calls.at(-1) ?? [];
      expect(level).toBe("info");
      expect(message).toContain("maxRunning");
      expect(message).not.toContain("\u001b");
      const idle = harness({ started: false });
      yield* idle.run("status");
      expect(idle.notify).toHaveBeenLastCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("writes a checked value to the named scope and refuses the rest", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run("maxRunning 16");
      yield* h.run("project maxWaitSeconds 60");
      yield* h.run("project maxRunning inherit");
      expect(h.write.mock.calls).toEqual([
        [{ cwd: "/project", scope: "global" }, "maxRunning", 16],
        [{ cwd: "/project", scope: "project" }, "maxWaitSeconds", 60],
        // Inherit removes the scope's own value.
        [{ cwd: "/project", scope: "project" }, "maxRunning", undefined],
      ]);
      yield* h.run("maxRunning 999");
      expect(h.write).toHaveBeenCalledTimes(3);
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("maxRunning"), "error");

      const untrusted = harness({ trusted: false });
      yield* untrusted.run("project maxRunning 4");
      expect(untrusted.write).not.toHaveBeenCalled();
      expect(untrusted.notify).toHaveBeenLastCalledWith(
        expect.stringMatching(/trust/iu),
        "warning",
      );
    }),
  );

  it.effect("lists project rows after the global ones only for a trusted project", () =>
    Effect.gen(function* () {
      const rows = BACKGROUND_TASK_SETTINGS.filter((setting) => setting.values.length > 0);
      for (const trusted of [true, false]) {
        const h = pickerHarness(trusted);
        yield* flush;
        expect(h.isOpen()).toBe(true);
        // One step past the last global row: the first project row, or, with none, the list
        // wraps back to the first global row.
        for (const _ of rows) h.input("j");
        h.input("\r");
        yield* flush;
        expect(h.write).toHaveBeenCalledTimes(1);
        const [location, id] = h.write.mock.calls[0] ?? [];
        expect(location).toEqual({ cwd: "/project", scope: trusted ? "project" : "global" });
        expect(id).toBe(rows[0]?.id);
        h.close();
        yield* Effect.promise(() => h.opened);
      }
    }),
  );
});
