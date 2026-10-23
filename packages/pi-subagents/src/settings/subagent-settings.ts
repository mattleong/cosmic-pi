import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import * as Result from "effect/Result";
import { failureMessage, isProjectTrusted, type ExtensionSubcommand } from "pi-cosmic-core";
import {
  settingsSubcommand,
  withInvocationAuthority,
  type SettingsCommandOwner,
  type SettingsSession,
} from "pi-cosmic-ui/boundary/host-settings-command";
import {
  DELEGATION_MODES,
  isDelegationMode,
  MAX_DIRECT_CHILDREN,
  MAX_SUBAGENT_DEPTH,
  MIN_DIRECT_CHILDREN,
  DEFAULT_MAX_ACTIVE_RUNS,
  MIN_ACTIVE_RUNS,
  MAX_ACTIVE_RUNS,
  MIN_SUBAGENT_DEPTH,
  WRITER_WORKSPACE_MODES,
  isWriterWorkspaceMode,
  type DelegationMode,
  type SubagentNestingOverrides,
} from "../config/schema.ts";
import type { WriterWorkspaceInspection } from "../run/workspace-control.ts";
import type { FleetManagerActions } from "./controller.ts";
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
type NestingField = keyof SubagentNestingOverrides;

const WORKSPACE = "writerWorkspace";
const DELEGATION = "delegation";
const INHERIT = "inherit";

const DELEGATION_DESCRIPTION =
  "How much the main agent delegates to subagents. normal leaves its prompt unchanged, encouraged prefers subagents, and orchestration delegates nearly all substantive work.";

interface NestingFieldInfo {
  readonly label: string;
  readonly description: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly presets: readonly string[];
}

const NESTING_FIELDS = {
  maxDirectChildren: {
    label: "max children",
    description: "How many subagents one subagent may start at a time.",
    minimum: MIN_DIRECT_CHILDREN,
    maximum: MAX_DIRECT_CHILDREN,
    presets: ["4", "8", "12", "16", "32"],
  },
  maxDepth: {
    label: "max depth",
    description: "How many levels of subagents may start further subagents.",
    minimum: MIN_SUBAGENT_DEPTH,
    maximum: MAX_SUBAGENT_DEPTH,
    presets: ["0", "1", "2", "3", "5", "8"],
  },
  maxActiveRuns: {
    label: "max active",
    description: "How many subagents may run at once across the whole tree.",
    minimum: MIN_ACTIVE_RUNS,
    maximum: MAX_ACTIVE_RUNS,
    presets: ["4", "8", "16", "32", "64"],
  },
} as const satisfies Record<NestingField, NestingFieldInfo>;

const isNestingField = (id: string): id is NestingField => Object.hasOwn(NESTING_FIELDS, id);

const NESTING_FIELD_IDS = Object.keys(NESTING_FIELDS).filter(isNestingField);

const SCOPES = [
  { name: "session", description: "Change delegation and nesting limits for this session only" },
  {
    name: "global",
    description: "Change delegation and nesting limits for new sessions everywhere",
  },
  { name: "project", description: "Change delegation and nesting limits for this trusted project" },
] as const;

const UNTRUSTED = "Trust this project before changing its subagent settings";

const WORKSPACE_DESCRIPTION =
  "Default for writers that don't set isolation. Saved for new sessions.";

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
  const fields = NESTING_FIELD_IDS.flatMap((id) => {
    const value = id === field ? limit : own?.[id];
    return value === undefined ? [] : [[id, value] as const];
  });
  return fields.length === 0 ? undefined : Object.fromEntries(fields);
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

const scopedSettingItem = (
  inspection: ProfileSettingsInspection,
  scope: ProfileSettingsScope,
  id: typeof DELEGATION | NestingField,
): SettingItem => {
  const reloadNote = scope === "session" ? "" : " Takes effect after /reload.";
  if (id === DELEGATION)
    return {
      id: `${scope}:${DELEGATION}`,
      label: `${SCOPE_LABELS[scope]} · delegation`,
      description: `${DELEGATION_DESCRIPTION} ${INHERIT} uses the next scope's mode.${reloadNote}`,
      currentValue: scopeDelegation(inspection, scope) ?? INHERIT,
      values: [...DELEGATION_MODES, INHERIT],
    };
  const currentValue = ownNestingValue(scopeNesting(inspection, scope), id);
  return {
    id: `${scope}:${id}`,
    label: `${SCOPE_LABELS[scope]} · ${NESTING_FIELDS[id].label}`,
    description: `${NESTING_FIELDS[id].description} ${INHERIT} uses the next scope's limits.${reloadNote}`,
    currentValue,
    values: withCurrent([...NESTING_FIELDS[id].presets, INHERIT], currentValue),
  };
};

