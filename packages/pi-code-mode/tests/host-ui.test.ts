import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vitest";
import {
  inputAtHostBoundary,
  openSettingsSurfaceAtHostBoundary,
  selectAtHostBoundary,
  type SettingsSurfaceResult,
} from "../src/boundary/host-ui.ts";
import { extensionContextFixture, opaqueHostFixture } from "./support/host.ts";

type HostFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: SettingsSurfaceResult) => void,
) => Component & { dispose?(): void };

const inert = (): Component => ({ render: () => [], invalidate: () => undefined });
const deferredPromise = <Value>(gate: Deferred.Deferred<Value>): Promise<Value> =>
  Effect.runPromise(Deferred.await(gate));
const tui: TUI = opaqueHostFixture({});
const theme: Theme = opaqueHostFixture({});
const keybindings: KeybindingsManager = opaqueHostFixture({});

describe("code mode host UI boundaries", () => {
  it.effect("forwards Effect-owned signals to select and input and aborts both", () =>
    Effect.gen(function* () {
      const selectStarted = Deferred.makeUnsafe<void>();
      const inputStarted = Deferred.makeUnsafe<void>();
      let selectSignal: AbortSignal | undefined;
      let inputSignal: AbortSignal | undefined;
      const ctx = extensionContextFixture({
        ui: {
          select: (_title: string, _options: string[], options?: { signal?: AbortSignal }) => {
            selectSignal = options?.signal;
            void Deferred.doneUnsafe(selectStarted, Effect.void);
            return Promise.race([]);
          },
          input: (_title: string, _placeholder?: string, options?: { signal?: AbortSignal }) => {
            inputSignal = options?.signal;
            void Deferred.doneUnsafe(inputStarted, Effect.void);
            return Promise.race([]);
          },
        },
      });

      const selecting = yield* selectAtHostBoundary(ctx, "scope", ["global"]).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(selectStarted);
      yield* Fiber.interrupt(selecting);
      expect(selectSignal?.aborted).toBe(true);

      const reading = yield* inputAtHostBoundary(ctx, "value").pipe(Effect.forkScoped);
      yield* Deferred.await(inputStarted);
      yield* Fiber.interrupt(reading);
      expect(inputSignal?.aborted).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts a live custom surface and closes it exactly once", () =>
    Effect.gen(function* () {
      const opened = Deferred.makeUnsafe<void>();
      const hostDone = vi.fn();
      let surfaceSignal: AbortSignal | undefined;
      const ctx = extensionContextFixture({
        ui: {
          custom: (factory: HostFactory) => {
            factory(tui, theme, keybindings, hostDone);
            void Deferred.doneUnsafe(opened, Effect.void);
            return Promise.race([]);
          },
        },
      });
      const opening = yield* openSettingsSurfaceAtHostBoundary(
        ctx,
        (_tui, _theme, _keys, done, signal) => {
          surfaceSignal = signal;
          return { ...inert(), handleInput: () => done({ _tag: "Closed" }) };
        },
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(opened);
      yield* Fiber.interrupt(opening);

      expect(surfaceSignal?.aborted).toBe(true);
      expect(hostDone).toHaveBeenCalledOnce();
      expect(hostDone).toHaveBeenCalledWith({ _tag: "Closed" });
    }).pipe(Effect.scoped),
  );

  it.effect("closes a late factory without granting callback authority", () =>
    Effect.gen(function* () {
      const customCalled = Deferred.makeUnsafe<void>();
      const hostDone = vi.fn();
      const realFactory = vi.fn(() => inert());
      let lateFactory: HostFactory | undefined;
      const ctx = extensionContextFixture({
        ui: {
          custom: (factory: HostFactory) => {
            lateFactory = factory;
            void Deferred.doneUnsafe(customCalled, Effect.void);
            return Promise.race([]);
          },
        },
      });
      const opening = yield* openSettingsSurfaceAtHostBoundary(ctx, realFactory).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(customCalled);
      yield* Fiber.interrupt(opening);

      const component = lateFactory?.(tui, theme, keybindings, hostDone);
      expect(realFactory).not.toHaveBeenCalled();
      expect(component?.render(80)).toEqual([]);
      expect(hostDone).toHaveBeenCalledOnce();
    }).pipe(Effect.scoped),
  );

  it.effect("finalizes before mapping a rejecting host to Failed", () =>
    Effect.gen(function* () {
      const hostDone = vi.fn();
      let surfaceSignal: AbortSignal | undefined;
      const ctx = extensionContextFixture({
        ui: {
          custom: (factory: HostFactory) => {
            factory(tui, theme, keybindings, hostDone);
            return Promise.reject(new Error("host rejected"));
          },
        },
      });
      const outcome = yield* openSettingsSurfaceAtHostBoundary(
        ctx,
        (_tui, _theme, _keys, _done, signal) => {
          surfaceSignal = signal;
          return inert();
        },
      );
      expect(outcome).toEqual({ _tag: "Failed" });
      expect(surfaceSignal?.aborted).toBe(true);
      expect(hostDone).toHaveBeenCalledOnce();
    }),
  );

  it.effect("keeps a normal PromptInteger result authoritative through finalization", () =>
    Effect.gen(function* () {
      const hostDone = vi.fn();
      let surfaceSignal: AbortSignal | undefined;
      const ctx = extensionContextFixture({
        ui: {
          custom: (factory: HostFactory) => {
            const completed = Deferred.makeUnsafe<SettingsSurfaceResult>();
            factory(tui, theme, keybindings, (result) => {
              hostDone(result);
              void Deferred.doneUnsafe(completed, Effect.succeed(result));
            });
            return deferredPromise(completed);
          },
        },
      });
      const outcome = yield* openSettingsSurfaceAtHostBoundary(
        ctx,
        (_tui, _theme, _keys, done, signal) => {
          surfaceSignal = signal;
          done({ _tag: "PromptInteger", id: "timeoutMs" });
          done({ _tag: "Closed" });
          return inert();
        },
      );

      expect(outcome).toEqual({ _tag: "PromptInteger", id: "timeoutMs" });
      expect(surfaceSignal?.aborted).toBe(true);
      expect(hostDone).toHaveBeenCalledOnce();
    }),
  );
});
