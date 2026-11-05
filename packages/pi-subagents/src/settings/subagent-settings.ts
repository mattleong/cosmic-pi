import {
  DELEGATION,
  DELEGATION_DESCRIPTION,
  DELEGATION_LABEL,
  INHERIT,
  isNestingField,
  NESTING_FIELDS,
  NESTING_FIELD_IDS,
  SCOPES,
  SUBAGENT_SETTING_DESCRIPTORS,
  SUBAGENT_SETTINGS_COMMAND,
  WORKSPACE,
  WORKSPACE_DESCRIPTION,
  WORKSPACE_LABEL,
  type NestingField,
} from "./subagent-settings-options.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import { joinInline } from "pi-cosmic-ui/manager";
import { settingInherited, type SettingsSurfaceItem } from "pi-cosmic-ui/manager/settings-surface";
import { failureMessage } from "pi-cosmic-core/message-text";
import { isProjectTrusted } from "pi-cosmic-core/host-session";
import { type ExtensionSubcommand } from "pi-cosmic-core/host-command";
import { countLabel } from "pi-cosmic-core/display";
import {
  settingsStatusText,
  settingsSubcommand,
  withInvocationAuthority,
  type SettingsCommandOwner,
  type SettingsSession,
} from "pi-cosmic-ui/boundary/host-settings-command";
import {
  DELEGATION_MODES,
  isDelegationMode,
  DEFAULT_DELEGATION_MODE,
  DEFAULT_MAX_ACTIVE_RUNS,
  DEFAULT_SUBAGENT_NESTING_POLICY,
  WRITER_WORKSPACE_MODES,
  type DelegationMode,
  type SubagentNestingOverrides,
} from "../config/schema.ts";
import type { WriterWorkspaceInspection } from "../run/workspace-control.ts";
import type { SubagentCommandActions } from "./controller.ts";
import {
  SCOPE_LABELS,
  type ProfileSettingsInspection,
  type ProfileSettingsScope,
} from "./profile-route-editor.ts";
import { profileSetPatchBase } from "./profile-write-context.ts";
import { WRITER_WORKSPACE_LABELS, writerWorkspaceModeOf } from "../ui/run-facts.ts";

type SettingsResult = Result.Result<
  undefined,
  { readonly message: string; readonly stale?: boolean }
>;
const UNTRUSTED = "Trust this project before changing its subagent settings";

/** Worktrees in this checkout still waiting on apply or discard, and what to do about them. */
const unresolvedSummary = ({ unresolvedWorkspaceCount: count }: WriterWorkspaceInspection) =>
  count === undefined
    ? undefined
    : `${countLabel(count, "worktree")} in this checkout ${count === 1 ? "isn't" : "aren't"} applied or discarded yet; ask the agent to review ${count === 1 ? "it" : "them"}.`;

const settingScope = (scope: string | undefined): ProfileSettingsScope =>
  scope === "global" || scope === "project" ? scope : "session";

const editableScopes = (trusted: boolean): readonly ProfileSettingsScope[] =>
  trusted ? ["session", "global", "project"] : ["session", "global"];

const scopeNesting = (
  inspection: ProfileSettingsInspection,
  scope: ProfileSettingsScope,
): SubagentNestingOverrides | undefined =>
  scope === "session" ? inspection.session.nesting : inspection[scope]?.file.nesting;

const scopeDelegation = (
  inspection: ProfileSettingsInspection,
  scope: ProfileSettingsScope,
): DelegationMode | undefined =>
  scope === "session" ? inspection.session.delegation : inspection[scope]?.file.delegation;

const ownNestingValue = (
  own: SubagentNestingOverrides | undefined,
  field: NestingField,
): string => {
  const value = own?.[field];
  return value === undefined ? INHERIT : String(value);
};

/**
 * A scope's own limits after one field changes: its other limits stay, an inheriting field is
 * dropped, and the scope inherits the whole policy (undefined) once it declares none.
 */
