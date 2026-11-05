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
import { isProjectTrusted } from "pi-cosmic-core/host-session";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { type ExtensionSubcommand } from "pi-cosmic-core/host-command";
import {
  settingsStatusText,
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
import {
  settingInherited,
  settingOnOff,
  type SettingsSurfaceItem,
} from "pi-cosmic-ui/manager/settings-surface";
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
const UNTRUSTED = "Trust this project before changing its background tasks settings";

type ScopeFile =
  | { readonly scope: TaskSettingsScope; readonly own: Partial<BackgroundTaskConfig> }
  | { readonly scope: TaskSettingsScope; readonly problem: string };

const scopeOf = (scope: string | undefined): TaskSettingsScope =>
  scope === "project" ? "project" : "global";
const rowKey = (scope: TaskSettingsScope, id: string) => `${scope}:${id}`;
const scopeLabel = (scope: TaskSettingsScope) => (scope === "project" ? "Project" : "Global");

const SCOPE_DESCRIPTIONS = {
  global: "Background tasks settings for every project. Changes apply after /reload.",
  project:
    "Background tasks settings for this trusted project, which win over global ones. Changes apply after /reload.",
} as const satisfies Record<TaskSettingsScope, string>;

// A group row has one line, so its summary names each value as briefly as it stays clear.
const SETTING_SUMMARIES = {
  enabled: (value) => value,
  maxRunning: (value) => `${value} running`,
  maxRetained: (value) => `${value} kept`,
  logBufferBytesPerTask: (value) => `${value} per task`,
  totalLogBufferBytes: (value) => `${value} total`,
  stopGraceMs: (value) => `${value} grace`,
  maxWaitSeconds: (value) => `${value} wait`,
  showFooterStatus: (value) => `footer ${value}`,
  shellPath: (value) => value,
} as const satisfies Record<BackgroundTaskSettingId, (value: string) => string>;

// Every summary leads with these values in effect; a scope's own other values follow them.
const SUMMARY_LEAD: ReadonlyArray<BackgroundTaskSettingId> = [
  "enabled",
  "maxRunning",
  "logBufferBytesPerTask",
];

/** How a setting row's description names the value this session started with. */
const sessionValueSentence = (setting: BackgroundTaskSetting, value: string) =>
  setting.kind === "switch"
    ? `${Str.capitalize(value)} in this session.`
    : // A no-break space keeps a value such as `1 MB` on one line when the description wraps.
      `This session uses ${Str.replaceAll(" ", "\u00a0")(value)}.`;

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
  // Each scope's own values as the list shows them, such as `16` or `inherit`, kept current by
  // every save so inherited labels and summaries derive from the latest values.
  const known = new Map<string, string>();
  // Only the picker reads every scope, so only it can name what an inherited value resolves to.
  let scopesRead = false;

  // A scope's own value, or undefined when it inherits.
  const ownValue = (scope: TaskSettingsScope, setting: BackgroundTaskSetting) => {
    const own = known.get(rowKey(scope, setting.id));
    return own === undefined || inheritChoice(own) === INHERIT ? undefined : own;
  };
  // What `inherit` resolves to in each scope: the default globally, else the global value.
  const inheritedValue = (scope: TaskSettingsScope, setting: BackgroundTaskSetting): string =>
    scope === "project"
      ? effectiveValue("global", setting)
      : settingDisplayValue(setting, DEFAULT_BACKGROUND_TASK_CONFIG[setting.id]);
  // The value in effect for a scope: its own, else what it inherits.
  const effectiveValue = (scope: TaskSettingsScope, setting: BackgroundTaskSetting): string =>
    ownValue(scope, setting) ?? inheritedValue(scope, setting);
  // A row's value: the scope's own, else `inherit (8)` naming the value it inherits now.
  const rowValue = (scope: TaskSettingsScope, setting: BackgroundTaskSetting): string =>
    ownValue(scope, setting) ?? settingInherited(inheritedValue(scope, setting));

  const pickerItems = (
    config: BackgroundTaskConfig,
    files: ReadonlyArray<ScopeFile>,
  ): SettingsSurfaceItem[] => {
    const listed = Arr.filter(BACKGROUND_TASK_SETTINGS, (setting) => setting.values.length > 0);
    scopesRead = true;
    for (const file of files) {
      if (!("own" in file)) continue;
      for (const setting of listed) {
        const stored = file.own[setting.id];
        known.set(
          rowKey(file.scope, setting.id),
          stored === undefined ? INHERIT : settingDisplayValue(setting, stored),
        );
      }
    }
    // Derived when its group opens and again whenever a save settles, so a project row names the
    // global value saved last, even if that save landed after the group opened.
    // The group already says changes apply after /reload; a row doesn't repeat it.
    const settingRow = (
      scope: TaskSettingsScope,
      setting: BackgroundTaskSetting,
    ): SettingsSurfaceItem => {
      const inherited = settingInherited(inheritedValue(scope, setting));
      const currentValue = rowValue(scope, setting);
      return {
        id: rowKey(scope, setting.id),
        label: setting.label,
        description: `${setting.description} ${sessionValueSentence(setting, sessionValue(config, setting))}`,
        currentValue,
        values: [
          inherited,
          ...(currentValue === inherited || setting.values.includes(currentValue)
            ? []
            : [currentValue]),
          ...setting.values,
        ],
      };
    };
    const ownsValue = (scope: TaskSettingsScope, setting: BackgroundTaskSetting) =>
      ownValue(scope, setting) !== undefined;
    // A scope's value: the values in effect that matter most, then the others it sets itself, such
    // as `on · 16 running · 1 MB per task · 5s grace`.
    const summary = (scope: TaskSettingsScope) => () => {
      // Descriptor order matches the lead's order, so the lead values come first.
      const leads = (setting: BackgroundTaskSetting) => Arr.contains(SUMMARY_LEAD, setting.id);
      const shown = [
        ...Arr.filter(listed, leads),
        ...Arr.filter(listed, (setting) => !leads(setting) && ownsValue(scope, setting)),
      ];
      const values = Arr.map(shown, (setting) => ({
        id: setting.id,
        value: effectiveValue(scope, setting),
      }));
      // A disabled scope reads just `off`: no other value matters while tasks can't start.
      const disabled = Arr.findFirst(
        values,
        (entry) => entry.id === "enabled" && entry.value === settingOnOff(false),
      );
      if (Option.isSome(disabled)) return disabled.value.value;
      return joinInline(Arr.map(values, (entry) => SETTING_SUMMARIES[entry.id](entry.value)));
    };
    // Each scope is one group row, so the list reads by scope instead of repeating it.
    return Arr.map(files, (file): SettingsSurfaceItem => {
      if ("problem" in file) return unavailableScopeRow(file.scope, file.problem);
      const children = () => Arr.map(listed, (setting) => settingRow(file.scope, setting));
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
    title: "Background tasks",
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
      "Changes apply after /reload.",
    ],
    // The picker's groups already say so; a command-line change's confirmation does too.
    confirmationNote: "applies after /reload",
    scopes: SCOPES,
    scopeBlocked: (ctx, scope) =>
      scope === "project" && !isProjectTrusted(ctx) ? UNTRUSTED : undefined,
    config: () => actions.config(),
    status: () => {
      const config = actions.config();
      if (!config) throw new Error("Background tasks haven't started");
      return settingsStatusText({
        title: "Background tasks settings",
        sections: [
          {
            rows: Arr.map(BACKGROUND_TASK_SETTINGS, (setting) => ({
              id: setting.id,
              label: setting.label,
              value: sessionValue(config, setting),
            })),
          },
        ],
        notes: ["Values as this session started; changes apply after /reload."],
      });
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
            message: `Couldn't save background tasks settings: ${failureMessage(
              cause instanceof Error ? cause.message : "",
              "unknown error",
            )}`,
          }),
      );
    },
    displayValue: (_ctx, id, scope) => {
      const setting = settingDescriptor(id);
      const key = rowKey(scopeOf(scope), id);
      return setting && scopesRead && known.has(key)
        ? rowValue(scopeOf(scope), setting)
        : known.get(key);
    },
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
