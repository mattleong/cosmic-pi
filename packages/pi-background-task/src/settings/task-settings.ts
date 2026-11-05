import {
  INHERIT,
  inheritChoice,
  SCOPES,
  sessionValue,
  settingDisplayValue,
  TASK_SETTING_DESCRIPTORS,
  TASK_SETTINGS_COMMAND,
} from "./task-settings-options.ts";
import type { SettingItem } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { failureMessage } from "pi-cosmic-core/message-text";
import { isProjectTrusted, notifyAtHostBoundary } from "pi-cosmic-core/host-session";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { type ExtensionSubcommand } from "pi-cosmic-core/host-command";
import {
  settingsSubcommand,
  withInvocationAuthority,
  type SettingsCommandOwner,
} from "pi-cosmic-ui/boundary/host-settings-command";
import { OwnedSurfaceOutcome } from "pi-cosmic-ui/boundary/host-surface";
import {
  DEFAULT_BACKGROUND_TASK_CONFIG,
  type BackgroundTaskConfig,
  type BackgroundTaskSettingId,
  type BackgroundTaskSettingValue,
} from "../config/schema.ts";
import { settingInherited, type SettingsSurfaceItem } from "pi-cosmic-ui/manager/settings-surface";
import { joinInline } from "pi-cosmic-ui/manager";
import { BackgroundTaskConfigError, type BackgroundTaskSettingsLocation } from "../config/store.ts";
import {
  BACKGROUND_TASK_SETTINGS,
  formatSettingValue,
  type BackgroundTaskSetting,
  type BackgroundTaskSettingDescriptor,
} from "../config/options.ts";

export interface TaskSettingsActions {
  readonly captureAuthority: () => () => boolean;
  readonly config: () => BackgroundTaskConfig | undefined;
  readonly read: (
    location: BackgroundTaskSettingsLocation,
  ) => Promise<Partial<BackgroundTaskConfig>>;
  readonly write: <Id extends BackgroundTaskSettingId>(
    location: BackgroundTaskSettingsLocation,
    id: Id,
    value: BackgroundTaskSettingValue<Id> | undefined,
  ) => Promise<void>;
}

type TaskSettingsScope = (typeof SCOPES)[number]["name"];

const isConfigError = Schema.is(BackgroundTaskConfigError);
const UNTRUSTED = "Trust this project before changing its background task settings";

type ScopeFile =
  | { readonly scope: TaskSettingsScope; readonly own: Partial<BackgroundTaskConfig> }
  | { readonly scope: TaskSettingsScope; readonly problem: string };

const scopeOf = (scope: string | undefined): TaskSettingsScope =>
  scope === "project" ? "project" : "global";
const rowKey = (scope: TaskSettingsScope, id: string) => `${scope}:${id}`;
const scopeLabel = (scope: TaskSettingsScope) => (scope === "project" ? "Project" : "Global");

const SCOPE_DESCRIPTIONS = {
  global: "Background task settings for every project. Changes apply after /reload.",
  project:
    "Background task settings for this trusted project, which win over global ones. Changes apply after /reload.",
} as const satisfies Record<TaskSettingsScope, string>;

// A group row has one line, so its summary names each value as briefly as it stays clear.
const SETTING_SUMMARIES = {
  enabled: (value) => `tasks ${value}`,
  maxRunning: (value) => `${value} running`,
  maxRetained: (value) => `${value} kept`,
  logBufferBytesPerTask: (value) => `${value} per task`,
  totalLogBufferBytes: (value) => `${value} total`,
  stopGraceMs: (value) => `${value} grace`,
  maxWaitSeconds: (value) => `${value} wait`,
  showFooterStatus: (value) => `footer ${value}`,
  shellPath: (value) => value,
} as const satisfies Record<BackgroundTaskSettingId, (value: string) => string>;

const unavailableScopeRow = (scope: TaskSettingsScope, problem: string): SettingItem => ({
  id: rowKey(scope, "file"),
  label: scopeLabel(scope),
  description: problem,
  currentValue: "unavailable",
});

const settingDescriptor = (id: string) =>
  Option.getOrUndefined(Arr.findFirst(BACKGROUND_TASK_SETTINGS, (entry) => entry.id === id));

/**
 * Writes a checked value, or removes the scope's own value for `inherit`. Resolves to the value as
 * the list shows it, such as `256 KB` for `256k`, or undefined when the value is invalid.
 */
const writeSetting = <Id extends BackgroundTaskSettingId>(
  write: TaskSettingsActions["write"],
  location: BackgroundTaskSettingsLocation,
  setting: BackgroundTaskSettingDescriptor<Id>,
  value: string,
): Promise<string | undefined> => {
  const inherit = inheritChoice(value) === INHERIT;
  const parsed = inherit ? undefined : setting.parse(value);
  if (!inherit && parsed === undefined) return Promise.resolve(undefined);
  return write(location, setting.id, parsed).then(() =>
    parsed === undefined ? value : formatSettingValue(setting.kind, parsed),
  );
};

export function taskSettingsSubcommand(actions: TaskSettingsActions): ExtensionSubcommand {
  return withInvocationAuthority(actions.captureAuthority, (isCurrent, owner) =>
    createTaskSettingsSubcommand(actions, isCurrent, owner),
  );
}