const withNestingField = (
  own: SubagentNestingOverrides | undefined,
  field: NestingField,
  limit: number | undefined,
): SubagentNestingOverrides | undefined => {
  const fields = Arr.flatMap(NESTING_FIELD_IDS, (id) => {
    const value = id === field ? limit : own?.[id];
    return value === undefined ? [] : [[id, value] as const];
  });
  return fields.length === 0 ? undefined : Rec.fromEntries(fields);
};

const parseLimit = (field: NestingField, value: string): number | undefined => {
  const { minimum, maximum } = NESTING_FIELDS[field];
  const parsed = /^(?:0|[1-9][0-9]*)$/u.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
};

const failed = (message: string): SettingsResult => Result.fail({ message });
const succeeded: SettingsResult = Result.succeed(undefined);

const saveFailure =
  (what: string) =>
  (error: Error | string): SettingsResult =>
    failed(
      `Couldn't ${what}: ${failureMessage(error instanceof Error ? error.message : "", "unknown error")}`,
    );

/** A row's choices: `inherit (value)` first, then a current value no preset names, then presets. */
const choiceValues = (inherited: string, presets: readonly string[], currentValue: string) => [
  inherited,
  ...(currentValue === inherited || presets.includes(currentValue) ? [] : [currentValue]),
  ...presets,
];

const SCOPED_SETTING_IDS: ReadonlyArray<typeof DELEGATION | NestingField> = [
  DELEGATION,
  ...NESTING_FIELD_IDS,
];

/** `inherit (12)` and other inherited labels mean `inherit` when chosen. */
const inheritChoice = (value: string): string =>
  value === INHERIT || (Str.startsWith(`${INHERIT} (`)(value) && Str.endsWith(")")(value))
    ? INHERIT
    : value;

// Where `inherit` takes a scope's value from: the session from the files it started with, the
// project from global settings, and global from the defaults.
const INHERITED_FROM = {
  session: "the global and project settings this session started with",
  project: "global settings",
  global: "the default",
} as const satisfies Record<ProfileSettingsScope, string>;

/** The value a scope inherits for one setting when it declares none of its own. */
const inheritedValue = (
  inspection: ProfileSettingsInspection,
  scope: ProfileSettingsScope,
  id: typeof DELEGATION | NestingField,
): string => {
  if (scope === "session") {
    const base = inspection.session.baseConfig;
    return id === DELEGATION
      ? base.delegation
      : String(base.nesting[id] ?? DEFAULT_SUBAGENT_NESTING_POLICY[id] ?? DEFAULT_MAX_ACTIVE_RUNS);
  }
  const global = scope === "project" ? inspection.global.file : undefined;
  return id === DELEGATION
    ? (global?.delegation ?? DEFAULT_DELEGATION_MODE)
    : String(
        global?.nesting?.[id] ?? DEFAULT_SUBAGENT_NESTING_POLICY[id] ?? DEFAULT_MAX_ACTIVE_RUNS,
      );
};

const SCOPED_SETTING_LABELS = {
  [DELEGATION]: DELEGATION_LABEL,
  ...Rec.map(NESTING_FIELDS, (field) => field.label),
} as const satisfies Record<typeof DELEGATION | NestingField, string>;

/** A scope's own value for one setting, or `inherit`. */
const ownValue = (
  inspection: ProfileSettingsInspection,
  scope: ProfileSettingsScope,
  id: typeof DELEGATION | NestingField,
): string =>
  id === DELEGATION
    ? (scopeDelegation(inspection, scope) ?? INHERIT)
    : ownNestingValue(scopeNesting(inspection, scope), id);

/**
 * One scoped setting as a row of its scope's group, which already names the scope: `own` is the
 * scope's value or `inherit`, and `inherited` the value it takes then.
 */
