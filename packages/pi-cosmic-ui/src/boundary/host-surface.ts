import type {
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core";
import { createInputDock } from "./host-input-dock.ts";
import { createScreenViewport } from "./host-viewport.ts";

/**
 * - `screen`: a viewport-sized overlay with live bounds.
 * - `dock`: the above-editor input dock with a keyboard-only overlay.
 * - `inline`: the editor slot; closes directly, with no overlay guard.
 * - `overlay`: a plain component-sized overlay.
 */
type OwnedSurfacePlacement = "screen" | "dock" | "inline" | "overlay";

export type OwnedSurfaceComponent = Component & Partial<Focusable> & { dispose?(): void };

export interface OwnedSurfaceHost<A> {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  /** The placement's allocated height. */
  readonly getHeight: () => number;
  /** Requests completion; the first request wins and a stale owner closes instead. */
  readonly finish: (value: A) => void;
}

export interface OwnedSurfaceOptions<A> {
  readonly placement: OwnedSurfacePlacement;
  /** The result of any close that no `finish` requested. */
  readonly closedValue: A;
  /** Checked when the factory runs, on mount, and on each `finish`. */
  readonly isCurrent?: () => boolean;
  /** Runs in the same synchronous frame as `ctx.ui.custom`. False blocks the opening;
   * a returned release runs once when the surface closes, after Pi's `done`. */
  readonly admit?: () => false | (() => void);
  readonly create: (host: OwnedSurfaceHost<A>) => OwnedSurfaceComponent;
  /** The mounted handle (dock-wrapped for `dock`); skipped once a finish or close came first. */
  readonly onMounted?: (handle: OverlayHandle) => void;
  /** Runs once as closing begins, before Pi's `done`. Revoke callback authority only. */
  readonly onClose?: () => void;
  /** Receives the external close synchronously, before `ctx.ui.custom`. */
  readonly onControl?: (close: () => void) => void;
}

export type OwnedSurfaceOutcome<A> =
  | { readonly _tag: "Settled"; readonly value: A }
  | { readonly _tag: "Blocked" }
  | { readonly _tag: "Failed"; readonly cause: unknown };

export class OwnedSurfaceError extends Schema.TaggedError<OwnedSurfaceError>()(
  "OwnedSurfaceError",
  { reason: Schema.Literals(["blocked", "failed"]) },
) {}

/** Fail-closed check for an interactive TUI that supports custom surfaces. */
export const hasCustomSurface = (ctx: Pick<ExtensionContext, "mode" | "ui">): boolean =>
  invokeHostCallback(() => ctx.mode === "tui" && Predicate.isFunction(ctx.ui.custom), false);

const inert = (): OwnedSurfaceComponent => ({ render: () => [], invalidate() {} });
const attempt = (callback: (() => void) | undefined) =>
  invokeHostCallback(() => callback?.(), undefined);

/**
 * Owns one `ctx.ui.custom` opening. Pinned Pi closes an overlay by popping the top of the
 * global stack, so an overlay closes by hiding its own handle, showing an inert
 * non-capturing guard, calling `done`, then hiding the guard. `settle` runs exactly once,
 * after the surface has closed. The returned `close` is synchronous and idempotent.
 */
function mountOwnedSurface<A>(
  ctx: { readonly ui: ExtensionUIContext },
  options: OwnedSurfaceOptions<A>,
  settle: (outcome: OwnedSurfaceOutcome<A>) => void,
): () => void {
  const { placement } = options;
  const dock = placement === "dock" ? createInputDock(ctx.ui) : undefined;
  const viewport = placement === "screen" ? createScreenViewport() : undefined;
  const current = () => invokeHostCallback(() => options.isCurrent?.() ?? true, false);
  let closing = false;
  let settled = false;
  let factoryInvoked = false;
  let doneInvoked = false;
  let requested: { readonly value: A } | undefined;
  let hostDone: ((value: A) => void) | undefined;
  let hostTui: TUI | undefined;
  let owned: OverlayHandle | undefined;
  let release: (() => void) | undefined;

  const revoke = () => {
    if (closing) return;
    closing = true;
    attempt(options.onClose);
  };
  const complete = (outcome: OwnedSurfaceOutcome<A>) => {
    if (settled) return;
    settled = true;
    close();
    settle(outcome);
  };
  const tryDone = () => {
    const done = hostDone;
    const tui = hostTui;
    const handle = owned;
    if (doneInvoked || !requested || !done) return;
    // Overlay placements wait for their mounted handle; inline never receives one.
    if (placement !== "inline" && (!tui || !handle)) return;
    doneInvoked = true;
    revoke();
    const { value } = requested;
    // Inline closes the editor slot directly; a throwing `done` leaves Pi's Promise in charge.
    if (!tui || !handle) return attempt(() => done(value));
    try {
      handle.hide();
      const guard = tui.showOverlay(inert(), { nonCapturing: true });
      try {
        done(value);
      } finally {
        guard.hide();
      }
    } catch (cause) {
      // Pi's Promise may stay pending; never retry an unguarded global pop.
      complete({ _tag: "Failed", cause });
    }
  };
  const close = () => {
    revoke();
    requested ??= { value: options.closedValue };
    tryDone();
    attempt(dock?.dispose);
    const released = release;
    release = undefined;
    attempt(released);
  };
  const finish = (value: A) => {
    if (closing) return;
    if (!current()) return close();
    requested ??= { value };
    tryDone();
  };
  const factory = (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (value: A) => void,
  ) => {
    if (factoryInvoked) {
      close();
      return inert();
    }
    factoryInvoked = true;
    hostDone = done;
    hostTui = tui;
    if (closing || !current()) {
      close();
      return inert();
    }
    viewport?.attach(() => tui.terminal);
    const getHeight = dock?.getHeight ?? viewport?.getHeight ?? (() => tui.terminal.rows);
    const component = options.create({ tui, theme, keybindings, getHeight, finish });
    if (!dock) return component;
    dock.mount(tui, component);
    return dock.input;
  };
  const onHandle = (handle: OverlayHandle) => {
    owned = dock ? dock.handle(handle) : handle;
    // Every close records a request, so a request covers a close before mount.
    if (requested) return tryDone();
    if (!current()) return close();
    options.onMounted?.(owned);
  };

  try {
    options.onControl?.(close);
    const admitted = options.admit?.();
    if (admitted === false) {
      complete({ _tag: "Blocked" });
      return close;
    }
    release = admitted;
    const opened = ctx.ui.custom<A>(
      factory,
      placement === "inline"
        ? undefined
        : placement === "overlay"
          ? { overlay: true, onHandle }
          : {
              overlay: true,
              overlayOptions: viewport?.overlayOptions ?? {
                anchor: "top-left",
                width: 1,
                maxHeight: 0,
              },
              onHandle,
            },
    );
    void Promise.resolve(opened).then(
      (value) => complete({ _tag: "Settled", value }),
      (cause) => complete({ _tag: "Failed", cause }),
    );
  } catch (cause) {
    complete({ _tag: "Failed", cause });
  }
  return close;
}

/** Effect door: interruption closes the surface; blocked and failed openings are typed. */
export const openOwnedSurface = <A>(
  ctx: { readonly ui: ExtensionUIContext },
  options: OwnedSurfaceOptions<A>,
): Effect.Effect<A, OwnedSurfaceError> =>
  Effect.callback<A, OwnedSurfaceError>((resume) => {
    const close = mountOwnedSurface(ctx, options, (outcome) =>
      resume(
        outcome._tag === "Settled"
          ? Effect.succeed(outcome.value)
          : Effect.fail(
              new OwnedSurfaceError({ reason: outcome._tag === "Blocked" ? "blocked" : "failed" }),
            ),
      ),
    );
    return Effect.sync(close);
  });

/** Promise door for Promise-shaped commands; callers map `Blocked` and `Failed` explicitly. */
export const openOwnedSurfacePromise = <A>(
  ctx: { readonly ui: ExtensionUIContext },
  options: OwnedSurfaceOptions<A>,
): Promise<OwnedSurfaceOutcome<A>> =>
  Effect.runPromise(
    Effect.callback<OwnedSurfaceOutcome<A>>((resume) => {
      mountOwnedSurface(ctx, options, (outcome) => resume(Effect.succeed(outcome)));
    }),
  );

/** A command's view: settles once closed and, as Pi's own custom Promise does, rejects a failed opening. */
export const openCommandSurface = (
  ctx: { readonly ui: ExtensionUIContext },
  options: Omit<OwnedSurfaceOptions<undefined>, "closedValue">,
): Promise<void> =>
  openOwnedSurfacePromise<undefined>(ctx, { ...options, closedValue: undefined }).then(
    (outcome) => {
      if (outcome._tag === "Failed") throw outcome.cause;
    },
  );
