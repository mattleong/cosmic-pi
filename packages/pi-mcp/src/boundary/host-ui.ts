import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { invokeHostCallback } from "pi-cosmic-core";
import { createScreenViewport } from "pi-cosmic-ui/boundary/host-viewport";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";

export interface McpOverlayHost<A> {
  readonly tui: TUI;
  readonly getHeight: () => number;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly signal: AbortSignal;
  readonly finish: (value?: A) => void;
}
type OwnedComponent = Component & Partial<Focusable> & { dispose?: () => void };
const neutral = (): Component => ({ render: () => [], invalidate() {} });

/** Pi's custom done pops globally. Never call it without an owned inert guard. */
export const openMcpOverlay = <A>(
  ctx: ExtensionContext,
  current: () => boolean,
  factory: (host: McpOverlayHost<A>) => OwnedComponent,
): Effect.Effect<A | undefined, McpBoundaryError> =>
  Effect.suspend(() => {
    if (!invokeHostCallback(() => ctx.mode === "tui" && current(), false))
      return Effect.fail(
        boundaryError("unavailable", "not-sent", "MCP view requires the active TUI session."),
      );
    const viewport = createScreenViewport();
    const controller = new AbortController();
    let closing = false;
    let factoryInvoked = false;
    let doneInvoked = false;
    let disposed = false;
    let requested: { readonly value: A | undefined } | undefined;
    let hostDone: ((value: A | undefined) => void) | undefined;
    let hostTui: TUI | undefined;
    let overlay: OverlayHandle | undefined;
    let component: OwnedComponent | undefined;
    let fail: (() => void) | undefined;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      invokeHostCallback(() => component?.dispose?.(), undefined);
    };
    const finish = (value?: A) => {
      requested ??= { value };
      if (doneInvoked || !hostDone || !hostTui || !overlay) return;
      doneInvoked = true;
      dispose();
      try {
        overlay.hide();
        const guard = hostTui.showOverlay(neutral(), { nonCapturing: true });
        try {
          hostDone(requested.value);
        } finally {
          guard.hide();
        }
      } catch {
        fail?.();
      }
    };
    const close = () => {
      closing = true;
      invokeHostCallback(() => controller.abort(), undefined);
      dispose();
      finish();
    };
    return Effect.callback<A | undefined, McpBoundaryError>((resume) => {
      fail = () =>
        resume(
          Effect.fail(
            boundaryError("unavailable", "not-sent", "MCP view could not be closed safely."),
          ),
        );
      try {
        ctx.ui
          .custom<A | undefined>(
            (tui, theme, keybindings, done) => {
              if (factoryInvoked) {
                close();
                return neutral();
              }
              factoryInvoked = true;
              hostDone = done;
              hostTui = tui;
              if (closing || !invokeHostCallback(current, false)) {
                close();
                return neutral();
              }
              viewport.attach(() => tui.terminal);
              component = factory({
                tui,
                getHeight: viewport.getHeight,
                theme,
                keybindings,
                signal: controller.signal,
                finish: (value) => {
                  if (!closing && invokeHostCallback(current, false)) finish(value);
                  else close();
                },
              });
              const view = component;
              return {
                render: (width) =>
                  disposed || !invokeHostCallback(current, false) ? [] : view.render(width),
                invalidate: () => {
                  if (!disposed) view.invalidate();
                },
                handleInput: (data) => {
                  if (!disposed && !closing) view.handleInput?.(data);
                },
                handleMouse: (event) =>
                  disposed || closing ? undefined : view.handleMouse?.(event),
                get focused() {
                  return view.focused ?? false;
                },
                set focused(value: boolean) {
                  view.focused = value;
                },
                dispose,
              };
            },
            {
              overlay: true,
              overlayOptions: viewport.overlayOptions,
              onHandle: (handle) => {
                if (doneInvoked) {
                  invokeHostCallback(() => handle.hide(), undefined);
                  return;
                }
                overlay = handle;
                if (closing || requested || !invokeHostCallback(current, false))
                  finish(requested?.value);
              },
            },
          )
          .then(
            (value) => resume(Effect.succeed(value)),
            () => fail?.(),
          );
      } catch {
        fail();
      }
    }).pipe(Effect.ensuring(Effect.sync(close)));
  });

export const confirmMcpAction = (ctx: ExtensionContext, text: string, current: () => boolean) =>
  Effect.tryPromise({
    try: (signal) =>
      current() ? ctx.ui.confirm("MCP confirmation", text, { signal }) : Promise.resolve(false),
    catch: () => boundaryError("unavailable", "not-sent", "MCP confirmation is unavailable."),
  });