const scopedSettingItem = (
  scope: ProfileSettingsScope,
  id: typeof DELEGATION | NestingField,
  own: string,
  inherited: string,
): SettingItem => {
  const reloadNote = scope === "session" ? "" : " Changes apply after /reload.";
  const inheritedLabel = settingInherited(inherited);
  const currentValue = own === INHERIT ? inheritedLabel : own;
  return {
    id: `${scope}:${id}`,
    label: SCOPED_SETTING_LABELS[id],
    description: `${id === DELEGATION ? DELEGATION_DESCRIPTION : NESTING_FIELDS[id].description} Inherit uses ${INHERITED_FROM[scope]}.${reloadNote}`,
    currentValue,
    values: choiceValues(
      inheritedLabel,
      id === DELEGATION ? DELEGATION_MODES : NESTING_FIELDS[id].presets,
      currentValue,
    ),
  };
};

const SCOPE_GROUP_DESCRIPTIONS = {
  session: "Delegation and nesting limits for this session only. Changes apply now.",
  global: "Delegation and nesting limits for new sessions everywhere. Changes apply after /reload.",
  project:
    "Delegation and nesting limits for this trusted project, which win over global ones. Changes apply after /reload.",
} as const satisfies Record<ProfileSettingsScope, string>;

// A group row has one line, so its summary names each value as briefly as it stays clear.
const SCOPED_SETTING_SUMMARIES = {
  [DELEGATION]: (value) => value,
  maxDirectChildren: (value) => `${value} children`,
  maxDepth: (value) => `depth ${value}`,
  maxActiveRuns: (value) => `${value} active`,
} as const satisfies Record<typeof DELEGATION | NestingField, (value: string) => string>;

/** The value an `inherit (12)` row applies, or the row's own value. */
const appliedValue = (value: string): string =>
  Str.startsWith(`${INHERIT} (`)(value) && Str.endsWith(")")(value)
    ? Fn.pipe(value, Str.slice(INHERIT.length + 2, -1))
    : value;

const isDefaultLimit = (id: typeof DELEGATION | NestingField, value: string): boolean =>
  id !== DELEGATION &&
  value === String(DEFAULT_SUBAGENT_NESTING_POLICY[id] ?? DEFAULT_MAX_ACTIVE_RUNS);

/**
 * A scope's group value: the values its settings apply, set there or inherited, such as
 * `encouraged · depth 2`. The delegation mode always shows; limits at their defaults are left to
 * the group's rows, so the line fits a narrow row.
 */
const scopeGroupSummary = (
  values: ReadonlyArray<readonly [typeof DELEGATION | NestingField, string]>,
): string =>
  joinInline(
    Arr.filterMap(values, ([id, value]) => {
      const applied = appliedValue(value);
      return isDefaultLimit(id, applied)
        ? Result.failVoid
        : Result.succeed(SCOPED_SETTING_SUMMARIES[id](applied));
    }),
  );

/** A saved value as its row shows it: the writer workspace by its label. */
const shownValue = (id: string, value: string): string => {
  const mode = id === WORKSPACE ? writerWorkspaceModeOf(value) : undefined;
  return mode === undefined ? value : WRITER_WORKSPACE_LABELS[mode];
};

export function subagentSettingsSubcommand(actions: SubagentCommandActions): ExtensionSubcommand {
  return withInvocationAuthority(actions.captureAuthority, (isCurrent, owner) =>
    subagentSettingsCommand(actions, isCurrent, owner),
  );
}

