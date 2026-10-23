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
import { taskSettingsSubcommand, type TaskSettingsActions } from "../src/settings/task-settings.ts";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "../src/task/bounds.ts";

const SPOOFED_SHELL = "/bin/\u001b[31mzsh\nspoof = injected";

const harness = (options: { readonly trusted?: boolean; readonly started?: boolean } = {}) => {
  const write = vi.fn<TaskSettingsActions["write"]>(() => Promise.resolve());
  const read = vi.fn<TaskSettingsActions["read"]>(() => Promise.resolve({}));
  const command = taskSettingsSubcommand({
    config: () =>
      options.started === false
        ? undefined
        : { ...DEFAULT_BACKGROUND_TASK_CONFIG, shellPath: SPOOFED_SHELL },
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
      yield* untrusted.run("project maxRunning inherit");
      expect(untrusted.write).not.toHaveBeenCalled();
      expect(untrusted.notify.mock.calls.map(([, level]) => level)).toEqual(["warning", "warning"]);
    }),
  );

  it.effect("accepts waits up to the tool's own cap and rejects longer ones", () =>
    Effect.gen(function* () {
      const h = harness();
      const cap = BACKGROUND_TASK_FIELD_BOUNDS.maxWaitSeconds;
      yield* h.run(`maxWaitSeconds ${cap}`);
      yield* h.run(`maxWaitSeconds ${cap + 1}`);
      expect(h.write.mock.calls).toEqual([
        [{ cwd: "/project", scope: "global" }, "maxWaitSeconds", cap],
      ]);
      expect(h.notify).toHaveBeenLastCalledWith(expect.any(String), "error");
    }),
  );

  it.effect("accepts byte sizes with binary unit suffixes in any case", () =>
    Effect.gen(function* () {
      const h = harness();
      for (const value of ["262144", "256k", "256KiB", "1MiB", "1.5m", "4mb"])
        yield* h.run(`logBufferBytesPerTask ${value}`);
      yield* h.run("project totalLogBufferBytes 8M");
      expect(h.write.mock.calls.map(([, , value]) => value)).toEqual([
        262_144, 262_144, 262_144, 1_048_576, 1_572_864, 4_194_304, 8_388_608,
      ]);
      expect(h.notify.mock.calls.filter(([, level]) => level === "error")).toEqual([]);

      for (const value of ["1.5", "0.1k", "10x", "8MiB", "-1k", "k"])
        yield* h.run(`logBufferBytesPerTask ${value}`);
      expect(h.write).toHaveBeenCalledTimes(7);
      expect(h.notify.mock.calls.filter(([, level]) => level === "error")).toHaveLength(6);
    }),
  );

  it.effect("status and help report the session's values on single sanitized lines", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run("status");
      yield* h.run("help");
      const reports = h.notify.mock.calls.map(([message, level]) => ({ message, level }));
      expect(reports.map(({ level }) => level)).toEqual(["info", "info"]);
      for (const { message } of reports) {
        expect(message).not.toContain("\u001b");
        const shellLines = message.split("\n").filter((line) => line.includes("/bin/"));
        expect(shellLines).toHaveLength(1);
        expect(shellLines[0]).toContain("shellPath");
        expect(message.split("\n").some((line) => line.trimStart().startsWith("spoof"))).toBe(
          false,
        );
      }
      expect(h.write).not.toHaveBeenCalled();
    }),
  );

  it.effect("status before the session starts warns instead of failing", () =>
    Effect.gen(function* () {
      const h = harness({ started: false });
      yield* h.run("status");
      expect(h.notify.mock.calls.map(([, level]) => level)).toEqual(["warning"]);
      yield* h.run("help");
      expect(h.notify).toHaveBeenLastCalledWith(expect.not.stringContaining("/bin/"), "info");
    }),
  );

  it.effect("opens the readable scopes and keeps a broken file's scope unavailable", () =>
    Effect.gen(function* () {
      const rows = BACKGROUND_TASK_SETTINGS.filter((setting) => setting.values.length > 0);
      const path = "/project/.pi/extensions/pi-background-task.json";
      const h = pickerHarness(true, (location) =>
        location.scope === "project"
          ? Promise.reject(
              BackgroundTaskConfigError.make({ operation: "read", path, message: "Unreadable." }),
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
