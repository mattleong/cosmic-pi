import {
  DELEGATION,
  DELEGATION_DESCRIPTION,
  INHERIT,
  isNestingField,
  NESTING_FIELDS,
  NESTING_FIELD_IDS,
  SCOPES,
  SUBAGENT_SETTING_DESCRIPTORS,
  SUBAGENT_SETTINGS_COMMAND,
  WORKSPACE,
  WORKSPACE_DESCRIPTION,
  type NestingField,
} from "./subagent-settings-options.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import { joinInline } from "pi-cosmic-ui/manager";
import { settingInherited, type SettingsSurfaceItem } from "pi-cosmic-ui/manager/settings-surface";
import { failureMessage } from "pi-cosmic-core/message-text";
import { isProjectTrusted } from "pi-cosmic-core/host-session";
import { type ExtensionSubcommand } from "pi-cosmic-core/host-command";
import {
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
  isWriterWorkspaceMode,
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

type SettingsResult = Result.Result<
  undefined,
  { readonly message: string; readonly stale?: boolean }
>;
const UNTRUSTED = "Trust this project before changing its subagent settings";

const unresolvedSummary = ({ unresolvedWorkspaceCount }: WriterWorkspaceInspection) =>
  unresolvedWorkspaceCount === undefined
    ? undefined
    : `Unresolved workspaces: ${unresolvedWorkspaceCount}`;

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

const withCurrent = (values: readonly string[], currentValue: string) =>
  values.includes(currentValue) ? [...values] : [currentValue, ...values];

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
  [DELEGATION]: "delegation",
  ...Rec.map(NESTING_FIELDS, (field) => field.label),
} as const satisfies Record<typeof DELEGATION | NestingField, string>;

