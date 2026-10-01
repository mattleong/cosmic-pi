import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { deferredPromise, extensionContextFixture, yieldUntil } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import {
  settingsSubcommand,
  type SettingsCommandOptions,
} from "../src/boundary/host-settings-command.ts";

interface DemoConfig {
  readonly mode: string;
}
type Options = SettingsCommandOptions<DemoConfig>;

const harness = (
  overrides: Partial<Options> = {},
  context: { readonly mode?: string; readonly signal?: AbortSignal } = {},
) => {
  const notify = vi.fn();
  const apply = vi.fn<Options["apply"]>(() => Promise.resolve(Result.succeed(undefined)));
  const open = vi.fn<Options["open"]>(() =>
    Promise.resolve({ _tag: "Settled" as const, value: undefined }),
  );
  const command = settingsSubcommand({
    root: "demo",
    description: "Configure the demo provider",
    title: "Demo",
    descriptors: [
      {
        id: "mode",
        description: "Demo mode.",
        values: ["on", "off"],
        currentValue: (cfg: DemoConfig) => cfg.mode,
      },
    ],
    examples: ["mode on"],
    config: () => undefined,
    status: () => "demo diagnostics",
    apply,
    afterApply: () => undefined,
    open,
    ...overrides,
  });
  const ctx = extensionContextFixture({
    mode: context.mode ?? "tui",
    hasUI: true,
    signal: context.signal,
    ui: { notify, custom: () => Promise.resolve(undefined) },
  });
  const invoke = (args: string) =>
    Effect.promise(() => Promise.resolve(command.handler(args, ctx)));
  const throwOnSignal = () =>
    Object.defineProperty(ctx, "signal", {
      configurable: true,
      get() {
        throw new Error("host-signal-secret");
      },
    });
  return { ctx, notify, apply, open, invoke, throwOnSignal };
};

