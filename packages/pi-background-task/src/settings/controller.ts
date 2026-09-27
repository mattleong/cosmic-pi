// Pi command and custom-UI handlers are Promise-shaped host boundaries.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text, type SettingItem } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import {
  failureMessage,
  isProjectTrusted,
  notifyAtHostBoundary,
  registerExtensionCommand,
  sanitizeTerminalLine,
  synchronousNow,
  type ExtensionSubcommand,
} from "pi-cosmic-core";
import { settingsSubcommand } from "pi-cosmic-ui/boundary/host-settings-command";
import {
  createSettingsListSurface,
  managerSettingsTheme,
  settingsRowGenerations,
} from "pi-cosmic-ui/manager/settings-surface";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { openOwnedSurfacePromise } from "pi-cosmic-ui/boundary/host-surface";
import { fullScreenKeybindingOptions } from "pi-cosmic-ui/manager/key-labels";
import type { BackgroundTaskProjectionBridge } from "../boundary/host-ui.ts";
import type { BackgroundTaskConfig } from "../config/schema.ts";
import type { BackgroundTaskSettingsLocation } from "../config/store.ts";
import { BACKGROUND_TASK_SETTINGS, backgroundTaskSettingValue } from "../config/options.ts";
import { TaskManagerComponent } from "../ui/manager.ts";
import { SPINNER_FRAME_MS } from "pi-cosmic-ui/manager";
import { BackgroundTaskNotFoundError } from "../task/errors.ts";

