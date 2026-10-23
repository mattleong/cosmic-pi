import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import {
  failureMessage,
  notifyAtHostBoundary,
  registerExtensionCommand,
  sanitizeTerminalLine,
  synchronousNow,
} from "pi-cosmic-core";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { openCommandSurface } from "pi-cosmic-ui/boundary/host-surface";
import { SPINNER_FRAME_MS } from "pi-cosmic-ui/manager";
import { fullScreenKeybindingOptions } from "pi-cosmic-ui/manager/key-labels";
import type { BackgroundTaskProjectionBridge } from "../boundary/host-ui.ts";
import { BackgroundTaskNotFoundError } from "../task/errors.ts";
import { TaskManagerComponent } from "../ui/manager.ts";
import { taskSettingsSubcommand, type TaskSettingsActions } from "./task-settings.ts";

const isTaskNotFound = Schema.is(BackgroundTaskNotFoundError);

export interface TaskManagerActions {
  readonly isAvailable: () => boolean;
  readonly openActivity?: (signal?: AbortSignal) => Promise<boolean>;
  readonly stop: (id: string) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export type TaskCommandActions = TaskManagerActions & TaskSettingsActions;

function notifyActionFailure(
  ctx: ExtensionCommandContext,
  action: "stop the task" | "clear finished tasks",
  cause: unknown,
): void {
  const reason = isTaskNotFound(cause)
    ? "it no longer exists"
    : cause instanceof Error
      ? failureMessage(sanitizeTerminalLine(cause.message), "")
      : "";
  notifyAtHostBoundary(ctx, `Couldn't ${action}${reason ? `: ${reason}` : ""}`, "error");
}

function openTaskManager(
  ctx: ExtensionCommandContext,
  bridge: BackgroundTaskProjectionBridge,
  actions: TaskManagerActions,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return Promise.resolve();
  if (ctx.mode !== "tui") {
    if (ctx.hasUI)
      notifyAtHostBoundary(
        ctx,
        "Open Pi in an interactive terminal to view background tasks with /tasks.",
        "warning",
      );
    return Promise.resolve();
  }
  if (!actions.isAvailable()) {
    notifyAtHostBoundary(
      ctx,
      "Background Tasks aren't running; run /reload, then reopen /tasks",
      "warning",
    );
    return Promise.resolve();
  }
  return openCommandSurface(ctx, {
    placement: "screen",
    isCurrent,
    create: ({ tui, theme, keybindings, getHeight, finish }) => {
      const revoked = () => {
        if (isCurrent()) return false;
        finish(undefined);
        return true;
      };
      const manager = new TaskManagerComponent({
        theme,
        getProjection: bridge.get,
        getHeight,
        getNow: synchronousNow,
        ...fullScreenKeybindingOptions(keybindings),
        requestRender: () => tui.requestRender(),
        close: () => finish(undefined),
        stop: (id) => {
          if (!revoked())
            void actions.stop(id).catch((cause: unknown) => {
              if (isCurrent()) notifyActionFailure(ctx, "stop the task", cause);
            });
        },
        clear: () => {
          if (!revoked())
            void actions.clear().catch((cause: unknown) => {
              if (isCurrent()) notifyActionFailure(ctx, "clear finished tasks", cause);
            });
        },
      });
      const unsubscribe = bridge.subscribe(() => {
        if (revoked()) return;
        manager.invalidate();
        tui.requestRender();
      });
      const stopSpinnerTicker = startHostUiTicker(SPINNER_FRAME_MS, () => {
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
  });
}

export function registerTasksCommand(
  pi: ExtensionAPI,
  bridge: BackgroundTaskProjectionBridge,
  actions: TaskCommandActions,
): void {
  registerExtensionCommand(pi, {
    name: "tasks",
    description: "Open the background task manager, or change its settings",
    bare: {
      handler: (_args, ctx) => {
        const isCurrent = actions.captureAuthority();
        return ctx.mode === "tui" && actions.isAvailable() && actions.openActivity
          ? actions
              .openActivity(ctx.signal)
              .then((opened) =>
                opened ? undefined : openTaskManager(ctx, bridge, actions, isCurrent),
              )
          : openTaskManager(ctx, bridge, actions, isCurrent);
      },
    },
    subcommands: [taskSettingsSubcommand(actions)],
  });
}
