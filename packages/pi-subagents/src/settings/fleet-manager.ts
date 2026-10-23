import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import { notifyAtHostBoundary } from "pi-cosmic-core/host-session";
import { synchronousNow } from "pi-cosmic-core/platform/native-clock";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { hasCustomSurface, openOwnedSurface } from "pi-cosmic-ui/boundary/host-surface";
import { fullScreenKeybindingOptions } from "pi-cosmic-ui/manager/key-labels";
import { adaptiveHostRefreshTicker } from "../boundary/host-refresh-ticker.ts";
import type { SubagentProjectionBridge } from "../boundary/host-ui.ts";
import { SubagentFleetComponent } from "../ui/fleet.ts";
import { subagentUiRefreshCadence } from "../ui/refresh.ts";
import type { FleetManagerActions } from "./controller.ts";

export function openFleetManager(
  ctx: ExtensionCommandContext,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
): Promise<void> {
  if (!hasCustomSurface(ctx)) {
    if (ctx.hasUI)
      notifyAtHostBoundary(ctx, "Open Pi in an interactive terminal to use /subagents", "warning");
    return Promise.resolve();
  }
  if (!actions.isAvailable()) {
    notifyAtHostBoundary(
      ctx,
      "Subagents aren't running; run /reload, then reopen /subagents",
      "warning",
    );
    return Promise.resolve();
  }
  const owner = actions.captureModelRefresh();
  const isCurrent = () => owner.isCurrent() && !ctx.signal?.aborted;
  let closeSurface: () => void = Fn.constVoid;
  let dispose: () => void = Fn.constVoid;
  const surface = openOwnedSurface(ctx, {
    closedValue: undefined,
    placement: "screen",
    isCurrent,
    onControl: (close) => {
      closeSurface = close;
    },
    onClose: () => {
      dispose();
    },
    create: ({ tui, theme, keybindings, getHeight, finish }) => {
      let unsubscribe: () => void = Fn.constVoid;
      const manager = new SubagentFleetComponent({
        theme,
        getProjection: bridge.get,
        getHeight,
        getNow: synchronousNow,
        ...fullScreenKeybindingOptions(keybindings),
        requestRender: () => tui.requestRender(),
        close: () => finish(undefined),
        isCurrent,
        onDispose: () => {
          refreshTicker.dispose();
          unsubscribe();
        },
        actions: {
          stop: actions.stop,
          interrupt: actions.interrupt,
          resume: actions.resume,
          // Both modes share the send path, which answers a pending question or steers.
          message: (id, _mode, message, expected) => actions.send(id, message, expected),
          rename: actions.rename,
        },
      });
      const refreshTicker = adaptiveHostRefreshTicker({
        getCadence: () =>
          subagentUiRefreshCadence(bridge.get().runs, { includeTerminalAges: true }),
        startTicker: startHostUiTicker,
        requestRender: () => {
          if (isCurrent()) tui.requestRender();
          else closeSurface();
        },
      });
      dispose = () => manager.dispose();
      unsubscribe = bridge.subscribe(() => {
        if (!isCurrent()) return closeSurface();
        manager.invalidate();
        refreshTicker.sync();
        tui.requestRender();
      });
      return manager;
    },
  }).pipe(Effect.orDie);
  // The command's signal interrupts the surface, closing it even when an idle fleet has no refresh
  // or projection to notice. Retiring the session disposes its runtime, which interrupts the surface
  // as well; the refresh and projection checks above also close it. Both settle the command quietly.
  return owner
    .run(surface, ctx.signal ?? new AbortController().signal)
    .then(Fn.constVoid, (cause: unknown) => {
      if (isCurrent()) throw cause;
    });
}
