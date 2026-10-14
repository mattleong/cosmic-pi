import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import { describeWorkspaceSetup } from "../boundary/workspace-setup.ts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { failureMessage, isProjectTrusted, type ExtensionSubcommand } from "pi-cosmic-core";
import {
  settingsSubcommand,
  withInvocationAuthority,
  type SettingsSession,
} from "pi-cosmic-ui/boundary/host-settings-command";
import {
  DELEGATION_MODES,
  DelegationModeSchema,
  DEFAULT_SUBAGENT_NESTING_POLICY,
  MAX_DIRECT_CHILDREN,
  MAX_SUBAGENT_DEPTH,
  MIN_DIRECT_CHILDREN,
  MIN_SUBAGENT_DEPTH,
  WRITER_WORKSPACE_MODES,
  WriterWorkspaceModeSchema,
  type DelegationMode,
  type SubagentNestingPolicy,
} from "../config/schema.ts";
import type { WriterWorkspaceBlockCode } from "../run/workspace-control.ts";
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
type NestingField = keyof SubagentNestingPolicy;

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

const WORKSPACE_BLOCKS = {
  "writers-active": "Can't change the writer workspace while writer subagents are active",
  "records-unavailable": "Can't change the writer workspace: its recovery records can't be read",
  "unresolved-workspace":
    "Can't change the writer workspace until an earlier writer's changes are integrated or discarded",
} satisfies Record<WriterWorkspaceBlockCode, string>;

const isWorkspaceMode = Schema.is(WriterWorkspaceModeSchema);
const isDelegationMode = Schema.is(DelegationModeSchema);

const settingScope = (scope: string | undefined): ProfileSettingsScope =>
  scope === "global" || scope === "project" ? scope : "session";

const editableScopes = (trusted: boolean): readonly ProfileSettingsScope[] =>
  trusted ? ["session", "global", "project"] : ["session", "global"];

const scopeNesting = (
  inspection: ProfileSettingsInspection,
  scope: ProfileSettingsScope,
): SubagentNestingPolicy | undefined =>
  scope === "session" ? inspection.session.nesting : inspection[scope]?.file.nesting;

const scopeDelegation = (
  inspection: ProfileSettingsInspection,
  scope: ProfileSettingsScope,
): DelegationMode | undefined =>
  scope === "session" ? inspection.session.delegation : inspection[scope]?.file.delegation;

const inheritedNesting = (
  inspection: ProfileSettingsInspection,
  scope: ProfileSettingsScope,
): SubagentNestingPolicy =>
  scope === "session"
    ? inspection.session.baseConfig.nesting
    : ((scope === "project" ? inspection.global.file.nesting : undefined) ??
      DEFAULT_SUBAGENT_NESTING_POLICY);

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
  const own = scopeNesting(inspection, scope);
  const currentValue = own ? String(own[id]) : INHERIT;
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
  return withInvocationAuthority(captureAuthority, (isCurrent) =>
    subagentSettingsCommand(actions, isCurrent),
  );
}

function subagentSettingsCommand(
  actions: FleetManagerActions,
  isCurrent: () => boolean,
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
          if (!isWorkspaceMode(value))
            return failed(`${WORKSPACE} must be worktree or shared-checkout`);
          if (snapshot.blockedReason)
            return failed(
              snapshot.blockedCode
                ? WORKSPACE_BLOCKS[snapshot.blockedCode]
                : "Can't change the writer workspace right now",
            );
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
      (inspection) =>
        limit === undefined
          ? {}
          : {
              nesting: {
                ...(scopeNesting(inspection, scope) ?? inheritedNesting(inspection, scope)),
                [field]: limit,
              },
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
            ? `  ${scope}: maxDirectChildren = ${own.maxDirectChildren}, maxDepth = ${own.maxDepth}`
            : `  ${scope}: ${INHERIT}`;
        };
        const delegationLine = (scope: ProfileSettingsScope) =>
          `  ${scope}: ${scopeDelegation(inspection, scope) ?? INHERIT}`;
        const effective = inspection.session.effectiveConfig;
        return [
          "Subagents settings",
          `  ${WORKSPACE} = ${workspace.mode}${workspace.blockedCode ? ` (${WORKSPACE_BLOCKS[workspace.blockedCode]})` : ""}`,
          `  ${DELEGATION} = ${effective.delegation} (in effect)`,
          `  maxDirectChildren = ${effective.nesting.maxDirectChildren}, maxDepth = ${effective.nesting.maxDepth} (in effect)`,
          `  workspaceSetup = ${effective.workspaceSetup ? describeWorkspaceSetup(effective.workspaceSetup) : "none"} (project; applies after /reload)`,
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
        const items: SettingItem[] = [
          {
            id: WORKSPACE,
            label: "Writer workspace",
            description: `Where writer subagents make changes. Saved for new sessions.${workspace.blockedCode ? ` ${WORKSPACE_BLOCKS[workspace.blockedCode]}.` : ""}`,
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
    root: "subagents",
    isCurrent,
    description: "Configure delegation, the writer workspace, and nesting limits",
    title: "Subagents",
    descriptors: [
      {
        id: WORKSPACE,
        description: "Where writer subagents make changes. Saved for new sessions.",
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
      "clears a scope's own value. The writer workspace applies to new sessions and ignores the scope.",
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
