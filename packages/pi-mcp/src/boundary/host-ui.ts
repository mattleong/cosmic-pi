import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { invokeHostCallback } from "pi-cosmic-core";
import {
  openOwnedSurface,
  type OwnedSurfaceComponent,
  type OwnedSurfaceHost,
} from "pi-cosmic-ui/boundary/host-surface";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";

export type McpOverlayHost<A> = OwnedSurfaceHost<A | undefined>;

/** A full-screen MCP view on the shared owned surface. Its component is disposed before
 * Pi's `done`, and it stops rendering once disposed or no longer current. */
export const openMcpOverlay = <A>(
  ctx: ExtensionContext,
  current: () => boolean,
  factory: (host: McpOverlayHost<A>) => OwnedSurfaceComponent,
): Effect.Effect<A | undefined, McpBoundaryError> =>
  Effect.suspend(() => {
    if (!invokeHostCallback(() => ctx.mode === "tui" && current(), false))
      return Effect.fail(
        boundaryError("unavailable", "not-sent", "MCP view requires the active TUI session."),
      );
    let view: OwnedSurfaceComponent | undefined;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      invokeHostCallback(() => view?.dispose?.(), undefined);
    };
    return openOwnedSurface<A | undefined>(ctx, {
      placement: "screen",
      closedValue: undefined,
      isCurrent: current,
      onClose: dispose,
      create: (host) => {
        const component = factory(host);
        view = component;
        return {
          render: (width) =>
            disposed || !invokeHostCallback(current, false) ? [] : component.render(width),
          invalidate: () => {
            if (!disposed) component.invalidate();
          },
          handleInput: (data) => {
            if (!disposed) component.handleInput?.(data);
          },
          handleMouse: (event) => (disposed ? undefined : component.handleMouse?.(event)),
          get focused() {
            return component.focused ?? false;
          },
          set focused(value: boolean) {
            component.focused = value;
          },
          dispose,
        };
      },
    }).pipe(
      Effect.mapError(() =>
        boundaryError("unavailable", "not-sent", "MCP view could not be closed safely."),
      ),
    );
  });

export const confirmMcpAction = (ctx: ExtensionContext, text: string, current: () => boolean) =>
  Effect.tryPromise({
    try: (signal) =>
      current() ? ctx.ui.confirm("MCP confirmation", text, { signal }) : Promise.resolve(false),
    catch: () => boundaryError("unavailable", "not-sent", "MCP confirmation is unavailable."),
  });
