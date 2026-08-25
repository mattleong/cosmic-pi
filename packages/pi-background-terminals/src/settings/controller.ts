// Pi command and custom-UI handlers are Promise-shaped host boundaries.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { fullScreenKeybindingLabel } from "pi-cosmic-ui/manager/key-labels";
import type { FullScreenSelectionKeybindingId } from "pi-cosmic-ui/manager/keymap";
import type { BackgroundTerminalProjectionBridge } from "../boundary/host-ui.ts";
import { synchronousNow } from "pi-cosmic-core";
import { ProcessManagerComponent } from "../ui/manager.ts";

export interface ProcessManagerActions {
  readonly stop: (id: string) => Promise<void>;
  readonly clear: () => Promise<void>;
}

function openProcessManager(
  ctx: ExtensionCommandContext,
  bridge: BackgroundTerminalProjectionBridge,
  actions: ProcessManagerActions,
): Promise<void> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify("/ps requires interactive TUI mode.", "warning");
    return Promise.resolve();
  }
  return ctx.ui.custom<void>(
    (tui, theme, keybindings, done) => {
      const manager = new ProcessManagerComponent({
        theme,
        getProjection: bridge.get,
        getHeight: () => tui.terminal.rows,
        getNow: synchronousNow,
        matchesKeybinding: (data, id) => keybindings.matches(data, id),
        keybindingLabel: (id, fallback) =>
          fullScreenKeybindingLabel(
            id,
            fallback,
            keybindings.getKeys !== undefined
              ? (key: FullScreenSelectionKeybindingId) => keybindings.getKeys(key)
              : undefined,
          ),
        requestRender: () => tui.requestRender(),
        close: () => done(undefined),
        stop: (id) => void actions.stop(id).catch(() => undefined),
        clear: () => void actions.clear().catch(() => undefined),
      });
      const unsubscribe = bridge.subscribe(() => {
        manager.invalidate();
        tui.requestRender();
      });
      const stopSpinnerTicker = startHostUiTicker(160, () => {
        if (bridge.get().jobs.some((job) => job.state === "starting" || job.state === "running"))
          tui.requestRender();
      });
      return {
        render: (width) => manager.render(width),
        handleInput: (data) => manager.handleInput(data),
        invalidate: () => manager.invalidate(),
        dispose: () => {
          stopSpinnerTicker();
          unsubscribe();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
      },
    },
  );
}

export function registerProcessManagerCommand(
  pi: ExtensionAPI,
  bridge: BackgroundTerminalProjectionBridge,
  actions: ProcessManagerActions,
): void {
  pi.registerCommand("ps", {
    description: "Open the full-screen background process manager",
    handler: (_args, ctx) => openProcessManager(ctx, bridge, actions),
  });
}
