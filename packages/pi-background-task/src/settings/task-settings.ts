import type { SettingItem } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  failureMessage,
  isProjectTrusted,
  notifyAtHostBoundary,
  sanitizeTerminalLine,
  type ExtensionSubcommand,
} from "pi-cosmic-core";
import {
  settingsSubcommand,
  withInvocationAuthority,
  type SettingsCommandOwner,
} from "pi-cosmic-ui/boundary/host-settings-command";
import { OwnedSurfaceOutcome } from "pi-cosmic-ui/boundary/host-surface";
import type {
  BackgroundTaskConfig,
  BackgroundTaskSettingId,
  BackgroundTaskSettingValue,
} from "../config/schema.ts";
import { BackgroundTaskConfigError, type BackgroundTaskSettingsLocation } from "../config/store.ts";
import {
  BACKGROUND_TASK_SETTINGS,
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

const SCOPES = [
  { name: "global", description: "Change a setting everywhere" },
  { name: "project", description: "Change a setting for this trusted project" },
] as const;
type TaskSettingsScope = (typeof SCOPES)[number]["name"];

const INHERIT = "inherit";
const isConfigError = Schema.is(BackgroundTaskConfigError);
const sessionValue = (config: BackgroundTaskConfig, id: BackgroundTaskSettingId) =>
  sanitizeTerminalLine(String(config[id] ?? ""));
const UNTRUSTED = "Trust this project before changing its background task settings";

type ScopeFile =
  | { readonly scope: TaskSettingsScope; readonly own: Partial<BackgroundTaskConfig> }
  | { readonly scope: TaskSettingsScope; readonly problem: string };

const scopeOf = (scope: string | undefined): TaskSettingsScope =>
  scope === "project" ? "project" : "global";
const rowKey = (scope: TaskSettingsScope, id: string) => `${scope}:${id}`;
const scopeLabel = (scope: TaskSettingsScope) => (scope === "project" ? "Project" : "Global");

const unavailableScopeRow = (scope: TaskSettingsScope, problem: string): SettingItem => ({
  id: rowKey(scope, "file"),
  label: `${scopeLabel(scope)} · Settings file`,
  description: problem,
  currentValue: "unavailable",
});

const settingDescriptor = (id: string) =>
  Option.getOrUndefined(Arr.findFirst(BACKGROUND_TASK_SETTINGS, (entry) => entry.id === id));

/** Writes a checked value, or removes the scope's own value for `inherit`; false when invalid. */
const writeSetting = <Id extends BackgroundTaskSettingId>(
  write: TaskSettingsActions["write"],
  location: BackgroundTaskSettingsLocation,
  setting: BackgroundTaskSettingDescriptor<Id>,
  value: string,
): Promise<boolean> => {
  const parsed = value === INHERIT ? undefined : setting.parse(value);
  if (value !== INHERIT && parsed === undefined) return Promise.resolve(false);
  return write(location, setting.id, parsed).then(() => true);
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

  const pickerItems = (config: BackgroundTaskConfig, files: ReadonlyArray<ScopeFile>) => {
    const settingRows = (scope: TaskSettingsScope, own: Partial<BackgroundTaskConfig>) =>
      Arr.map(
        Arr.filter(BACKGROUND_TASK_SETTINGS, (setting) => setting.values.length > 0),
        (setting) => {
          const stored = own[setting.id];
          const currentValue =
            stored === undefined ? INHERIT : sanitizeTerminalLine(String(stored));
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
        },
      );
    return Arr.flatMap(files, (file): SettingItem[] =>
      "problem" in file
        ? [unavailableScopeRow(file.scope, file.problem)]
        : settingRows(file.scope, file.own),
    );
  };

  return settingsSubcommand<BackgroundTaskConfig>({
    owner,
    root: "tasks",
    description: "Configure background tasks",
    title: "Background Tasks",
    isCurrent,
    descriptors: Arr.map(BACKGROUND_TASK_SETTINGS, (setting) => ({
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
      return Arr.join(
        [
          "Background Tasks settings (as this session started)",
          ...Arr.map(
            BACKGROUND_TASK_SETTINGS,
            (setting) => `  ${setting.id} = ${sessionValue(config, setting.id) || "default"}`,
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
        (written) => {
          if (!written) return Result.fail({ message: setting.invalid });
          known.set(rowKey(scope, setting.id), value);
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