describe("provider settings command shell", () => {
  for (const outcome of ["success", "typed failure", "rejection"] as const) {
    it.effect(
      `retired ${outcome} cannot notify, redraw or run afterApply on a frozen host context`,
      () =>
        Effect.gen(function* () {
          let current = true;
          const pending = deferredPromise<Awaited<ReturnType<Options["apply"]>>>();
          const afterApply = vi.fn();
          const h = harness({ isCurrent: () => current, afterApply });
          Object.freeze(h.ctx.ui);
          Object.freeze(h.ctx);
          h.apply.mockReturnValueOnce(pending.promise);
          const work = yield* h.invoke("mode on").pipe(Effect.forkScoped);
          yield* yieldUntil(() => h.apply.mock.calls.length === 1);
          current = false;
          if (outcome === "rejection") pending.reject(new Error("unavailable"));
          else
            pending.resolve(
              outcome === "success"
                ? Result.succeed(undefined)
                : Result.fail({ message: "unavailable" }),
            );
          yield* Fiber.join(work);
          expect(h.notify).not.toHaveBeenCalled();
          expect(afterApply).not.toHaveBeenCalled();
        }),
    );
  }

  for (const operation of ["status", "picker"] as const) {
    it.effect(`retirement suppresses a delayed ${operation} notification`, () =>
      Effect.gen(function* () {
        let current = true;
        let started = false;
        const status = deferredPromise<string>();
        const picker = deferredPromise<Awaited<ReturnType<Options["open"]>>>();
        const h = harness({
          isCurrent: () => current,
          status: () => {
            started = true;
            return status.promise;
          },
          open: () => {
            started = true;
            return picker.promise;
          },
        });
        const work = yield* h
          .invoke(operation === "status" ? "status" : "")
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => started);
        current = false;
        status.resolve("diagnostics");
        picker.resolve({ _tag: "Failed", cause: undefined });
        yield* Fiber.join(work);
        expect(h.notify).not.toHaveBeenCalled();
      }),
    );
  }

  it.effect("answers help, status, and invalid input without config or apply", () =>
    Effect.gen(function* () {
      let failStatus = false;
      const h = harness({
        status: () => {
          if (failStatus) throw new Error("status-secret");
          return "demo status";
        },
      });
      yield* h.invoke("help");
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("mode"), "info");
      yield* h.invoke("status");
      expect(h.notify).toHaveBeenLastCalledWith("demo status", "info");
      failStatus = true;
      yield* h.invoke("status");
      expect(h.notify).toHaveBeenLastCalledWith(expect.not.stringContaining("secret"), "warning");
      yield* h.invoke("unknown on");
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("unknown"), "warning");
      yield* h.invoke("mode");
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Usage"), "warning");
      yield* h.invoke("mode maybe");
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("mode"), "warning");
      h.open.mockResolvedValueOnce({ _tag: "Blocked" });
      yield* h.invoke("");
      expect(h.notify).toHaveBeenLastCalledWith(expect.any(String), "warning");
      expect(h.apply).not.toHaveBeenCalled();

      const headless = harness({}, { mode: "rpc" });
      yield* headless.invoke("");
      expect(headless.open).not.toHaveBeenCalled();
      expect(headless.notify).toHaveBeenLastCalledWith(expect.stringContaining("mode"), "info");
    }),
  );

  it.effect("binds the signal by the provider's policy", () =>
    Effect.gen(function* () {
      const required = harness();
      required.throwOnSignal();
      yield* required.invoke("mode on");
      yield* required.invoke("");
      expect(required.apply).not.toHaveBeenCalled();
      expect(required.open).not.toHaveBeenCalled();
      expect(required.notify).toHaveBeenLastCalledWith(expect.any(String), "warning");

      const optional = harness({ signal: "optional" });
      optional.throwOnSignal();
      yield* optional.invoke("mode on");
      expect(optional.apply.mock.calls.map(([, id, value, signal]) => [id, value, signal])).toEqual(
        [["mode", "on", undefined]],
      );

      const aborted = harness({ signal: "optional" }, { signal: AbortSignal.abort() });
      aborted.apply.mockRejectedValueOnce(new Error("interrupted"));
      yield* aborted.invoke("mode on");
      expect(aborted.notify).not.toHaveBeenCalled();

      // A required signal stays the opening one; an optional one is reread for each picker apply.
      const opening = AbortSignal.abort("opening");
      const later = AbortSignal.abort("later");
      for (const policy of ["required", "optional"] as const) {
        const h = harness({ signal: policy }, { signal: opening });
        h.open.mockImplementationOnce((_ctx, session) => {
          Object.defineProperty(h.ctx, "signal", { configurable: true, value: later });
          return session
            .apply("mode", "on")
            .then(() => ({ _tag: "Settled" as const, value: undefined }));
        });
        yield* h.invoke("");
        expect(h.apply.mock.calls[0]?.[3]).toBe(policy === "optional" ? later : opening);
      }
    }),
  );

  it.effect("applies a named scope, the default scope, and open values the provider checks", () =>
    Effect.gen(function* () {
      const h = harness({
        scopes: [
          { name: "global", description: "Everywhere" },
          { name: "project", description: "This project" },
        ],
        scopeBlocked: (_ctx, scope) =>
          scope === "project" ? "Trust the project first" : undefined,
        descriptors: [
          {
            id: "limit",
            description: "A limit.",
            values: ["10", "20"],
            openValues: true,
            currentValue: () => "10",
          },
        ],
      });
      yield* h.invoke("limit 15");
      yield* h.invoke("global limit 20");
      expect(h.apply.mock.calls.map(([, id, value, , scope]) => [id, value, scope])).toEqual([
        ["limit", "15", "global"],
        ["limit", "20", "global"],
      ]);
      yield* h.invoke("project limit 20");
      expect(h.apply).toHaveBeenCalledTimes(2);
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Trust"), "warning");
    }),
  );

  it.effect("refuses a blocked scope from a picker and restores its row", () =>
    Effect.gen(function* () {
      let trusted = true;
      const shown: string[] = [];
      const h = harness({
        scopes: [
          { name: "global", description: "Everywhere" },
          { name: "project", description: "This project" },
        ],
        scopeBlocked: (_ctx, scope) =>
          scope === "project" && !trusted ? "Trust the project first" : undefined,
        config: () => ({ mode: "off" }),
      });
      h.open.mockImplementationOnce((_ctx, session) => {
        // Trust is withdrawn while the picker is open.
        trusted = false;
        return session
          .apply("mode", "on", (value) => void shown.push(value), "project")
          .then(() => ({ _tag: "Settled" as const, value: undefined }));
      });
      yield* h.invoke("");
      expect(h.apply).not.toHaveBeenCalled();
      expect(shown).toEqual(["off"]);
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Trust"), "warning");
    }),
  );
});
