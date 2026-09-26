// Pi command and custom-UI handlers are Promise-shaped host boundaries.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { notifyAtHostBoundary, sanitizeTerminalLine, synchronousNow } from "pi-cosmic-core";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { openOwnedSurfacePromise } from "pi-cosmic-ui/boundary/host-surface";
import { fullScreenKeybindingOptions } from "pi-cosmic-ui/manager/key-labels";
import type { BackgroundTaskProjectionBridge } from "../boundary/host-ui.ts";
import type { BackgroundTaskConfig } from "../config/schema.ts";
import { TaskManagerComponent } from "../ui/manager.ts";

export interface TaskManagerActions {
  readonly stop: (id: string) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export interface TaskManagerCommandActions extends TaskManagerActions {
  readonly status: () => Promise<BackgroundTaskConfig>;
}

type TaskManagerActionFailure = Error | undefined;

function notifyActionFailure(
  ctx: ExtensionCommandContext,
  action:
    | "stop background task"
    | "clear completed background tasks"
    | "show effective background task settings",
  failure: TaskManagerActionFailure,
): void {
  const message = failure instanceof Error ? sanitizeTerminalLine(failure.message) : "";
  const detail = message ? ` ${message}` : "";
  notifyAtHostBoundary(ctx, `Could not ${action}.${detail}`, "error");
}

function formatEffectiveSettings(config: BackgroundTaskConfig): string {
  const shellPath = config.shellPath
    ? sanitizeTerminalLine(config.shellPath) || "platform default"
    : "platform default";
  return [
    "Background Tasks effective settings",
    `enabled: ${config.enabled}`,
    `maxRunning: ${config.maxRunning}`,
    `maxRetained: ${config.maxRetained}`,
    `logBufferBytesPerTask: ${config.logBufferBytesPerTask}`,
    `totalLogBufferBytes: ${config.totalLogBufferBytes}`,
    `stopGraceMs: ${config.stopGraceMs}`,
    `maxWaitSeconds: ${config.maxWaitSeconds}`,
    `showFooterStatus: ${config.showFooterStatus}`,
    `shellPath: ${shellPath}`,
  ].join("\n");
}

function showTaskStatus(
  ctx: ExtensionCommandContext,
  actions: TaskManagerCommandActions,
): Promise<void> {
  if (!ctx.hasUI) return Promise.resolve();
  return actions
    .status()
    .then((config) => {
      notifyAtHostBoundary(ctx, formatEffectiveSettings(config), "info");
    })
    .catch((failure) =>
      notifyActionFailure(ctx, "show effective background task settings", failure),
    );
}

function openTaskManager(
  ctx: ExtensionCommandContext,
  bridge: BackgroundTaskProjectionBridge,
  actions: TaskManagerActions,
): Promise<void> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI)
      notifyAtHostBoundary(
        ctx,
        "Open Pi in an interactive terminal to view background tasks with /tasks.",
        "warning",
      );
    return Promise.resolve();
  }
  return openOwnedSurfacePromise<undefined>(ctx, {
    placement: "screen",
    closedValue: undefined,
    create: ({ tui, theme, keybindings, getHeight, finish }) => {
      const manager = new TaskManagerComponent({
        theme,
        getProjection: bridge.get,
        getHeight,
        getNow: synchronousNow,
        ...fullScreenKeybindingOptions(keybindings),
        requestRender: () => tui.requestRender(),
        close: () => finish(undefined),
        stop: (id) =>
          void actions
            .stop(id)
            .catch((failure) => notifyActionFailure(ctx, "stop background task", failure)),
        clear: () =>
          void actions
            .clear()
            .catch((failure) =>
              notifyActionFailure(ctx, "clear completed background tasks", failure),
            ),
      });
      const unsubscribe = bridge.subscribe(() => {
        manager.invalidate();
        tui.requestRender();
      });
      const stopSpinnerTicker = startHostUiTicker(160, () => {
        if (
          bridge.get().tasks.some((task) => task.state === "starting" || task.state === "running")
        )
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
  }).then((outcome) => {
    // A failed opening rejects the command, as Pi's own custom Promise does.
    if (outcome._tag === "Failed") throw outcome.cause;
  });
}

export function registerTaskManagerCommand(
  pi: ExtensionAPI,
  bridge: BackgroundTaskProjectionBridge,
  actions: TaskManagerCommandActions,
): void {
  pi.registerCommand("tasks", {
    description: "Open the background task manager or show effective settings with /tasks status",
    handler: (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "status") return showTaskStatus(ctx, actions);
      return openTaskManager(ctx, bridge, actions);
    },
  });
}
