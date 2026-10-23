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
import type { BackgroundTaskProjectionBridge } from "../src/boundary/host-ui.ts";
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
  const openTaskManager = vi.fn<typeof import("../src/settings/task-manager.ts").openTaskManager>(
    () => Promise.resolve(),
  );
  const settingsHandler = vi.fn<(args: string, ctx: ExtensionCommandContext) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const entered = deferredPromise();
  const modules = {
    manager: vi.fn(() => {
      entered.resolve();
      return wait.then(() => ({ openTaskManager }));
    }),
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
  const bridge: BackgroundTaskProjectionBridge = {
    get: () => ({ tasks: [] }),
    publish: () => undefined,
    subscribe: () => () => undefined,
    clear: () => undefined,
    setContext: () => undefined,
    setFooterEnabled: () => undefined,
  };
  registerTasksCommand(
    host.pi,
    bridge,
    {
      captureAuthority: () => {
        const captured = generation;
        return () => generation === captured;
      },
      isAvailable: () => available,
      openActivity,
      stop: () => Promise.resolve(),
      clear: () => Promise.resolve(),
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
    openTaskManager,
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
  it.effect("keeps help and completions ready without loading managers or settings", () =>
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
      expect(h.modules.manager).not.toHaveBeenCalled();
      expect(h.modules.settings).not.toHaveBeenCalled();
      yield* Effect.promise(() => h.run("settings maxRunning 16"));
      expect(h.settingsHandler).toHaveBeenCalledWith("maxRunning 16", h.ctx);
      expect(h.modules.manager).not.toHaveBeenCalled();
    }),
  );

  it.effect("loads the standalone manager on first use only when Activity declines", () =>
    Effect.gen(function* () {
      const h = harness();
      h.openActivity.mockResolvedValueOnce(true);
      yield* Effect.promise(() => h.run(""));
      expect(h.modules.manager).not.toHaveBeenCalled();
      yield* Effect.promise(() => h.run(""));
      expect(h.openTaskManager).toHaveBeenCalledWith(
        h.ctx,
        expect.anything(),
        expect.anything(),
        expect.any(Function),
      );
    }),
  );

  for (const args of ["", "settings maxRunning 16"])
    it.effect.each([
      "shutdown",
      "replacement",
      "abort",
      "abort-cleared",
      "abort-replaced",
    ] as const)(`does not invoke ${args || "the manager"} after %s during loading`, (reason) =>
      Effect.gen(function* () {
        const pending = deferredPromise();
        const h = harness(pending.promise);
        const running = h.run(args);
        yield* Effect.promise(() => h.entered.promise);
        h.retire(reason);
        pending.resolve();
        yield* Effect.promise(() => running);
        expect(h.openTaskManager).not.toHaveBeenCalled();
        expect(h.settingsHandler).not.toHaveBeenCalled();
        expect(h.notify).not.toHaveBeenCalled();
        if (reason === "replacement") {
          yield* Effect.promise(() => h.run(args));
          expect(args ? h.settingsHandler : h.openTaskManager).toHaveBeenCalledOnce();
        }
      }),
    );

  for (const args of ["", "settings maxRunning 16"])
    it.effect(
      `retains the admitted signal through ${args || "manager"} execution after the getter changes`,
      () =>
        Effect.gen(function* () {
          const pending = deferredPromise();
          const h = harness(pending.promise);
          const running = h.run(args);
          yield* Effect.promise(() => h.entered.promise);
          h.setSignal(new AbortController().signal);
          pending.resolve();
          yield* Effect.promise(() => running);
          const invocation = args
            ? h.settingsHandler.mock.calls[0]?.[1]
            : h.openTaskManager.mock.calls[0]?.[0];
          expect(invocation?.signal).toBe(h.originalSignal);
          h.retire("abort-cleared");
          expect(invocation?.signal?.aborted).toBe(true);
        }),
    );

  it.effect.each(["abort-cleared", "abort-replaced"] as const)(
    "does not start the manager fallback after %s while Activity opens",
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
        expect(h.modules.manager).not.toHaveBeenCalled();
        expect(h.openTaskManager).not.toHaveBeenCalled();
        expect(h.notify).not.toHaveBeenCalled();
      }),
  );

  it.effect("reports a current import failure and allows another invocation", () =>
    Effect.gen(function* () {
      const h = harness();
      const failure = new Error("command module unavailable");
      h.modules.manager.mockRejectedValueOnce(failure);
      const failed = yield* Effect.promise(() =>
        h.run("").then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      );
      expect(failed).toBe(failure);
      yield* Effect.promise(() => h.run(""));
      expect(h.openTaskManager).toHaveBeenCalledOnce();
    }),
  );

  it.effect("suppresses retired import failures and avoids imports for non-terminal fallback", () =>
    Effect.gen(function* () {
      const pending = deferredPromise();
      const h = harness(pending.promise);
      const running = h.run("");
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
      expect(rpc.modules.manager).not.toHaveBeenCalled();
      expect(rpc.notify).toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );
});
