import type {
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core";
import { createInputDock } from "./host-input-dock.ts";
import { createScreenViewport } from "./host-viewport.ts";

type OwnedSurfacePlacement = "screen" | "dock" | "inline" | "overlay";

export type OwnedSurfaceComponent = Component & Partial<Focusable> & { dispose?(): void };

export interface OwnedSurfaceHost<A> {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly getHeight: () => number;
  readonly finish: (value: A) => void;
}

export interface OwnedSurfaceOptions<A> {
  readonly placement: OwnedSurfacePlacement;
  readonly closedValue: A;
  readonly isCurrent?: () => boolean;
  readonly admit?: () => false | (() => void);
  readonly create: (host: OwnedSurfaceHost<A>) => OwnedSurfaceComponent;
  readonly onMounted?: (handle: OverlayHandle) => void;
  readonly onClose?: () => void;
  readonly onControl?: (close: () => void) => void;
}

export type OwnedSurfaceOutcome<A> = Data.TaggedEnum<{
  Settled: { readonly value: A };
  Blocked: Record<never, never>;
  Failed: { readonly cause: unknown };
}>;

interface OwnedSurfaceOutcomeDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: OwnedSurfaceOutcome<this["A"]>;
}

export const OwnedSurfaceOutcome = Data.taggedEnum<OwnedSurfaceOutcomeDefinition>();

export class OwnedSurfaceError extends Schema.TaggedError<OwnedSurfaceError>()(
  "OwnedSurfaceError",
  { reason: Schema.Literals(["blocked", "failed"]) },
) {}

export const hasCustomSurface = (ctx: {
  readonly mode: ExtensionContext["mode"];
  readonly ui: { readonly custom: unknown };
}): boolean =>
  invokeHostCallback(() => ctx.mode === "tui" && Predicate.isFunction(ctx.ui.custom), false);

const inert = (): OwnedSurfaceComponent => ({ render: () => [], invalidate() {} });
const attempt = (callback: (() => void) | undefined) =>
  invokeHostCallback(() => callback?.(), undefined);

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
    if (placement !== "inline" && (!tui || !handle)) return;
    doneInvoked = true;
    revoke();
    const { value } = requested;
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
      complete(OwnedSurfaceOutcome.Failed({ cause }));
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
    if (requested) return tryDone();
    if (!current()) return close();
    options.onMounted?.(owned);
  };

  try {
    options.onControl?.(close);
    const admitted = options.admit?.();
    if (admitted === false) {
      complete(OwnedSurfaceOutcome.Blocked());
      return close;
    }
    release = admitted;
    const opened = ctx.ui.custom<A>(
      factory,
      Match.value(placement).pipe(
        Match.when("inline", () => undefined),
        Match.when("overlay", () => ({ overlay: true, onHandle })),
        Match.orElse(() => ({
          overlay: true,
          overlayOptions: viewport?.overlayOptions ?? {
            anchor: "top-left",
            width: 1,
            maxHeight: 0,
          },
          onHandle,
        })),
      ),
    );
    void Promise.resolve(opened).then(
      (value) => complete(OwnedSurfaceOutcome.Settled({ value })),
      (cause: unknown) => complete(OwnedSurfaceOutcome.Failed({ cause })),
    );
  } catch (cause) {
    complete(OwnedSurfaceOutcome.Failed({ cause }));
  }
  return close;
}

export const openOwnedSurface = <A>(
  ctx: { readonly ui: ExtensionUIContext },
  options: OwnedSurfaceOptions<A>,
): Effect.Effect<A, OwnedSurfaceError> =>
  Effect.callback<A, OwnedSurfaceError>((resume) => {
    const close = mountOwnedSurface(ctx, options, (outcome) =>
      resume(
        OwnedSurfaceOutcome.$match(outcome, {
          Settled: ({ value }): Effect.Effect<A, OwnedSurfaceError> => Effect.succeed(value),
          Blocked: () => Effect.fail(new OwnedSurfaceError({ reason: "blocked" })),
          Failed: () => Effect.fail(new OwnedSurfaceError({ reason: "failed" })),
        }),
      ),
    );
    return Effect.sync(close);
  });

export const openOwnedSurfacePromise = <A>(
  ctx: { readonly ui: ExtensionUIContext },
  options: OwnedSurfaceOptions<A>,
): Promise<OwnedSurfaceOutcome<A>> =>
  Effect.runPromise(
    Effect.callback<OwnedSurfaceOutcome<A>>((resume) => {
      mountOwnedSurface(ctx, options, (outcome) => resume(Effect.succeed(outcome)));
    }),
  );

export const openCommandSurface = (
  ctx: { readonly ui: ExtensionUIContext },
  options: Omit<OwnedSurfaceOptions<undefined>, "closedValue">,
): Promise<void> =>
  openOwnedSurfacePromise<undefined>(ctx, { ...options, closedValue: undefined }).then(
    (outcome) => {
      if (OwnedSurfaceOutcome.$is("Failed")(outcome)) throw outcome.cause;
      return undefined;
    },
  );
