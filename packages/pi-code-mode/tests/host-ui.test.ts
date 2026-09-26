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
import { extensionContextFixture, opaqueFixture } from "pi-cosmic-core/testing";

type HostFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: SettingsSurfaceResult) => void,
) => Component & { dispose?(): void };

const inert = (): Component => ({ render: () => [], invalidate: () => undefined });
const tui: TUI = opaqueFixture({});
const theme: Theme = opaqueFixture({});
const keybindings: KeybindingsManager = opaqueFixture({});

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
});