/** One scoped setting as a row of its scope's group, which already names the scope. */
const scopedSettingItem = (
  inspection: ProfileSettingsInspection,
  scope: ProfileSettingsScope,
  id: typeof DELEGATION | NestingField,
): SettingItem => {
  const reloadNote = scope === "session" ? "" : " Takes effect after /reload.";
  const inherited = settingInherited(inheritedValue(inspection, scope, id));
  const source = `Inherit uses ${INHERITED_FROM[scope]}.`;
  const label = Str.capitalize(SCOPED_SETTING_LABELS[id]);
  if (id === DELEGATION)
    return {
      id: `${scope}:${DELEGATION}`,
      label,
      description: `${DELEGATION_DESCRIPTION} ${source}${reloadNote}`,
      currentValue: scopeDelegation(inspection, scope) ?? inherited,
      values: [...DELEGATION_MODES, inherited],
    };
  const own = ownNestingValue(scopeNesting(inspection, scope), id);
  const currentValue = own === INHERIT ? inherited : own;
  return {
    id: `${scope}:${id}`,
    label,
    description: `${NESTING_FIELDS[id].description} ${source}${reloadNote}`,
    currentValue,
    values: withCurrent([...NESTING_FIELDS[id].presets, inherited], currentValue),
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
  [DELEGATION]: (value) => `${value} delegation`,
  maxDirectChildren: (value) => `${value} children`,
  maxDepth: (value) => `depth ${value}`,
  maxActiveRuns: (value) => `${value} active`,
} as const satisfies Record<typeof DELEGATION | NestingField, (value: string) => string>;

/**
 * A scope's group value: the settings it sets itself, such as `32 children · depth 3 · 16 active`,
 * or `inherit` when it sets none.
 */
const scopeGroupSummary = (
  values: ReadonlyArray<readonly [typeof DELEGATION | NestingField, string]>,
): string => {
  const own = Arr.filter(values, ([, value]) => inheritChoice(value) !== INHERIT);
  return own.length === 0
    ? INHERIT
    : joinInline(Arr.map(own, ([id, value]) => SCOPED_SETTING_SUMMARIES[id](value)));
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
          if (!isWriterWorkspaceMode(value))
            return failed(`${WORKSPACE} must be ${Arr.join(WRITER_WORKSPACE_MODES, " or ")}`);
          if (snapshot.mode === value || !stillCurrent()) return succeeded;
          return actions
            .setWriterWorkspaceMode(value)
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
        const scopes = editableScopes(trusted);
        const shown = (scope: ProfileSettingsScope, id: typeof DELEGATION | NestingField) => {
          const own =
            id === DELEGATION
              ? scopeDelegation(inspection, scope)
              : scopeNesting(inspection, scope)?.[id];
          return own === undefined
            ? settingInherited(inheritedValue(inspection, scope, id))
            : String(own);
        };
        const nestingLine = (scope: ProfileSettingsScope) =>
          `  ${scope}: ${Fn.pipe(
            NESTING_FIELD_IDS,
            Arr.map((id) => `${id} = ${shown(scope, id)}`),
            Arr.join(", "),
          )}`;
        const delegationLine = (scope: ProfileSettingsScope) =>
          `  ${scope}: ${shown(scope, DELEGATION)}`;
        const effective = inspection.session.effectiveConfig;
        const unresolved = unresolvedSummary(workspace);
        return Arr.join(
          [
            "Subagents settings",
            `  ${WORKSPACE} = ${workspace.mode} (default)${unresolved ? `; ${unresolved}` : ""}`,
            `  ${DELEGATION} = ${effective.delegation} (in effect)`,
            `  maxDirectChildren = ${effective.nesting.maxDirectChildren}, maxDepth = ${effective.nesting.maxDepth}, maxActiveRuns = ${effective.nesting.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS} (in effect)`,
            `  hooks = WorktreeCreate ${effective.hooks.WorktreeCreate.length}, WorktreeRemove ${effective.hooks.WorktreeRemove.length} (applies after /reload)`,
            "Delegation by scope:",
            ...Arr.map(scopes, delegationLine),
            "Nesting limits by scope:",
            ...Arr.map(scopes, nestingLine),
          ],
          "\n",
        );
      },
    );
  };

  const committed = new Map<string, string>();
  const rowId = (id: string, scope: string | undefined) =>
    id === WORKSPACE ? id : `${settingScope(scope)}:${id}`;

  const open = (ctx: ExtensionCommandContext, session: SettingsSession<undefined>) => {
    if (!actions.isAvailable()) return Promise.resolve({ _tag: "Blocked" as const });
    const trusted = isProjectTrusted(ctx);
    return Promise.all([actions.inspectWriterWorkspace(), actions.inspectProfiles(trusted)]).then(
      ([workspace, inspection]) => {
        const scopes = editableScopes(trusted);
        const unresolved = unresolvedSummary(workspace);
        const items: SettingItem[] = [
          {
            id: WORKSPACE,
            label: "Writer workspace",
            description: `${WORKSPACE_DESCRIPTION}${unresolved ? ` ${unresolved}.` : ""}`,
            currentValue: workspace.mode,
            values: [...WRITER_WORKSPACE_MODES],
          },
        ];
        for (const item of items) committed.set(item.id, item.currentValue);
        // Each scope is one group row, so the list reads by scope instead of repeating it.
        const groups = Arr.map(scopes, (scope): SettingsSurfaceItem => {
          const children = Arr.map(SCOPED_SETTING_IDS, (id) =>
            scopedSettingItem(inspection, scope, id),
          );
          for (const child of children) committed.set(child.id, child.currentValue);
          const summary = () =>
            scopeGroupSummary(
              Arr.map(
                SCOPED_SETTING_IDS,
                (id) => [id, committed.get(rowId(id, scope)) ?? INHERIT] as const,
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
      "Delegation and nesting limits apply to the named scope, session by default. Session",
      `changes apply now; global and project changes after /reload, and project wins. ${INHERIT}`,
      "clears a scope's own value. The writer workspace default applies to later launches and new",
      "sessions and ignores the scope; running writers and existing workspaces keep their mode.",
    ],
    scopes: SCOPES,
    scopeBlocked: (ctx, scope) =>
      scope === "project" && !isProjectTrusted(ctx) ? UNTRUSTED : undefined,
    config: () => undefined,
    status: statusText,
    apply: (ctx, id, value, _signal, scope) =>
      apply(ctx, id, value, settingScope(scope)).then((result) => {
        if (Result.isSuccess(result)) committed.set(rowId(id, scope), value);
        return result;
      }),
    displayValue: (_ctx, id, scope) => committed.get(rowId(id, scope)),
    open,
  });
}
