import { initTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { deferredPromise, extensionContextFixture, macrotask } from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { issueMessageStyleProblems } from "pi-code-previews/testing";
import { vi } from "vitest";
import { DEFAULT_BACKGROUND_TASK_CONFIG } from "../src/config/schema.ts";
import { BackgroundTaskConfigError } from "../src/config/store.ts";
import { taskSettingsSubcommand, type TaskSettingsActions } from "../src/settings/task-settings.ts";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "../src/task/bounds.ts";
import { BACKGROUND_TASK_SETTINGS } from "../src/config/options.ts";

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
  const screen = () => {
    const editor = host.editor;
    return editor ? Arr.join(editor.render(300), "\n") : "";
  };
  return {
    write,
    notify,
    input,
    screen,
    opened,
    open,
    close: () => input("\u001b"),
    // Enter opens the Global group; its second row's choice list starts on the current value, and
    // Enter picks another. Esc returns to the scope groups.
    choose: () => {
      input("\r");
      input("j");
      input("\r");
      input("k");
      input("\r");
      input("\u001b");
    },
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
      expect(Arr.map(untrusted.notify.mock.calls, ([, level]) => level)).toEqual([
        "warning",
        "warning",
      ]);
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
      expect(Arr.map(h.write.mock.calls, ([, , value]) => value)).toEqual([
        262_144, 262_144, 262_144, 1_048_576, 1_572_864, 4_194_304, 8_388_608,
      ]);
      expect(Arr.filter(h.notify.mock.calls, ([, level]) => level === "error")).toEqual([]);

      for (const value of ["1.5", "0.1k", "10x", "8MiB", "-1k", "k"])
        yield* h.run(`logBufferBytesPerTask ${value}`);
      expect(h.write).toHaveBeenCalledTimes(7);
      expect(Arr.filter(h.notify.mock.calls, ([, level]) => level === "error")).toHaveLength(6);
    }),
  );

  it.effect("accepts durations in the units settings show, counted in the setting's own unit", () =>
    Effect.gen(function* () {
      const h = harness();
      for (const value of ["2s", "1500ms", "0", "2500"]) yield* h.run(`stopGraceMs ${value}`);
      for (const value of ["1m", "90", "1m 30s", "1h"]) yield* h.run(`maxWaitSeconds ${value}`);
      expect(Arr.map(h.write.mock.calls, ([, id, value]) => [id, value])).toEqual([
        ["stopGraceMs", 2_000],
        ["stopGraceMs", 1_500],
        ["stopGraceMs", 0],
        ["stopGraceMs", 2_500],
        ["maxWaitSeconds", 60],
        ["maxWaitSeconds", 90],
        ["maxWaitSeconds", 90],
        ["maxWaitSeconds", 3_600],
      ]);
      expect(Arr.filter(h.notify.mock.calls, ([, level]) => level === "error")).toEqual([]);

      for (const value of ["1.5s", "500ms", "2x", "-1s", "1d"])
        yield* h.run(`maxWaitSeconds ${value}`);
      yield* h.run("stopGraceMs 31s");
      expect(h.write).toHaveBeenCalledTimes(8);
      expect(Arr.filter(h.notify.mock.calls, ([, level]) => level === "error")).toHaveLength(6);
    }),
  );

  it.effect("a size the list offers saves as bytes", () =>
    Effect.gen(function* () {
      const h = pickerHarness(true);
      yield* macrotask;
      expect(h.isOpen()).toBe(true);
      // The Global group, then its output-per-task row, whose list starts on the inherited value.
      h.input("\r");
      for (const _ of [1, 2, 3]) h.input("j");
      h.input("\r");
      h.input("k");
      h.input("\r");
      yield* macrotask;
      expect(
        Arr.map(h.write.mock.calls, ([location, id, value]) => [location.scope, id, value]),
      ).toEqual([["global", "logBufferBytesPerTask", 1_048_576]]);
      h.input("\u001b");
      h.close();
      yield* Effect.promise(() => h.opened);
    }),
  );

  it.effect("status and help report the session's values on single sanitized lines", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run("status");
      yield* h.run("help");
      const reports = Arr.map(h.notify.mock.calls, ([message, level]) => ({ message, level }));
      expect(Arr.map(reports, ({ level }) => level)).toEqual(["info", "info"]);
      for (const { message } of reports) {
        expect(message).not.toContain("\u001b");
        const lines = Str.split(message, "\n");
        const shellLines = Arr.filter(lines, (line) => Fn.pipe(line, Str.includes("/bin/")));
        expect(shellLines).toHaveLength(1);
        expect(shellLines[0]).toContain("shellPath");
        expect(
          Arr.some(lines, (line) => Fn.pipe(Str.trimStart(line), Str.startsWith("spoof"))),
        ).toBe(false);
      }
      expect(h.write).not.toHaveBeenCalled();
    }),
  );

  it.effect("status before the session starts warns instead of failing", () =>
    Effect.gen(function* () {
      const h = harness({ started: false });
      yield* h.run("status");
      expect(Arr.map(h.notify.mock.calls, ([, level]) => level)).toEqual(["warning"]);
      yield* h.run("help");
      expect(h.notify).toHaveBeenLastCalledWith(expect.not.stringContaining("/bin/"), "info");
    }),
  );

  it.effect("choosing a row's inherited value removes the scope's own value", () =>
    Effect.gen(function* () {
      const h = pickerHarness(true, (location) =>
        Promise.resolve(location.scope === "global" ? { enabled: false } : {}),
      );
      yield* macrotask;
      expect(h.isOpen()).toBe(true);
      // The Global group's first row shows its own `off`; its list offers the inherited default,
      // then on and off, so moving past `off` wraps to `inherit (on)`.
      h.input("\r");
      h.input("\r");
      h.input("j");
      h.input("\r");
      yield* macrotask;
      expect(
        Arr.map(h.write.mock.calls, ([location, id, value]) => [location.scope, id, value]),
      ).toEqual([["global", "enabled", undefined]]);
      h.input("\u001b");
      h.close();
      yield* Effect.promise(() => h.opened);
    }),
  );

  it.effect(
    "a global save shows at once in the project's inherited rows, choices, and summary",
    () =>
      Effect.gen(function* () {
        const h = pickerHarness(true);
        yield* macrotask;
        expect(h.isOpen()).toBe(true);
        const line = (label: string) =>
          Fn.pipe(
            Arr.findFirst(Str.split(h.screen(), "\n"), (entry) =>
              Fn.pipe(Str.trim(Str.replace(/^›/u, "")(entry)), Str.startsWith(label)),
            ),
            Option.getOrElse(() => ""),
          );
        const limits = Option.getOrThrow(
          Arr.findFirst(BACKGROUND_TASK_SETTINGS, (setting) => setting.id === "maxRunning"),
        ).values;
        // The list leads with `inherit (8)`, so the steps down to 16 are its index plus one.
        const steps = limits.indexOf("16") + 1;
        expect(steps).toBeGreaterThan(0);
        // Global's running limit, from inherited 8 to 16.
        h.input("\r");
        h.input("j");
        h.input("\r");
        for (const _ of Arr.range(1, steps)) h.input("j");
        h.input("\r");
        yield* macrotask;
        expect(h.write).toHaveBeenLastCalledWith(
          { cwd: "/project", scope: "global" },
          "maxRunning",
          16,
        );
        h.input("\u001b");
        expect(line("Project")).toContain("16 running");
        // The project row inherits the new value, and its choices lead with it.
        h.input("j");
        h.input("\r");
        expect(line("Running at once")).toContain("inherit (16)");
        h.input("j");
        h.input("\r");
        expect(line("(•)")).toContain("inherit (16)");
        h.input("\u001b");
        h.input("\u001b");
        // Restoring Global's inheritance shows the default again everywhere.
        h.input("k");
        h.input("\r");
        h.input("j");
        h.input("\r");
        for (const _ of Arr.range(1, steps)) h.input("k");
        h.input("\r");
        yield* macrotask;
        expect(h.write).toHaveBeenLastCalledWith(
          { cwd: "/project", scope: "global" },
          "maxRunning",
          undefined,
        );
        h.input("\u001b");
        expect(line("Global")).toContain("8 running");
        expect(line("Project")).toContain("8 running");
        h.input("j");
        h.input("\r");
        expect(line("Running at once")).toContain("inherit (8)");
        h.input("\u001b");
        h.close();
        yield* Effect.promise(() => h.opened);
      }),
  );

  it.effect(
    "a global save that settles after the project group opens updates its rows and open choices",
    () =>
      Effect.gen(function* () {
        const h = pickerHarness(true);
        yield* macrotask;
        expect(h.isOpen()).toBe(true);
        const lines = () => Str.split(h.screen(), "\n");
        const line = (label: string) =>
          Fn.pipe(
            Arr.findFirst(lines(), (entry) =>
              Fn.pipe(Str.trim(Str.replace(/^›/u, "")(entry)), Str.startsWith(label)),
            ),
            Option.getOrElse(() => ""),
          );
        const cursor = () =>
          Fn.pipe(
            Arr.findFirst(lines(), (entry) => Fn.pipe(Str.trim(entry), Str.startsWith("›"))),
            Option.getOrElse(() => ""),
          );
        const limits = Option.getOrThrow(
          Arr.findFirst(BACKGROUND_TASK_SETTINGS, (setting) => setting.id === "maxRunning"),
        ).values;
        const steps = limits.indexOf("16") + 1;
        const written = deferredPromise();
        const landed = deferredPromise();
        h.write.mockImplementationOnce(() => {
          written.resolve();
          return landed.promise;
        });
        // Global's running limit to 16, still being written when Project opens.
        h.input("\r");
        h.input("j");
        h.input("\r");
        for (const _ of Arr.range(1, steps)) h.input("j");
        h.input("\r");
        yield* Effect.promise(() => written.promise);
        h.input("\u001b");
        h.input("j");
        h.input("\r");
        h.input("j");
        expect(line("Running at once")).toContain("inherit (8)");
        // Project's choice list is open on its inherit choice when Global's write lands.
        h.input("\r");
        expect(cursor()).toContain("inherit (8)");
        landed.resolve();
        yield* macrotask;
        expect(line("(•)")).toContain("inherit (16)");
        expect(cursor()).toContain("inherit (16)");
        h.input("\u001b");
        expect(line("Running at once")).toContain("inherit (16)");
        expect(cursor()).toContain("Running at once");
        h.input("\u001b");
        expect(line("Project")).toContain("16 running");
        h.close();
        yield* Effect.promise(() => h.opened);
      }),
  );

  it.effect("a scope's summary resolves the values it inherits", () =>
    Effect.gen(function* () {
      const h = pickerHarness(true, (location) =>
        Promise.resolve(location.scope === "global" ? { maxRunning: 16 } : {}),
      );
      yield* macrotask;
      expect(h.isOpen()).toBe(true);
      const row = (label: string) =>
        Fn.pipe(
          Arr.findFirst(Str.split(h.screen(), "\n"), (line) =>
            Fn.pipe(Str.trim(Str.replace(/^›/u, "")(line)), Str.startsWith(label)),
          ),
          Option.getOrElse(() => ""),
        );
      // The project sets nothing, so it reads the global count rather than a bare `inherit`.
      expect(row("Project")).toContain("16");
      expect(row("Project")).not.toMatch(/\binherit\b/u);
      expect(row("Global")).toContain("16");
      h.close();
      yield* Effect.promise(() => h.opened);
    }),
  );

  it.effect("opens the readable scopes and keeps a broken file's scope unavailable", () =>
    Effect.gen(function* () {
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
      // The Global group, then the Project scope its broken file leaves unavailable.
      h.input("j");
      const reason = Fn.pipe(
        Arr.findFirst(Str.split(h.screen(), "\n"), (line) => Fn.pipe(line, Str.includes(path))),
        Option.map(Str.trim),
        Option.getOrElse(() => ""),
      );
      expect(issueMessageStyleProblems(reason, { maxLength: 200 })).toEqual([]);
      h.input("\r");
      yield* macrotask;
      expect(h.write).not.toHaveBeenCalled();
      h.input("j");
      h.choose();
      yield* macrotask;
      expect(Arr.map(h.write.mock.calls, ([location]) => location.scope)).toEqual(["global"]);
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
      h.choose();
      yield* Effect.promise(() => writeStarted.promise);
      expect(h.write).toHaveBeenCalledTimes(1);
      generation++;
      pending.resolve();
      yield* macrotask;
      expect(h.notify).not.toHaveBeenCalled();
      h.choose();
      expect(h.write).toHaveBeenCalledTimes(1);
      expect(h.isOpen()).toBe(false);
      yield* Effect.promise(() => h.opened);
      expect(h.notify).not.toHaveBeenCalled();

      const reopened = h.open();
      yield* macrotask;
      expect(h.isOpen()).toBe(true);
      h.choose();
      yield* macrotask;
      expect(h.write).toHaveBeenCalledTimes(2);
      // A successful change posts nothing; the new invocation's Global row shows the saved value.
      const [, , saved] = h.write.mock.calls[1] ?? [];
      expect(h.screen()).toContain(`${String(saved)} running`);
      expect(h.notify).not.toHaveBeenCalled();
      h.close();
      yield* Effect.promise(() => reopened);
    }),
  );
});
