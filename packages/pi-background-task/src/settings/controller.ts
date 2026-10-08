// Pi command and custom-UI handlers are Promise-shaped host boundaries.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
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
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { openCommandSurface } from "pi-cosmic-ui/boundary/host-surface";
import { fullScreenKeybindingOptions } from "pi-cosmic-ui/manager/key-labels";
import type { BackgroundTaskProjectionBridge } from "../boundary/host-ui.ts";
import type { BackgroundTaskConfig } from "../config/schema.ts";
import { BackgroundTaskConfigError, type BackgroundTaskSettingsLocation } from "../config/store.ts";
import { BACKGROUND_TASK_SETTINGS } from "../config/options.ts";
import { TaskManagerComponent } from "../ui/manager.ts";
import { SPINNER_FRAME_MS } from "pi-cosmic-ui/manager";
import { BackgroundTaskNotFoundError } from "../task/errors.ts";

export interface TaskManagerActions {
  /** False only before unified-view admission; rejection never falls back to a second surface. */
  readonly openActivity?: (signal?: AbortSignal) => Promise<boolean>;
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

function notifyActionFailure(
  ctx: ExtensionCommandContext,
  action: "stop the task" | "clear finished tasks",
  failure: Error | undefined,
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
  return openCommandSurface(ctx, {
    placement: "screen",
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
    bare: {
      handler: (_args, ctx) =>
        ctx.mode === "tui" && actions.openActivity
          ? actions
              .openActivity(ctx.signal)
              .then((opened) => (opened ? undefined : openTaskManager(ctx, bridge, actions)))
          : openTaskManager(ctx, bridge, actions),
    },
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
/** A setting's value in this session; a configured value such as shellPath can carry controls. */
const sessionValue = (config: BackgroundTaskConfig, id: keyof BackgroundTaskConfig) =>
  sanitizeTerminalLine(String(config[id] ?? ""));
const UNTRUSTED = "Trust this project before changing its background task settings";

/** One scope's own values, or why its file couldn't be read. */
type ScopeFile =
  | { readonly scope: TaskSettingsScope; readonly own: Partial<BackgroundTaskConfig> }
  | { readonly scope: TaskSettingsScope; readonly problem: string };

const scopeOf = (scope: string | undefined): TaskSettingsScope =>
  scope === "project" ? "project" : "global";
const rowKey = (scope: TaskSettingsScope, id: string) => `${scope}:${id}`;
const scopeLabel = (scope: TaskSettingsScope) => (scope === "project" ? "Project" : "Global");

/** Without values the row can't be changed, so the picker never writes over a broken file. */
const unavailableScopeRow = (scope: TaskSettingsScope, problem: string): SettingItem => ({
  id: rowKey(scope, "file"),
  label: `${scopeLabel(scope)} · Settings file`,
  description: problem,
  currentValue: "unavailable",
});

/** `/tasks settings` through the shared settings shell; changes apply after /reload. */
export function taskSettingsSubcommand(actions: TaskSettingsActions): ExtensionSubcommand {
  const descriptor = (id: string) => BACKGROUND_TASK_SETTINGS.find((entry) => entry.id === id);
  // Each scope's own value as last read or written, so an edited row shows what its file holds.
  const known = new Map<string, string>();

  const pickerItems = (config: BackgroundTaskConfig, files: ReadonlyArray<ScopeFile>) => {
    const settingRows = (scope: TaskSettingsScope, own: Partial<BackgroundTaskConfig>) =>
      BACKGROUND_TASK_SETTINGS.filter((setting) => setting.values.length > 0).map((setting) => {
        const stored = own[setting.id];
        const currentValue = stored === undefined ? INHERIT : sanitizeTerminalLine(String(stored));
        known.set(rowKey(scope, setting.id), currentValue);
        const values = [...setting.values, INHERIT];
        const effective = sessionValue(config, setting.id);
        return {
          id: rowKey(scope, setting.id),
          label: `${scopeLabel(scope)} · ${setting.label}`,
          description: `${setting.description} This session uses ${effective}; ${INHERIT} uses the ${scope === "project" ? "global value" : "default"}. Applies after /reload.`,
          currentValue,
          values: values.includes(currentValue) ? values : [currentValue, ...values],
        };
      });
    return files.flatMap((file): SettingItem[] =>
      "problem" in file
        ? [unavailableScopeRow(file.scope, file.problem)]
        : settingRows(file.scope, file.own),
    );
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
      currentValue: (config: BackgroundTaskConfig) => sessionValue(config, setting.id),
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
          (setting) => `  ${setting.id} = ${sessionValue(config, setting.id) || "default"}`,
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
      // A broken file closes only its own scope; an unavailable runtime closes the picker.
      const readScope = (scope: TaskSettingsScope): Promise<ScopeFile> =>
        actions.read({ cwd: ctx.cwd, scope }).then(
          (own) => ({ scope, own }),
          (error) => {
            if (!(error instanceof BackgroundTaskConfigError)) throw error;
            return {
              scope,
              problem: `${sanitizeTerminalLine(error.path)} can't be read or isn't a JSON object`,
            };
          },
        );
      return Promise.all(scopes.map(readScope)).then(
        (files) => session.picker(pickerItems(config, files)),
        () => ({ _tag: "Blocked" as const }),
      );
    },
  });
}