function createTaskSettingsSubcommand(
  actions: TaskSettingsActions,
  isCurrent: () => boolean,
  owner: SettingsCommandOwner,
): ExtensionSubcommand {
  const known = new Map<string, string>();

  const pickerItems = (
    config: BackgroundTaskConfig,
    files: ReadonlyArray<ScopeFile>,
  ): SettingsSurfaceItem[] => {
    const globalOwn = Option.getOrUndefined(
      Arr.findFirst(files, (file) => file.scope === "global" && "own" in file),
    );
    const listed = Arr.filter(BACKGROUND_TASK_SETTINGS, (setting) => setting.values.length > 0);
    // What `inherit` resolves to in each scope: the default globally, else the global value.
    const inheritedValue = (scope: TaskSettingsScope, setting: BackgroundTaskSetting) => {
      const global = globalOwn && "own" in globalOwn ? globalOwn.own[setting.id] : undefined;
      return settingDisplayValue(
        setting,
        scope === "project" && global !== undefined
          ? global
          : DEFAULT_BACKGROUND_TASK_CONFIG[setting.id],
      );
    };
    const settingRow = (
      scope: TaskSettingsScope,
      own: Partial<BackgroundTaskConfig>,
      setting: BackgroundTaskSetting,
    ): SettingsSurfaceItem => {
      const stored = own[setting.id];
      const inherited = settingInherited(inheritedValue(scope, setting));
      const currentValue = stored === undefined ? inherited : settingDisplayValue(setting, stored);
      known.set(rowKey(scope, setting.id), currentValue);
      const values = [...setting.values, inherited];
      return {
        id: rowKey(scope, setting.id),
        label: setting.label,
        // A no-break space keeps a value such as `1 MB` on one line when the description wraps.
        description: `${setting.description} This session uses ${Str.replaceAll(" ", "\u00a0")(sessionValue(config, setting))}. Applies after /reload.`,
        currentValue,
        values: values.includes(currentValue) ? values : [currentValue, ...values],
      };
    };
    // A scope's value: the settings it sets itself, such as `16 running · 1 MB per task`.
    const summary = (scope: TaskSettingsScope) => () => {
      const own = Arr.filterMap(listed, (setting) => {
        const value = known.get(rowKey(scope, setting.id)) ?? INHERIT;
        return inheritChoice(value) === INHERIT
          ? Result.failVoid
          : Result.succeed(SETTING_SUMMARIES[setting.id](value));
      });
      return own.length === 0 ? INHERIT : joinInline(own);
    };
    // Each scope is one group row, so the list reads by scope instead of repeating it.
    return Arr.map(files, (file): SettingsSurfaceItem => {
      if ("problem" in file) return unavailableScopeRow(file.scope, file.problem);
      const children = Arr.map(listed, (setting) => settingRow(file.scope, file.own, setting));
      const scopeSummary = summary(file.scope);
      return {
        id: `group:${file.scope}`,
        label: scopeLabel(file.scope),
        kind: "group",
        description: SCOPE_DESCRIPTIONS[file.scope],
        currentValue: scopeSummary(),
        children,
        summary: scopeSummary,
      };
    });
  };

  return settingsSubcommand<BackgroundTaskConfig>({
    owner,
    root: "tasks",
    description: TASK_SETTINGS_COMMAND.description,
    title: "Background Tasks",
    isCurrent,
    descriptors: TASK_SETTING_DESCRIPTORS,
    examples: [
      "maxRunning 16",
      "logBufferBytesPerTask 1MiB",
      "project maxWaitSeconds 1m",
      `project maxRunning ${INHERIT}`,
    ],
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
      return Arr.join(
        [
          "Background Tasks settings (as this session started)",
          ...Arr.map(
            BACKGROUND_TASK_SETTINGS,
            (setting) => `  ${setting.id} = ${sessionValue(config, setting) || "default"}`,
          ),
        ],
        "\n",
      );
    },
    apply: (ctx, id, value, _signal, requested) => {
      const setting = settingDescriptor(id);
      if (!setting) return Promise.resolve(Result.fail({ message: `Unknown setting: ${id}` }));
      const scope = scopeOf(requested);
      return writeSetting(actions.write, { cwd: ctx.cwd, scope }, setting, value).then(
        (shown) => {
          if (shown === undefined) return Result.fail({ message: setting.invalid });
          known.set(rowKey(scope, setting.id), shown);
          return Result.succeed(undefined);
        },
        (cause: unknown) =>
          Result.fail({
            message: `Couldn't save background task settings: ${failureMessage(
              cause instanceof Error ? cause.message : "",
              "unknown error",
            )}`,
          }),
      );
    },
    displayValue: (_ctx, id, scope) => known.get(rowKey(scopeOf(scope), id)),
    afterApply: (ctx) =>
      notifyAtHostBoundary(ctx, "Background task settings apply after /reload", "info"),
    open: (ctx, session) => {
      const config = actions.config();
      if (!config) return Promise.resolve(OwnedSurfaceOutcome.Blocked());
      const scopes: readonly TaskSettingsScope[] = isProjectTrusted(ctx)
        ? ["global", "project"]
        : ["global"];
      const readScope = (scope: TaskSettingsScope): Promise<ScopeFile> =>
        actions.read({ cwd: ctx.cwd, scope }).then(
          (own) => ({ scope, own }),
          (cause: unknown) => {
            if (!isConfigError(cause)) throw cause;
            return {
              scope,
              problem: `${sanitizeTerminalLine(cause.path)} can't be read or isn't a JSON object`,
            };
          },
        );
      return Promise.all(Arr.map(scopes, readScope)).then(
        (files) =>
          isCurrent() ? session.picker(pickerItems(config, files)) : OwnedSurfaceOutcome.Blocked(),
        () => OwnedSurfaceOutcome.Blocked(),
      );
    },
  });
}
