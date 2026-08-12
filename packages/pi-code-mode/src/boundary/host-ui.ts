/**
 * Package-local Pi UI host boundary for `/code-mode-settings`.
 *
 * Pi dialog and custom-surface APIs are Promise-shaped foreign code and may also throw
 * synchronously (hostile or stale hosts). Every adapter here resolves to a bounded plain
 * outcome instead of throwing or rejecting into extension code, so a hostile host callback
 * can never hang the session or escape a command handler.
 */
import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

/** Synchronous Pi render/list callbacks resolve to a neutral fallback when they throw. */
export { invokeHostCallback } from "pi-cosmic-core";

/** Outcome of a Promise-shaped Pi dialog at the host boundary. */
export type HostDialogResult =
  | { readonly _tag: "Answered"; readonly value: string }
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "Unavailable" };

const UNAVAILABLE: HostDialogResult = { _tag: "Unavailable" };

const settled = (value: unknown): HostDialogResult =>
  typeof value === "string" ? { _tag: "Answered", value } : { _tag: "Cancelled" };

/** True when the host exposes a callable custom-surface API; hostile accessors read as false. */
export function hasCustomSurface(ctx: ExtensionCommandContext): boolean {
  try {
    return typeof ctx.ui.custom === "function";
  } catch {
    return false;
  }
}

/** Guarded `ctx.ui.select`: missing APIs, synchronous throws, and rejections never escape. */
export function selectAtHostBoundary(
  ctx: ExtensionCommandContext,
  title: string,
  options: readonly string[],
): Promise<HostDialogResult> {
  try {
    const select = ctx.ui.select;
    if (typeof select !== "function") return Promise.resolve(UNAVAILABLE);
    return Promise.resolve(select.call(ctx.ui, title, [...options])).then(
      settled,
      () => UNAVAILABLE,
    );
  } catch {
    return Promise.resolve(UNAVAILABLE);
  }
}

/** Guarded `ctx.ui.input`: missing APIs, synchronous throws, and rejections never escape. */
export function inputAtHostBoundary(
  ctx: ExtensionCommandContext,
  title: string,
  placeholder?: string,
): Promise<HostDialogResult> {
  try {
    const input = ctx.ui.input;
    if (typeof input !== "function") return Promise.resolve(UNAVAILABLE);
    return Promise.resolve(input.call(ctx.ui, title, placeholder)).then(settled, () => UNAVAILABLE);
  } catch {
    return Promise.resolve(UNAVAILABLE);
  }
}

/** Factory shape accepted by the settings custom surface (`ctx.ui.custom<undefined>`). */
export type SettingsSurfaceFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: undefined) => void,
) => Component & { dispose?(): void };

export type HostSurfaceOutcome = "closed" | "failed";

/** Inert component handed to the host when the surface factory fails; every method is total. */
const neutralSurfaceComponent = (): ReturnType<SettingsSurfaceFactory> => ({
  render: () => [],
  invalidate: () => undefined,
  handleInput: () => undefined,
  dispose: () => undefined,
});

/**
 * Guarded `ctx.ui.custom`: a hostile TUI factory invocation, synchronous throw, or
 * rejected surface Promise resolves to `"failed"` so the caller can degrade with a
 * bounded warning instead of hanging or rethrowing.
 *
 * The host may invoke the factory later, outside this call stack, so the guard lives inside
 * the wrapped factory itself: a throwing caller factory yields an inert no-op component plus
 * a bounded failed outcome (after asking the host to close via the guarded `done`), and a
 * throwing host `done` callback stays contained wherever the caller invokes it.
 */
export function openSettingsSurfaceAtHostBoundary(
  ctx: ExtensionCommandContext,
  factory: SettingsSurfaceFactory,
): Promise<HostSurfaceOutcome> {
  let factoryFailed = false;
  const guardedFactory: SettingsSurfaceFactory = (tui, theme, keybindings, done) => {
    const guardedDone = (result: undefined): void => {
      try {
        done(result);
      } catch {
        // A hostile host `done` callback stays contained at the host boundary.
      }
    };
    try {
      return factory(tui, theme, keybindings, guardedDone);
    } catch {
      factoryFailed = true;
      // Close the broken surface if the host still honors `done`; rendering stays inert.
      guardedDone(undefined);
      return neutralSurfaceComponent();
    }
  };
  try {
    return Promise.resolve(ctx.ui.custom<undefined>(guardedFactory)).then(
      (): HostSurfaceOutcome => (factoryFailed ? "failed" : "closed"),
      (): HostSurfaceOutcome => "failed",
    );
  } catch {
    return Promise.resolve("failed");
  }
}
