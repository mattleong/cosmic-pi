import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { deferredPromise, extensionContextFixture, yieldUntil } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import {
  settingsSubcommand,
  withInvocationAuthority,
  type SettingsCommandOptions,
  type SettingsCommandOwner,
  type SettingsSession,
} from "../src/boundary/host-settings-command.ts";
import { OwnedSurfaceOutcome } from "../src/boundary/host-surface.ts";

interface DemoConfig {
  readonly mode: string;
}
type Options = SettingsCommandOptions<DemoConfig>;

const harness = (
  overrides: Partial<Options> = {},
  context: { readonly mode?: ExtensionContext["mode"]; readonly signal?: AbortSignal } = {},
  captureAuthority?: () => () => boolean,
) => {
  const notify = vi.fn();
  const apply = vi.fn<Options["apply"]>(() => Promise.resolve(Result.succeed(undefined)));
  const open = vi.fn<Options["open"]>(() =>
    Promise.resolve({ _tag: "Settled" as const, value: undefined }),
  );
  const create = (isCurrent = overrides.isCurrent ?? (() => true), owner?: SettingsCommandOwner) =>
    settingsSubcommand({
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
      open,
      ...overrides,
      isCurrent,
      ...(owner && { owner }),
    });
  const command = captureAuthority ? withInvocationAuthority(captureAuthority, create) : create();
  const ctx = extensionContextFixture({
    mode: context.mode ?? "tui",
    hasUI: true,
    signal: context.signal,
    ui: { notify, custom: () => Promise.reject(new Error("Custom UI is closed.")) },
  });
  const start = (args: string) => Promise.resolve(command.handler(args, ctx));
  const invoke = (args: string) => Effect.promise(() => start(args));
  const throwOnSignal = () =>
    Object.defineProperty(ctx, "signal", {
      configurable: true,
      get() {
        throw new Error("host-signal-secret");
      },
    });
  return { ctx, notify, apply, open, invoke, start, throwOnSignal };
};

describe("provider settings command shell", () => {
  it.effect(
    "orders different rows across invocation recreation and recovers after a rejected save",
    () =>
      Effect.gen(function* () {
        const pending = deferredPromise<Awaited<ReturnType<Options["apply"]>>>();
        const document = new Map<string, string>();
        let captured = 0;
        const h = harness(
          {
            descriptors: Arr.map(["mode", "other"], (id) => ({
              id,
              description: id,
              values: ["on", "off"],
              currentValue: () => "off",
            })),
          },
          {},
          () => {
            captured += 1;
            return () => true;
          },
        );
        h.apply.mockImplementation((_ctx, id, value) => {
          const before = new Map(document);
          if (value === "on") return pending.promise;
          return Promise.resolve().then(() => {
            document.clear();
            for (const [key, entry] of before) document.set(key, entry);
            document.set(id, value);
            return Result.succeed(undefined);
          });
        });
        const first = yield* h.invoke("mode on").pipe(Effect.forkScoped);
        yield* yieldUntil(() => h.apply.mock.calls.length === 1);
        const second = yield* h.invoke("other off").pipe(Effect.forkScoped);
        const last = yield* h.invoke("mode off").pipe(Effect.forkScoped);
        yield* yieldUntil(() => captured === 3);
        pending.reject(new Error("failed save"));
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        yield* Fiber.join(last);
        expect([...document]).toEqual([
          ["other", "off"],
          ["mode", "off"],
        ]);
        expect(Arr.some(h.notify.mock.calls, ([, level]) => level === "warning")).toBe(true);
      }),
  );

  it.effect("drops retired queued saves and lets a replacement bypass an unsettled old save", () =>
    Effect.gen(function* () {
      let activation = 1;
      let captures = 0;
      const pending = deferredPromise<Awaited<ReturnType<Options["apply"]>>>();
      const h = harness({}, {}, () => {
        captures += 1;
        const captured = activation;
        return () => activation === captured;
      });
      h.apply.mockReturnValueOnce(pending.promise);
      const first = yield* h.invoke("mode on").pipe(Effect.forkScoped);
      yield* yieldUntil(() => h.apply.mock.calls.length === 1);
      const queued = yield* h.invoke("mode off").pipe(Effect.forkScoped);
      yield* yieldUntil(() => captures === 2);
      activation = 2;
      yield* h.invoke("mode on");
      expect(Arr.map(h.apply.mock.calls, ([, , value]) => value)).toEqual(["on", "on"]);
      pending.resolve(Result.succeed(undefined));
      yield* Fiber.join(first);
      yield* Fiber.join(queued);
      expect(Arr.map(h.apply.mock.calls, ([, , value]) => value)).toEqual(["on", "on"]);
      expect(h.notify).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("a retained retired picker cannot break a live activation's save ordering", () =>
    Effect.gen(function* () {
      let activation = 1;
      let retiredApply: SettingsSession<DemoConfig>["apply"] | undefined;
      const closing = deferredPromise<Awaited<ReturnType<Options["open"]>>>();
      const pending = deferredPromise<Awaited<ReturnType<Options["apply"]>>>();
      const h = harness({}, {}, () => {
        const captured = activation;
        return () => captured === activation;
      });
      h.open.mockImplementationOnce((_ctx, session) => {
        retiredApply = session.apply;
        return closing.promise;
      });
      const oldPicker = yield* h.invoke("").pipe(Effect.forkScoped);
      yield* yieldUntil(() => retiredApply !== undefined);
      activation = 2;
      h.apply.mockReturnValueOnce(pending.promise);
      const first = yield* h.invoke("mode on").pipe(Effect.forkScoped);
      yield* yieldUntil(() => h.apply.mock.calls.length === 1);
      yield* Effect.promise(() => retiredApply?.("mode", "off") ?? Promise.resolve());
      const second = h.start("mode off");
      yield* Effect.yieldNow;
      expect(Arr.map(h.apply.mock.calls, ([, , value]) => value)).toEqual(["on"]);
      pending.resolve(Result.succeed(undefined));
      yield* Fiber.join(first);
      yield* Effect.promise(() => second);
      expect(Arr.map(h.apply.mock.calls, ([, , value]) => value)).toEqual(["on", "off"]);
      closing.resolve(OwnedSurfaceOutcome.Settled({ value: undefined }));
      yield* Fiber.join(oldPicker);
    }),
  );

  it.effect("rechecks authority in the callback that enters provider persistence", () =>
    Effect.gen(function* () {
      let activation = 1;
      const afterApply = vi.fn();
      const h = harness({ afterApply }, {}, () => {
        const captured = activation;
        return () => captured === activation;
      });
      const saving = h.start("mode on");
      queueMicrotask(() => {
        activation = 2;
      });
      yield* Effect.promise(() => saving);
      expect(h.apply).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
      expect(afterApply).not.toHaveBeenCalled();
      yield* h.invoke("mode off");
      expect(Arr.map(h.apply.mock.calls, ([, , value]) => value)).toEqual(["off"]);
      expect(afterApply).toHaveBeenCalledTimes(1);
    }),
  );

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