function subagentSettingsCommand(
  actions: SubagentCommandActions,
  isCurrent: () => boolean,
  saveOwner: SettingsCommandOwner,
): ExtensionSubcommand {
  const current = (
    run: (stillCurrent: () => boolean) => Promise<SettingsResult>,
  ): Promise<SettingsResult> => {
    if (!actions.isAvailable()) return Promise.reject(new Error("Subagents are not active"));
    const owner = actions.captureModelRefresh();
    const stillCurrent = () => owner.isCurrent() && actions.isAvailable();
    return run(stillCurrent).then((result) =>
      stillCurrent() ? result : Result.fail({ message: "", stale: true }),
    );
  };

  const saveToScope = <Payload extends object>(
    ctx: ExtensionCommandContext,
    scope: ProfileSettingsScope,
    what: string,
    payload: (inspection: ProfileSettingsInspection) => Payload,
    write: {
      readonly session: (patch: Payload & { readonly expectedRevision: number }) => Promise<void>;
      readonly saved: (patch: Payload & ReturnType<typeof profileSetPatchBase>) => Promise<void>;
    },
  ): Promise<SettingsResult> =>
    current((stillCurrent) =>
      actions
        .inspectProfiles(isProjectTrusted(ctx))
        .then((inspection): SettingsResult | Promise<SettingsResult> => {
          if (!stillCurrent()) return succeeded;
          const projectTrusted = isProjectTrusted(ctx);
          if (scope === "project" && !projectTrusted) return failed(UNTRUSTED);
          return (
            scope === "session"
              ? write.session({
                  ...payload(inspection),
                  expectedRevision: inspection.session.revision,
                })
              : write.saved({
                  ...profileSetPatchBase(inspection, scope, projectTrusted),
                  ...payload(inspection),
                })
          ).then(() => succeeded, saveFailure(what));
        }),
    );

  const applyWorkspace = (value: string): Promise<SettingsResult> =>
    current((stillCurrent) =>
      actions
        .inspectWriterWorkspace()
        .then((snapshot): SettingsResult | Promise<SettingsResult> => {
          const mode = writerWorkspaceModeOf(value);
          if (mode === undefined)
            return failed(`${WORKSPACE} must be ${Arr.join(WRITER_WORKSPACE_MODES, " or ")}`);
          if (snapshot.mode === mode || !stillCurrent()) return succeeded;
          return actions
            .setWriterWorkspaceMode(mode)
            .then(() => succeeded, saveFailure("change the writer workspace"));
        }),
    );

  const applyNesting = (
    ctx: ExtensionCommandContext,
    field: NestingField,
    value: string,
    scope: ProfileSettingsScope,
  ): Promise<SettingsResult> => {
    const limit = value === INHERIT ? undefined : parseLimit(field, value);
    if (value !== INHERIT && limit === undefined) {
      const { minimum, maximum } = NESTING_FIELDS[field];
      return Promise.resolve(
        failed(`${field} must be a whole number from ${minimum} to ${maximum}`),
      );
    }
    return saveToScope(
      ctx,
      scope,
      "save the nesting limits",
      (inspection) => {
        const next = withNestingField(scopeNesting(inspection, scope), field, limit);
        return next ? { nesting: next } : {};
      },
      { session: actions.patchSessionNesting, saved: actions.patchNesting },
    );
  };

  const applyDelegation = (
    ctx: ExtensionCommandContext,
    value: string,
    scope: ProfileSettingsScope,
  ): Promise<SettingsResult> => {
    if (value !== INHERIT && !isDelegationMode(value))
      return Promise.resolve(
        failed(`${DELEGATION} must be ${Arr.join(DELEGATION_MODES, ", ")}, or ${INHERIT}`),
      );
    return saveToScope(
      ctx,
      scope,
      "save the delegation mode",
      () => (value === INHERIT ? {} : { delegation: value }),
      { session: actions.patchSessionDelegation, saved: actions.patchDelegation },
    );
  };

  const statusText = (ctx: ExtensionCommandContext): Promise<string> => {
    if (!actions.isAvailable()) return Promise.reject(new Error("Subagents are not active"));
    const trusted = isProjectTrusted(ctx);
    return Promise.all([actions.inspectWriterWorkspace(), actions.inspectProfiles(trusted)]).then(
      ([workspace, inspection]) => {
        const effective = inspection.session.effectiveConfig;
        const inEffect = {
          [DELEGATION]: effective.delegation,
          maxDirectChildren: String(effective.nesting.maxDirectChildren),
          maxDepth: String(effective.nesting.maxDepth),
          maxActiveRuns: String(effective.nesting.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS),
        } as const satisfies Record<typeof DELEGATION | NestingField, string>;
        const row = (id: typeof DELEGATION | NestingField, value: string) => ({
          id,
          label: SCOPED_SETTING_LABELS[id],
          value,
        });
        const hooks = effective.hooks;
        return settingsStatusText({
          title: "Subagents settings",
          sections: [
            {
              title: "In effect",
              rows: [
                {
                  id: WORKSPACE,
                  label: WORKSPACE_LABEL,
                  value: WRITER_WORKSPACE_LABELS[workspace.mode],
                },
                ...Arr.map(SCOPED_SETTING_IDS, (id) => row(id, inEffect[id])),
              ],
            },
            ...Arr.map(editableScopes(trusted), (scope) => ({
              title: SCOPE_LABELS[scope],
              rows: Arr.map(SCOPED_SETTING_IDS, (id) => {
                const own = ownValue(inspection, scope, id);
                return row(
                  id,
                  own === INHERIT ? settingInherited(inheritedValue(inspection, scope, id)) : own,
                );
              }),
            })),
          ],
          notes: [
            `Worktree hooks: ${hooks.WorktreeCreate.length} on create and ${hooks.WorktreeRemove.length} on remove; changes apply after /reload.`,
            ...Arr.filter([unresolvedSummary(workspace)], Predicate.isString),
          ],
        });
      },
    );
  };

  // What each row shows, kept current through the picker's saves: a scope's own value or
  // `inherit`, and the writer workspace by its label. Inherited labels derive from it live.
  const committed = new Map<string, string>();
  let opened: ProfileSettingsInspection | undefined;
  const rowId = (id: string, scope: string | undefined) =>
    id === WORKSPACE ? id : `${settingScope(scope)}:${id}`;

  /** The value a scope inherits now: the project follows global's value as last saved. */
  const liveInherited = (
    inspection: ProfileSettingsInspection,
    scope: ProfileSettingsScope,
    id: typeof DELEGATION | NestingField,
  ): string => {
    const global = scope === "project" ? committed.get(rowId(id, "global")) : undefined;
    if (global === undefined) return inheritedValue(inspection, scope, id);
    return global === INHERIT ? inheritedValue(inspection, "global", id) : global;
  };

  const scopedRow = (
    inspection: ProfileSettingsInspection,
    scope: ProfileSettingsScope,
    id: typeof DELEGATION | NestingField,
  ): SettingItem =>
    scopedSettingItem(
      scope,
      id,
      committed.get(rowId(id, scope)) ?? ownValue(inspection, scope, id),
      liveInherited(inspection, scope, id),
    );

  const shownRowValue = (id: string, scope: string | undefined): string | undefined => {
    if (id === WORKSPACE) return committed.get(WORKSPACE);
    if (opened === undefined || (id !== DELEGATION && !isNestingField(id))) return undefined;
    return scopedRow(opened, settingScope(scope), id).currentValue;
  };

  const open = (ctx: ExtensionCommandContext, session: SettingsSession<undefined>) => {
    if (!actions.isAvailable()) return Promise.resolve({ _tag: "Blocked" as const });
    const trusted = isProjectTrusted(ctx);
    return Promise.all([actions.inspectWriterWorkspace(), actions.inspectProfiles(trusted)]).then(
      ([workspace, inspection]) => {
        const scopes = editableScopes(trusted);
        const unresolved = unresolvedSummary(workspace);
        opened = inspection;
        committed.clear();
        committed.set(WORKSPACE, WRITER_WORKSPACE_LABELS[workspace.mode]);
        for (const scope of scopes)
          for (const id of SCOPED_SETTING_IDS)
            committed.set(rowId(id, scope), ownValue(inspection, scope, id));
        const items: SettingItem[] = [
          {
            id: WORKSPACE,
            label: WORKSPACE_LABEL,
            description: `${WORKSPACE_DESCRIPTION}${unresolved ? ` ${unresolved}` : ""}`,
            currentValue: WRITER_WORKSPACE_LABELS[workspace.mode],
            values: Arr.map(WRITER_WORKSPACE_MODES, (mode) => WRITER_WORKSPACE_LABELS[mode]),
          },
        ];
        // Each scope is one group row, so the list reads by scope instead of repeating it. Its
        // rows and summary derive on demand, so a global save shows in the project's inherited
        // values at once.
        const groups = Arr.map(scopes, (scope): SettingsSurfaceItem => {
          const children = () =>
            Arr.map(SCOPED_SETTING_IDS, (id) => scopedRow(inspection, scope, id));
          const summary = () =>
            scopeGroupSummary(
              Arr.map(
                SCOPED_SETTING_IDS,
                (id) => [id, scopedRow(inspection, scope, id).currentValue] as const,
              ),
            );
          return {
            id: `group:${scope}`,
            label: SCOPE_LABELS[scope],
            kind: "group",
            description: SCOPE_GROUP_DESCRIPTIONS[scope],
            currentValue: summary(),
            children,
            summary,
          };
        });
        return session.picker([...items, ...groups]);
      },
    );
  };

  const apply = (
    ctx: ExtensionCommandContext,
    id: string,
    chosen: string,
    scope: ProfileSettingsScope,
  ): Promise<SettingsResult> => {
    const value = inheritChoice(chosen);
    if (id === WORKSPACE) return applyWorkspace(value);
    if (id === DELEGATION) return applyDelegation(ctx, value, scope);
    if (!isNestingField(id)) return Promise.resolve(failed(`Unknown setting: ${id}`));
    return applyNesting(ctx, id, value, scope);
  };

  return settingsSubcommand<undefined>({
    owner: saveOwner,
    root: "subagents",
    isCurrent,
    description: SUBAGENT_SETTINGS_COMMAND.description,
    title: "Subagents",
    descriptors: SUBAGENT_SETTING_DESCRIPTORS,
    examples: [
      "delegation orchestration",
      "global delegation encouraged",
      "writerWorkspace worktree",
      "global maxDepth 2",
      "session maxDirectChildren inherit",
    ],
    notes: () => [
      `Delegation and nesting limits apply to the named scope, session by default. Session changes apply now; global and project changes after /reload, and project wins. ${INHERIT} clears a scope's own value.`,
      "The writer workspace default applies to later launches and new sessions and ignores the scope; running writers and existing workspaces keep their mode.",
    ],
    scopes: SCOPES,
    scopeBlocked: (ctx, scope) =>
      scope === "project" && !isProjectTrusted(ctx) ? UNTRUSTED : undefined,
    config: () => undefined,
    status: statusText,
    // Rows show a change as soon as it is chosen, so values derived from it do too; a save that
    // fails or can't run puts back the value it replaced, and open groups derive their rows again.
    apply: (ctx, id, value, _signal, scope) => {
      const key = rowId(id, scope);
      const chosen = id === WORKSPACE ? shownValue(id, value) : inheritChoice(value);
      const replaced = committed.get(key);
      committed.set(key, chosen);
      const restore = () => {
        if (committed.get(key) !== chosen) return;
        if (replaced === undefined) committed.delete(key);
        else committed.set(key, replaced);
      };
      return apply(ctx, id, value, settingScope(scope)).then(
        (result) => {
          if (Result.isFailure(result)) restore();
          return result;
        },
        (cause: unknown) => {
          restore();
          throw cause;
        },
      );
    },
    displayValue: (_ctx, id, scope) => shownRowValue(id, scope),
    open,
  });
}