export interface TaskManagerActions {
  readonly stop: (id: string) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export interface TaskSettingsActions {
  /** The settings this session started with, once it has started. */
  readonly config: () => BackgroundTaskConfig | undefined;
  /** The values one scope's file sets itself. */
  readonly read: (
    location: BackgroundTaskSettingsLocation,
  ) => Promise<Partial<BackgroundTaskConfig>>;
  /** Stores one value in a scope's file; undefined removes the scope's own value. */
  readonly write: (
    location: BackgroundTaskSettingsLocation,
    id: keyof BackgroundTaskConfig,
    value: boolean | number | string | undefined,
  ) => Promise<void>;
}

export type TaskCommandActions = TaskManagerActions & TaskSettingsActions;

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

/** `/tasks` opens the task manager; `/tasks settings` changes the settings. */
export function registerTasksCommand(
  pi: ExtensionAPI,
  bridge: BackgroundTaskProjectionBridge,
  actions: TaskCommandActions,
): void {
  registerExtensionCommand(pi, {
    name: "tasks",
    description: "Open the background task manager, or change its settings",
    bare: { handler: (_args, ctx) => openTaskManager(ctx, bridge, actions) },
    subcommands: [taskSettingsSubcommand(actions)],
  });
}

const SCOPES = [
  { name: "global", description: "Change a setting everywhere" },
  { name: "project", description: "Change a setting for this trusted project" },
] as const;
type TaskSettingsScope = (typeof SCOPES)[number]["name"];

/** A scope that sets no value of its own takes the global one, or the default. */
const INHERIT = "inherit";
const UNTRUSTED = "Trust this project before changing its background task settings";

const scopeOf = (scope: string | undefined): TaskSettingsScope =>
  scope === "project" ? "project" : "global";
const rowKey = (scope: TaskSettingsScope, id: string) => `${scope}:${id}`;
const scopeLabel = (scope: TaskSettingsScope) => (scope === "project" ? "Project" : "Global");

/** `/tasks settings` through the shared settings shell; changes apply after /reload. */
export function taskSettingsSubcommand(actions: TaskSettingsActions): ExtensionSubcommand {
  const descriptor = (id: string) => BACKGROUND_TASK_SETTINGS.find((entry) => entry.id === id);
  // Each scope's own value as last read or written, so an edited row shows what its file holds.
  const known = new Map<string, string>();

  const openPicker = (
    ctx: ExtensionCommandContext,
    session: {
      readonly apply: (
        id: string,
        value: string,
        show?: (value: string) => boolean | void,
        scope?: string,
      ) => Promise<void>;
    },
    config: BackgroundTaskConfig,
    files: ReadonlyArray<readonly [TaskSettingsScope, Partial<BackgroundTaskConfig>]>,
  ) => {
    const items: SettingItem[] = files.flatMap(([scope, own]) =>
      BACKGROUND_TASK_SETTINGS.filter((setting) => setting.values.length > 0).map((setting) => {
        const stored = own[setting.id];
        const currentValue = stored === undefined ? INHERIT : sanitizeTerminalLine(String(stored));
        known.set(rowKey(scope, setting.id), currentValue);
        const values = [...setting.values, INHERIT];
        const effective = sanitizeTerminalLine(backgroundTaskSettingValue(config, setting.id));
        return {
          id: rowKey(scope, setting.id),
          label: `${scopeLabel(scope)} · ${setting.label}`,
          description: `${setting.description} This session uses ${effective}; ${INHERIT} uses the ${scope === "project" ? "global value" : "default"}. Applies after /reload.`,
          currentValue,
          values: values.includes(currentValue) ? values : [currentValue, ...values],
        };
      }),
    );
    const generations = settingsRowGenerations();
    return openOwnedSurfacePromise<undefined>(ctx, {
      placement: "inline",
      closedValue: undefined,
      create: ({ tui, theme, keybindings, finish }) =>
        createSettingsListSurface({
          header: new Text(theme.fg("accent", theme.bold("Background Tasks settings")), 1, 1),
          items,
          height: Math.min(12, items.length + 2),
          listTheme: managerSettingsTheme(theme),
          onChange: (rowId, value, list) => {
            const [scope = "global", id = rowId] = rowId.split(":");
            const generation = generations.begin(rowId);
            void session.apply(
              id,
              value,
              (shown) => {
                if (!generations.isCurrent(rowId, generation)) return false;
                list.updateValue(rowId, shown);
                tui.requestRender();
                return true;
              },
              scope,
            );
          },
          onCancel: () => finish(undefined),
          matchesKeybinding: Predicate.isFunction(keybindings?.matches)
            ? (data, bindingId) => keybindings.matches(data, bindingId)
            : undefined,
          requestRender: () => tui.requestRender(),
          dim: (text) => theme.fg("dim", text),
        }).surface,
    });
  };

  return settingsSubcommand<BackgroundTaskConfig>({
    root: "tasks",
    description: "Configure background tasks",
    title: "Background Tasks",
    descriptors: BACKGROUND_TASK_SETTINGS.map((setting) => ({
      id: setting.id,
      description: setting.description,
      ...(setting.values.length > 0 && { values: [...setting.values, INHERIT] }),
      openValues: setting.openValues,
      currentValue: (config: BackgroundTaskConfig) =>
        backgroundTaskSettingValue(config, setting.id),
    })),
    examples: ["maxRunning 16", "project maxWaitSeconds 60", `project maxRunning ${INHERIT}`],
    notes: () => [
      `Scope defaults to global; ${INHERIT} removes a scope's own value.`,
      "Changes take effect after /reload.",
    ],
    scopes: SCOPES,
    scopeBlocked: (ctx, scope) =>
      scope === "project" && !isProjectTrusted(ctx) ? UNTRUSTED : undefined,
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
    apply: (ctx, id, value, _signal, requested) => {
      const setting = descriptor(id);
      const parsed = value === INHERIT ? undefined : setting?.parse(value);
      if (!setting || (value !== INHERIT && parsed === undefined))
        return Promise.resolve(
          Result.fail({ message: setting?.invalid ?? `Unknown setting: ${id}` }),
        );
      const scope = scopeOf(requested);
      return actions.write({ cwd: ctx.cwd, scope }, setting.id, parsed).then(
        () => {
          known.set(rowKey(scope, setting.id), value);
          return Result.succeed(undefined);
        },
        (error) =>
          Result.fail({
            message: `Couldn't save background task settings: ${failureMessage(
              error instanceof Error ? error.message : "",
              "unknown error",
            )}`,
          }),
      );
    },
    // A scope's own value, since the session keeps its settings until /reload.
    displayValue: (_ctx, id, scope) => known.get(rowKey(scopeOf(scope), id)),
    afterApply: (ctx) =>
      notifyAtHostBoundary(ctx, "Background task settings apply after /reload", "info"),
    open: (ctx, session) => {
      const config = actions.config();
      if (!config) return Promise.resolve({ _tag: "Blocked" as const });
      const scopes: readonly TaskSettingsScope[] = isProjectTrusted(ctx)
        ? ["global", "project"]
        : ["global"];
      return Promise.all(
        scopes.map((scope) =>
          actions.read({ cwd: ctx.cwd, scope }).then((own) => [scope, own] as const),
        ),
      ).then(
        (files) => openPicker(ctx, session, config, files),
        () => ({ _tag: "Blocked" as const }),
      );
    },
  });
}