export function subagentSettingsSubcommand(actions: FleetManagerActions): ExtensionSubcommand {
  const captureAuthority = (): (() => boolean) => {
    if (!actions.isAvailable()) return () => !actions.isAvailable();
    const owner = actions.captureModelRefresh();
    return () => owner.isCurrent() && actions.isAvailable();
  };
  return withInvocationAuthority(captureAuthority, (isCurrent, owner) =>
    subagentSettingsCommand(actions, isCurrent, owner),
  );
}

function subagentSettingsCommand(
  actions: FleetManagerActions,
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
            return failed(`${WORKSPACE} must be ${WRITER_WORKSPACE_MODES.join(" or ")}`);
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
        failed(`${DELEGATION} must be ${DELEGATION_MODES.join(", ")}, or ${INHERIT}`),
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
        const nestingLine = (scope: ProfileSettingsScope) => {
          const own = scopeNesting(inspection, scope);
          return own
            ? `  ${scope}: ${NESTING_FIELD_IDS.map((id) => `${id} = ${ownNestingValue(own, id)}`).join(", ")}`
            : `  ${scope}: ${INHERIT}`;
        };
        const delegationLine = (scope: ProfileSettingsScope) =>
          `  ${scope}: ${scopeDelegation(inspection, scope) ?? INHERIT}`;
        const effective = inspection.session.effectiveConfig;
        const unresolved = unresolvedSummary(workspace);
        return [
          "Subagents settings",
          `  ${WORKSPACE} = ${workspace.mode} (default)${unresolved ? `; ${unresolved}` : ""}`,
          `  ${DELEGATION} = ${effective.delegation} (in effect)`,
          `  maxDirectChildren = ${effective.nesting.maxDirectChildren}, maxDepth = ${effective.nesting.maxDepth}, maxActiveRuns = ${effective.nesting.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS} (in effect)`,
          `  hooks = WorktreeCreate ${effective.hooks.WorktreeCreate.length}, WorktreeRemove ${effective.hooks.WorktreeRemove.length} (applies after /reload)`,
          "Delegation by scope:",
          ...scopes.map(delegationLine),
          "Nesting limits by scope:",
          ...scopes.map(nestingLine),
        ].join("\n");
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
          ...scopes.flatMap((scope) =>
            SCOPED_SETTING_IDS.map((id) => scopedSettingItem(inspection, scope, id)),
          ),
        ];
        for (const item of items) committed.set(item.id, item.currentValue);
        return session.picker(items);
      },
    );
  };

  const apply = (
    ctx: ExtensionCommandContext,
    id: string,
    value: string,
    scope: ProfileSettingsScope,
  ): Promise<SettingsResult> => {
    if (id === WORKSPACE) return applyWorkspace(value);
    if (id === DELEGATION) return applyDelegation(ctx, value, scope);
    if (!isNestingField(id)) return Promise.resolve(failed(`Unknown setting: ${id}`));
    return applyNesting(ctx, id, value, scope);
  };

  return settingsSubcommand<undefined>({
    owner: saveOwner,
    root: "subagents",
    isCurrent,
    description: "Configure delegation, the writer workspace, and nesting limits",
    title: "Subagents",
    descriptors: [
      {
        id: WORKSPACE,
        description: WORKSPACE_DESCRIPTION,
        values: [...WRITER_WORKSPACE_MODES],
        currentValue: () => "",
      },
      {
        id: DELEGATION,
        description: DELEGATION_DESCRIPTION,
        values: [...DELEGATION_MODES, INHERIT],
        currentValue: () => "",
      },
      ...NESTING_FIELD_IDS.map((field) => ({
        id: field,
        description: NESTING_FIELDS[field].description,
        values: [...NESTING_FIELDS[field].presets, INHERIT],
        openValues: true,
        currentValue: () => "",
      })),
    ],
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
