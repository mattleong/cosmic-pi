/** Interruptible Pi dialog boundaries for `/code-mode-settings`. */
import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

export type HostDialogResult =
  | { readonly _tag: "Answered"; readonly value: string }
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "Unavailable" };

const UNAVAILABLE: HostDialogResult = { _tag: "Unavailable" };
const settled = <Value>(value: Value): HostDialogResult =>
  Predicate.isString(value) ? { _tag: "Answered", value } : { _tag: "Cancelled" };

const dialogAtHostBoundary = <Result>(
  ctx: ExtensionCommandContext,
  invoke: (ui: ExtensionCommandContext["ui"], signal: AbortSignal) => Promise<Result>,
): Effect.Effect<HostDialogResult> =>
  Effect.tryPromise((signal) => invoke(ctx.ui, signal)).pipe(
    Effect.map(settled),
    Effect.catch(() => Effect.succeed(UNAVAILABLE)),
  );

/** Guarded `ctx.ui.select`; Effect interruption dismisses the host dialog. */
export const selectAtHostBoundary = (
  ctx: ExtensionCommandContext,
  title: string,
  options: readonly string[],
): Effect.Effect<HostDialogResult> =>
  dialogAtHostBoundary(ctx, (ui, signal) => ui.select(title, [...options], { signal }));

/** Guarded `ctx.ui.input`; Effect interruption dismisses the host dialog. */
export const inputAtHostBoundary = (
  ctx: ExtensionCommandContext,
  title: string,
  placeholder?: string,
): Effect.Effect<HostDialogResult> =>
  dialogAtHostBoundary(ctx, (ui, signal) => ui.input(title, placeholder, { signal }));

export type SettingsSurfaceResult =
  | { readonly _tag: "Closed" }
  | { readonly _tag: "PromptInteger"; readonly id: string };

export type HostSurfaceOutcome = SettingsSurfaceResult | { readonly _tag: "Failed" };

export type SettingsSurfaceFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: SettingsSurfaceResult) => void,
  signal: AbortSignal,
) => Component & { dispose?(): void };

const CLOSED: SettingsSurfaceResult = { _tag: "Closed" };
const FAILED: HostSurfaceOutcome = { _tag: "Failed" };

const neutralSurfaceComponent = (): ReturnType<SettingsSurfaceFactory> => ({
  render: () => [],
  invalidate: () => undefined,
  handleInput: () => undefined,
  dispose: () => undefined,
});

/**
 * Pi's custom editor has no signal option. This boundary aborts callback authority and closes
 * the editor exactly once when the owning Effect settles or is interrupted.
 */
export const openSettingsSurfaceAtHostBoundary = (
  ctx: ExtensionCommandContext,
  factory: SettingsSurfaceFactory,
): Effect.Effect<HostSurfaceOutcome> =>
  Effect.suspend(() => {
    const surface = new AbortController();
    let closing = false;
    let factoryInvoked = false;
    let doneInvoked = false;
    let hostDone: ((result: SettingsSurfaceResult) => void) | undefined;

    const finish = (result: SettingsSurfaceResult): void => {
      if (doneInvoked || hostDone === undefined) return;
      doneInvoked = true;
      try {
        hostDone(result);
      } catch {
        // A hostile host callback cannot escape the finalizer.
      }
    };
    const close = (): void => {
      closing = true;
      try {
        surface.abort();
      } catch {
        // Best effort at the foreign UI boundary.
      }
      finish(CLOSED);
    };
    const guardedFactory = (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: SettingsSurfaceResult) => void,
    ): ReturnType<SettingsSurfaceFactory> => {
      if (factoryInvoked) {
        close();
        return neutralSurfaceComponent();
      }
      factoryInvoked = true;
      hostDone = done;
      if (closing) {
        close();
        return neutralSurfaceComponent();
      }
      return factory(tui, theme, keybindings, finish, surface.signal);
    };

    return Effect.tryPromise(() => ctx.ui.custom<SettingsSurfaceResult>(guardedFactory)).pipe(
      Effect.ensuring(Effect.sync(close)),
      Effect.catch(() => Effect.succeed(FAILED)),
    );
  });
