import { initTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { deferredPromise, extensionContextFixture, macrotask } from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { issueMessageStyleProblems } from "pi-code-previews/testing";
import { vi } from "vitest";
import { BACKGROUND_TASK_SETTINGS } from "../src/config/options.ts";
import { DEFAULT_BACKGROUND_TASK_CONFIG } from "../src/config/schema.ts";
import { BackgroundTaskConfigError } from "../src/config/store.ts";
import { taskSettingsSubcommand, type TaskSettingsActions } from "../src/settings/controller.ts";

const harness = (options: { readonly trusted?: boolean; readonly started?: boolean } = {}) => {
  const write = vi.fn<TaskSettingsActions["write"]>(() => Promise.resolve());
  const read = vi.fn<TaskSettingsActions["read"]>(() => Promise.resolve({}));
  const command = taskSettingsSubcommand({
    config: () =>
      options.started === false
        ? undefined
        : { ...DEFAULT_BACKGROUND_TASK_CONFIG, shellPath: "/bin/\u001b[31mzsh\nspoof" },
    captureAuthority: () => () => true,
    read,
    write,
  });
  const notify = vi.fn<ExtensionUIContext["notify"]>();
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

const pickerHarness = (
  trusted: boolean,
  read: TaskSettingsActions["read"] = () => Promise.resolve({}),
  captureAuthority: TaskSettingsActions["captureAuthority"] = () => () => true,
) => {
  initTheme();
  setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS));
  const write = vi.fn<TaskSettingsActions["write"]>(() => Promise.resolve());
  const notify = vi.fn<ExtensionUIContext["notify"]>();
  const command = taskSettingsSubcommand({
    config: () => DEFAULT_BACKGROUND_TASK_CONFIG,
    captureAuthority,
    read,
    write,
  });
  const host = fakeCustomSurfaceHost();
  const ctx = extensionContextFixture({
    cwd: "/project",
    mode: "tui" as const,
    hasUI: true,
    signal: new AbortController().signal,
    isProjectTrusted: () => trusted,
    ui: { custom: host.ctx.ui.custom.bind(host.ctx.ui), notify },
  });
  const open = () => Promise.resolve(command.handler("", ctx));
  const opened = open();
  const input = (data: string) => host.editor?.handleInput?.(data);
  const screen = () => host.editor?.render(300).join("\n") ?? "";
  return {
    write,
    notify,
    input,
    screen,
    opened,
    open,
    close: () => input("\u001b"),
    isOpen: () => {
      host.mount();
      return host.editor !== undefined;
    },
  };
};

describe("/tasks settings", () => {
  it.effect("writes a checked value to the named scope and refuses the rest", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run("maxRunning 16");
      yield* h.run("project maxWaitSeconds 60");
      yield* h.run("project maxRunning inherit");
      expect(h.write.mock.calls).toEqual([
        [{ cwd: "/project", scope: "global" }, "maxRunning", 16],
        [{ cwd: "/project", scope: "project" }, "maxWaitSeconds", 60],
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

  it.effect("opens the readable scopes and keeps a broken file's scope unavailable", () =>
    Effect.gen(function* () {
      const rows = BACKGROUND_TASK_SETTINGS.filter((setting) => setting.values.length > 0);
      const path = "/project/.pi/extensions/pi-background-task.json";
      const h = pickerHarness(true, (location) =>
        location.scope === "project"
          ? Promise.reject(
              new BackgroundTaskConfigError({ operation: "read", path, message: "Unreadable." }),
            )
          : Promise.resolve({}),
      );
      yield* macrotask;
      expect(h.isOpen()).toBe(true);
      expect(h.notify).not.toHaveBeenCalled();
      for (const _ of rows) h.input("j");
      const reason =
        h
          .screen()
          .split("\n")
          .find((line) => line.includes(path))
          ?.trim() ?? "";
      expect(issueMessageStyleProblems(reason, { maxLength: 200 })).toEqual([]);
      h.input("\r");
      yield* macrotask;
      expect(h.write).not.toHaveBeenCalled();
      h.input("j");
      h.input("\r");
      yield* macrotask;
      expect(h.write.mock.calls.map(([location]) => location.scope)).toEqual(["global"]);
      h.close();
      yield* Effect.promise(() => h.opened);
    }),
  );

  it.effect("revokes retained picker writes and late notifications, but not new invocations", () =>
    Effect.gen(function* () {
      let generation = 1;
      const pending = deferredPromise();
      const h = pickerHarness(true, undefined, () => {
        const token = generation;
        return () => token === generation;
      });
      yield* macrotask;
      expect(h.isOpen()).toBe(true);
      const writeStarted = deferredPromise();
      h.write.mockImplementationOnce(() => {
        writeStarted.resolve();
        return pending.promise;
      });
      h.input("\r");
      yield* Effect.promise(() => writeStarted.promise);
      expect(h.write).toHaveBeenCalledTimes(1);
      generation++;
      pending.resolve();
      yield* macrotask;
      expect(h.notify).not.toHaveBeenCalled();
      h.input("\r");
      expect(h.write).toHaveBeenCalledTimes(1);
      expect(h.isOpen()).toBe(false);
      yield* Effect.promise(() => h.opened);
      expect(h.notify).not.toHaveBeenCalled();

      const reopened = h.open();
      yield* macrotask;
      expect(h.isOpen()).toBe(true);
      h.input("\r");
      yield* macrotask;
      expect(h.write).toHaveBeenCalledTimes(2);
      expect(h.notify).toHaveBeenCalled();
      h.close();
      yield* Effect.promise(() => reopened);
    }),
  );
});
