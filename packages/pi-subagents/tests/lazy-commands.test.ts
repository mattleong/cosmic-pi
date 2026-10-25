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
import { registerSubagentManagerCommand } from "../src/settings/controller.ts";
import { subagentCommandActionsFixture } from "./fixtures/profile-settings-inspection.ts";

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
  const openProfileDashboard = vi.fn<
    typeof import("../src/settings/profile-dashboard.ts").openProfileDashboard
  >(() => Promise.resolve());
  const settingsHandler = vi.fn<(args: string, ctx: ExtensionCommandContext) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const runDoctor = vi.fn<(ctx: ExtensionCommandContext) => Promise<[]>>(() => Promise.resolve([]));
  const entered = deferredPromise();
  const modules = {
    profiles: vi.fn(() => {
      entered.resolve();
      return wait.then(() => ({ openProfileDashboard }));
    }),
    settings: vi.fn(() => {
      entered.resolve();
      return wait.then(() => ({
        subagentSettingsSubcommand: () => ({
          name: "settings",
          description: "Settings",
          handler: settingsHandler,
        }),
      }));
    }),
    doctor: vi.fn(() => {
      entered.resolve();
      return wait.then(() => ({ formatDoctorReport: () => "Doctor report" }));
    }),
  };
  const openActivity = vi.fn<(signal?: AbortSignal) => Promise<boolean>>(() =>
    Promise.resolve(false),
  );
  registerSubagentManagerCommand(
    host.pi,
    subagentCommandActionsFixture({
      captureAuthority: () => {
        const captured = generation;
        return () => captured === generation;
      },
      isAvailable: () => available,
      openActivity,
      runDoctor,
    }),
    modules,
  );
  const command = host.commands.get("subagents");
  if (!command) throw new Error("Missing subagents command");
  return {
    command,
    ctx,
    notify,
    modules,
    entered,
    openProfileDashboard,
    settingsHandler,
    runDoctor,
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

const COMMANDS = ["profiles worker", "settings delegation encouraged", "doctor"] as const;

describe("lazy /subagents command implementations", () => {
  it.effect("keeps help and completions available without loading optional implementations", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* Effect.promise(() => h.run("help"));
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
      const settings = yield* Effect.promise(() =>
        Promise.resolve(h.command.getArgumentCompletions?.("settings project delegation ")),
      );
      expect(
        Arr.some(
          settings ?? [],
          (choice) => choice.value === "settings project delegation encouraged",
        ),
      ).toBe(true);
      const profiles = yield* Effect.promise(() =>
        Promise.resolve(h.command.getArgumentCompletions?.("profiles work")),
      );
      expect(Arr.some(profiles ?? [], (choice) => choice.value === "profiles worker")).toBe(true);
      for (const load of [h.modules.profiles, h.modules.settings, h.modules.doctor])
        expect(load).not.toHaveBeenCalled();
      for (const args of COMMANDS) yield* Effect.promise(() => h.run(args));
      expect(h.openProfileDashboard).toHaveBeenCalledWith(
        expect.anything(),
        h.ctx,
        expect.anything(),
        { initialProfile: "worker", initialFocus: "fields" },
      );
      expect(h.settingsHandler).toHaveBeenCalledWith("delegation encouraged", h.ctx);
      expect(h.runDoctor).toHaveBeenCalledWith(h.ctx);
    }),
  );

  for (const args of COMMANDS)
    it.effect.each([
      "shutdown",
      "replacement",
      "abort",
      "abort-cleared",
      "abort-replaced",
    ] as const)(`does not invoke ${args} after %s during loading`, (reason) =>
      Effect.gen(function* () {
        const pending = deferredPromise();
        const h = harness(pending.promise);
        const running = h.run(args);
        yield* Effect.promise(() => h.entered.promise);
        h.retire(reason);
        pending.resolve();
        yield* Effect.promise(() => running);
        for (const action of [h.openProfileDashboard, h.settingsHandler, h.runDoctor])
          expect(action).not.toHaveBeenCalled();
        expect(h.notify).not.toHaveBeenCalled();
        if (reason === "replacement") {
          yield* Effect.promise(() => h.run(args));
          expect(
            h.openProfileDashboard.mock.calls.length +
              h.settingsHandler.mock.calls.length +
              h.runDoctor.mock.calls.length,
          ).toBe(1);
        }
      }),
    );

  for (const args of COMMANDS)
    it.effect(
      `retains the admitted signal through ${args} execution after the getter changes`,
      () =>
        Effect.gen(function* () {
          const pending = deferredPromise();
          const h = harness(pending.promise);
          const running = h.run(args);
          yield* Effect.promise(() => h.entered.promise);
          h.setSignal(new AbortController().signal);
          pending.resolve();
          yield* Effect.promise(() => running);
          const invocation =
            h.openProfileDashboard.mock.calls[0]?.[1] ??
            h.settingsHandler.mock.calls[0]?.[1] ??
            h.runDoctor.mock.calls[0]?.[0];
          expect(invocation?.signal).toBe(h.originalSignal);
          h.retire("abort-cleared");
          expect(invocation?.signal?.aborted).toBe(true);
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

  it.effect("preserves doctor failure feedback and retries loading on a later invocation", () =>
    Effect.gen(function* () {
      const h = harness();
      h.modules.doctor.mockRejectedValueOnce(new Error("doctor module unavailable"));
      yield* Effect.promise(() => h.run("doctor"));
      expect(h.notify).toHaveBeenLastCalledWith(expect.any(String), "error");
      expect(h.runDoctor).not.toHaveBeenCalled();
      yield* Effect.promise(() => h.run("doctor"));
      expect(h.notify).toHaveBeenLastCalledWith(expect.any(String), "info");
      expect(h.runDoctor).toHaveBeenCalledOnce();
    }),
  );

  it.effect("does not publish a retired doctor import failure or a late doctor report", () =>
    Effect.gen(function* () {
      const pending = deferredPromise();
      const h = harness(pending.promise);
      const running = h.run("doctor");
      yield* Effect.promise(() => h.entered.promise);
      h.retire("abort-cleared");
      pending.reject(new Error("retired module failure"));
      yield* Effect.promise(() => running);
      expect(h.notify).not.toHaveBeenCalled();

      const current = harness();
      const report = deferredPromise<[]>();
      const started = deferredPromise();
      current.runDoctor.mockImplementationOnce(() => {
        started.resolve();
        return report.promise;
      });
      const checking = current.run("doctor");
      yield* Effect.promise(() => started.promise);
      current.retire("abort-cleared");
      report.resolve([]);
      yield* Effect.promise(() => checking);
      expect(current.notify).not.toHaveBeenCalled();
    }),
  );

  it.effect("propagates a current Activity failure and needs no Activity outside a terminal", () =>
    Effect.gen(function* () {
      const h = harness();
      const failure = new Error("Activity failed");
      h.openActivity.mockRejectedValueOnce(failure);
      const failed = yield* Effect.promise(() =>
        h.run("").then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      );
      expect(failed).toBe(failure);
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
