import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import {
  deferredPromise,
  extensionContextFixture,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { vi } from "vitest";
import { registerTasksCommand } from "../src/settings/controller.ts";

const harness = (wait: Promise<void> = Promise.resolve()) => {
  const host = recordingExtensionHost();
  let generation = 0;
  let available = true;
  const signal = new AbortController();
  let liveSignal: AbortSignal | undefined = signal.signal;
  const notify = vi.fn<ExtensionUIContext["notify"]>();
  const ctx = extensionContextFixture({
    mode: "tui",
    hasUI: true,
    get signal() {
      return liveSignal;
    },
    ui: { notify },
  });
  const settingsHandler = vi.fn<(args: string, ctx: ExtensionCommandContext) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const entered = deferredPromise();
  const modules = {
    settings: vi.fn(() => {
      entered.resolve();
      return wait.then(() => ({
        taskSettingsSubcommand: () => ({
          name: "settings",
          description: "Settings",
          handler: settingsHandler,
        }),
      }));
    }),
  };
  const openActivity = vi.fn<(signal?: AbortSignal) => Promise<boolean>>(() =>
    Promise.resolve(false),
  );
  registerTasksCommand(
    host.pi,
    {
      captureAuthority: () => {
        const captured = generation;
        return () => generation === captured;
      },
      isAvailable: () => available,
      openActivity,
      config: () => undefined,
      read: () => Promise.resolve({}),
      write: () => Promise.resolve(),
    },
    modules,
  );
  const command = host.commands.get("tasks");
  if (!command) throw new Error("Missing tasks command");
  return {
    command,
    ctx,
    notify,
    modules,
    entered,
    settingsHandler,
    openActivity,
    originalSignal: signal.signal,
    setSignal: (next: AbortSignal | undefined) => {
      liveSignal = next;
    },
    run: (args: string) => Promise.resolve(command.handler(args, ctx)),
    retire: (reason: "shutdown" | "replacement" | "abort" | "abort-cleared" | "abort-replaced") => {
      if (reason === "abort" || reason === "abort-cleared" || reason === "abort-replaced") {
        signal.abort();
        if (reason !== "abort")
          liveSignal = reason === "abort-cleared" ? undefined : new AbortController().signal;
      } else {
        generation++;
        available = reason === "replacement";
      }
    },
  };
};

describe("lazy /tasks command implementations", () => {
  it.effect("keeps help and completions ready without loading settings", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* Effect.promise(() => h.run("help"));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
      const choices = yield* Effect.promise(() =>
        Promise.resolve(h.command.getArgumentCompletions?.("settings project maxRunning ")),
      );
      expect(
        Arr.some(choices ?? [], (choice) => choice.value === "settings project maxRunning inherit"),
      ).toBe(true);
      expect(h.modules.settings).not.toHaveBeenCalled();
      yield* Effect.promise(() => h.run("settings maxRunning 16"));
      expect(h.settingsHandler).toHaveBeenCalledWith("maxRunning 16", h.ctx);
    }),
  );

  it.effect("opens Activity and explains when Activity is unavailable", () =>
    Effect.gen(function* () {
      const h = harness();
      h.openActivity.mockResolvedValueOnce(true);
      yield* Effect.promise(() => h.run(""));
      expect(h.openActivity).toHaveBeenCalledWith(h.originalSignal);
      expect(h.notify).not.toHaveBeenCalled();
      yield* Effect.promise(() => h.run(""));
      expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("pi-cosmic-ui"), "warning");
    }),
  );

  const args = "settings maxRunning 16";
  it.effect.each(["shutdown", "replacement", "abort", "abort-cleared", "abort-replaced"] as const)(
    `does not invoke ${args} after %s during loading`,
    (reason) =>
      Effect.gen(function* () {
        const pending = deferredPromise();
        const h = harness(pending.promise);
        const running = h.run(args);
        yield* Effect.promise(() => h.entered.promise);
        h.retire(reason);
        pending.resolve();
        yield* Effect.promise(() => running);
        expect(h.settingsHandler).not.toHaveBeenCalled();
        expect(h.notify).not.toHaveBeenCalled();
        if (reason === "replacement") {
          yield* Effect.promise(() => h.run(args));
          expect(h.settingsHandler).toHaveBeenCalledOnce();
        }
      }),
  );

  it.effect(`retains the admitted signal through ${args} execution after the getter changes`, () =>
    Effect.gen(function* () {
      const pending = deferredPromise();
      const h = harness(pending.promise);
      const running = h.run(args);
      yield* Effect.promise(() => h.entered.promise);
      h.setSignal(new AbortController().signal);
      pending.resolve();
      yield* Effect.promise(() => running);
      const invocation = h.settingsHandler.mock.calls[0]?.[1];
      expect(invocation?.signal).toBe(h.originalSignal);
      h.retire("abort-cleared");
      expect(invocation?.signal?.aborted).toBe(true);
    }),
  );

  it.effect.each(["shutdown", "abort-cleared", "abort-replaced"] as const)(
    "does not report missing Activity after %s while Activity opens",
    (reason) =>
      Effect.gen(function* () {
        const pending = deferredPromise<boolean>();
        const h = harness();
        h.openActivity.mockImplementationOnce(() => pending.promise);
        const running = h.run("");
        expect(h.openActivity).toHaveBeenCalledWith(h.originalSignal);
        h.retire(reason);
        pending.resolve(false);
        yield* Effect.promise(() => running);
        expect(h.notify).not.toHaveBeenCalled();
      }),
  );

  it.effect("reports a current import failure and allows another invocation", () =>
    Effect.gen(function* () {
      const h = harness();
      const failure = new Error("command module unavailable");
      h.modules.settings.mockRejectedValueOnce(failure);
      const failed = yield* Effect.promise(() =>
        h.run(args).then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      );
      expect(failed).toBe(failure);
      yield* Effect.promise(() => h.run(args));
      expect(h.settingsHandler).toHaveBeenCalledOnce();
    }),
  );

  it.effect("suppresses retired import failures and needs no Activity outside a terminal", () =>
    Effect.gen(function* () {
      const pending = deferredPromise();
      const h = harness(pending.promise);
      const running = h.run(args);
      yield* Effect.promise(() => h.entered.promise);
      h.retire("abort-cleared");
      pending.reject(new Error("retired module failure"));
      yield* Effect.promise(() => running);
      expect(h.notify).not.toHaveBeenCalled();
      const rpc = harness();
      yield* Effect.promise(() =>
        Promise.resolve(
          rpc.command.handler(
            "",
            extensionContextFixture({ mode: "rpc", hasUI: true, ui: { notify: rpc.notify } }),
          ),
        ),
      );
      expect(rpc.openActivity).not.toHaveBeenCalled();
      expect(rpc.notify).toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );
});
