// Pi command and custom-UI handlers are Promise-shaped host boundaries.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import {
  failureMessage,
  isProjectTrusted,
  notifyAtHostBoundary,
  sanitizeTerminalLine,
  synchronousNow,
} from "pi-cosmic-core";
import { registerSettingsCommand } from "pi-cosmic-ui/boundary/host-settings-command";
import {
  createSettingsListSurface,
  managerSettingsTheme,
} from "pi-cosmic-ui/manager/settings-surface";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { openOwnedSurfacePromise } from "pi-cosmic-ui/boundary/host-surface";
import { fullScreenKeybindingOptions } from "pi-cosmic-ui/manager/key-labels";
import type { BackgroundTaskProjectionBridge } from "../boundary/host-ui.ts";
import type { BackgroundTaskConfig } from "../config/schema.ts";
import { BACKGROUND_TASK_SETTINGS, backgroundTaskSettingValue } from "../config/options.ts";
import { TaskManagerComponent } from "../ui/manager.ts";
import { SPINNER_FRAME_MS } from "pi-cosmic-ui/manager";
import { BackgroundTaskNotFoundError } from "../task/errors.ts";

export interface TaskManagerActions {
  readonly stop: (id: string) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export type TaskManagerCommandActions = TaskManagerActions;

export interface TaskSettingsActions {
  /** The settings this session started with, once it has started. */
  readonly config: () => BackgroundTaskConfig | undefined;
  readonly write: (
    location: { readonly cwd: string; readonly scope: "global" | "project" },
    id: keyof BackgroundTaskConfig,
    value: boolean | number | string,
  ) => Promise<void>;
}

type TaskManagerActionFailure = Error | undefined;

function notifyActionFailure(
  ctx: ExtensionCommandContext,
  action: "stop the task" | "clear finished tasks",
  failure: TaskManagerActionFailure,
): void {
  const reason =
    failure instanceof BackgroundTaskNotFoundError
      ? "it no longer exists"
      : failure instanceof Error
        ? failureMessage(sanitizeTerminalLine(failure.message), "")
        : "";
  notifyAtHostBoundary(ctx, `Couldn't ${action}${reason ? `: ${reason}` : ""}`, "error");
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
            .catch((failure) => notifyActionFailure(ctx, "stop the task", failure)),
        clear: () =>
          void actions
            .clear()
            .catch((failure) => notifyActionFailure(ctx, "clear finished tasks", failure)),
      });
      const unsubscribe = bridge.subscribe(() => {
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
    description: "Open the background task manager",
    handler: (args, ctx) => {
      if (args.trim()) {
        notifyAtHostBoundary(ctx, "Usage: /tasks; settings are in /tasks-settings", "warning");
        return Promise.resolve();
      }
      return openTaskManager(ctx, bridge, actions);
    },
  });
}

const SCOPES = [
  { name: "global", description: "Change a setting everywhere" },
  { name: "project", description: "Change a setting for this trusted project" },
] as const;

/** `/tasks-settings` through the shared settings shell; changes apply after /reload. */
export function registerTaskSettingsCommand(pi: ExtensionAPI, actions: TaskSettingsActions): void {
  const descriptor = (id: string) => BACKGROUND_TASK_SETTINGS.find((entry) => entry.id === id);
  registerSettingsCommand<BackgroundTaskConfig>(pi, {
    command: "tasks-settings",
    description: "Configure background tasks",
    title: "Background Tasks",
    descriptors: BACKGROUND_TASK_SETTINGS.map((setting) => ({
      id: setting.id,
      description: setting.description,
      ...(setting.values.length > 0 && { values: [...setting.values] }),
      openValues: setting.openValues,
      currentValue: (config: BackgroundTaskConfig) =>
        backgroundTaskSettingValue(config, setting.id),
    })),
    examples: ["maxRunning 16", "project maxWaitSeconds 60"],
    notes: () => ["Scope defaults to global. Changes take effect after /reload."],
    scopes: SCOPES,
    scopeBlocked: (ctx, scope) =>
      scope === "project" && !isProjectTrusted(ctx)
        ? "Trust this project before changing its background task settings"
        : undefined,
    config: () => actions.config(),
    status: () => {
      const config = actions.config();
      if (!config) throw new Error("Background Tasks hasn't started");
      return [
        "Background Tasks settings (as this session started)",
        ...BACKGROUND_TASK_SETTINGS.map(
          (setting) =>
            `  ${setting.id} = ${sanitizeTerminalLine(backgroundTaskSettingValue(config, setting.id)) || "default"}`,
        ),
      ].join("\n");
    },
    apply: (ctx, id, value, _signal, scope) => {
      const setting = descriptor(id);
      const parsed = setting?.parse(value);
      if (!setting || parsed === undefined)
        return Promise.resolve(
          Result.fail({ message: setting?.invalid ?? `Unknown setting: ${id}` }),
        );
      return actions
        .write(
          { cwd: ctx.cwd, scope: scope === "project" ? "project" : "global" },
          setting.id,
          parsed,
        )
        .then(
          () => Result.succeed(undefined),
          (error) =>
            Result.fail({
              message: `Couldn't save background task settings: ${failureMessage(
                error instanceof Error ? error.message : "",
                "unknown error",
              )}`,
            }),
        );
    },
    afterApply: (ctx) =>
      notifyAtHostBoundary(ctx, "Background task settings apply after /reload", "info"),
    open: (ctx, session) => {
      const config = actions.config();
      if (!config) return Promise.resolve({ _tag: "Blocked" as const });
      const items = BACKGROUND_TASK_SETTINGS.filter((setting) => setting.values.length > 0).map(
        (setting) => {
          const currentValue = sanitizeTerminalLine(backgroundTaskSettingValue(config, setting.id));
          return {
            id: setting.id,
            label: setting.label,
            description: `${setting.description} Applies after /reload.`,
            currentValue,
            values: setting.values.includes(currentValue)
              ? [...setting.values]
              : [currentValue, ...setting.values],
          };
        },
      );
      return openOwnedSurfacePromise<undefined>(ctx, {
        placement: "inline",
        closedValue: undefined,
        create: ({ tui, theme, keybindings, finish }) =>
          createSettingsListSurface({
            header: new Text(theme.fg("accent", theme.bold("Background Tasks settings")), 1, 1),
            items,
            height: Math.min(12, items.length + 2),
            listTheme: managerSettingsTheme(theme),
            onChange: (id, value, list) =>
              void session.apply(id, value, (shown) => {
                list.updateValue(id, shown);
                tui.requestRender();
              }),
            onCancel: () => finish(undefined),
            matchesKeybinding: Predicate.isFunction(keybindings?.matches)
              ? (data, bindingId) => keybindings.matches(data, bindingId)
              : undefined,
            requestRender: () => tui.requestRender(),
            dim: (text) => theme.fg("dim", text),
          }).surface,
      });
    },
  });
}
