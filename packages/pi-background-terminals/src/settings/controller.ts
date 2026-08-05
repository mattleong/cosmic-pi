// Pi command and custom-UI handlers are Promise-shaped host boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  fullScreenKeybindingLabel,
  type FullScreenSelectionKeybindingId,
} from "pi-cosmic-ui/manager/keybindings";
import { startHostUiTicker, type BackgroundTerminalProjectionBridge } from "../boundary/host-ui.ts";
import { synchronousNow } from "../boundary/native-clock.ts";
import { ProcessManagerComponent } from "../ui/manager.ts";

export interface ProcessManagerActions {
  readonly stop: (id: string) => Promise<void>;
  readonly clear: () => Promise<void>;
}

async function openProcessManager(
  ctx: ExtensionCommandContext,
  bridge: BackgroundTerminalProjectionBridge,
  actions: ProcessManagerActions,
): Promise<void> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify("/ps requires interactive TUI mode.", "warning");
    return;
  }
  await ctx.ui.custom<void>(
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
            typeof keybindings.getKeys === "function"
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
