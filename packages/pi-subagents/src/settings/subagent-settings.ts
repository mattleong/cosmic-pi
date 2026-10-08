/**
 * `/subagents settings` through the shared settings shell: the writer workspace, and feature
 * switches and nesting limits for the session, global, or trusted-project scope.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { failureMessage, isProjectTrusted, type ExtensionSubcommand } from "pi-cosmic-core";
import {
  settingsSubcommand,
  type SettingsSession,
} from "pi-cosmic-ui/boundary/host-settings-command";
import {
  DEFAULT_SUBAGENT_NESTING_POLICY,
  MAX_DIRECT_CHILDREN,
  MAX_SUBAGENT_DEPTH,
  MIN_DIRECT_CHILDREN,
  MIN_SUBAGENT_DEPTH,
  WRITER_WORKSPACE_MODES,
  WriterWorkspaceModeSchema,
  isSubagentFeatureToggle,
  type SubagentFeatureToggle,
  type SubagentNestingPolicy,
} from "../config/schema.ts";
import type { WriterWorkspaceBlockCode } from "../run/workspace-control.ts";
import type { FleetManagerActions } from "./controller.ts";
import {
  FEATURE_VALUES,
  INHERIT,
  featureToggleDescriptors,
  featureToggleItems,
  featureToggleStatusLines,
} from "./feature-settings.ts";
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
  { name: "session", description: "Change features and nesting limits for this session only" },
  { name: "global", description: "Change features and nesting limits for new sessions everywhere" },
  { name: "project", description: "Change features and nesting limits for this trusted project" },
] as const;

const UNTRUSTED = "Trust this project before changing its subagent settings";

/** The coordinator's reasons name workspaces and paths for the agent; people get the gist. */
const WORKSPACE_BLOCKS = {
  "writers-active": "Can't change the writer workspace while writer subagents are active",
  "records-unavailable": "Can't change the writer workspace: its recovery records can't be read",
  "unresolved-workspace":
    "Can't change the writer workspace until an earlier writer's changes are integrated or discarded",
} satisfies Record<WriterWorkspaceBlockCode, string>;

const isWorkspaceMode = Schema.is(WriterWorkspaceModeSchema);

const settingScope = (scope: string | undefined): ProfileSettingsScope =>
  scope === "global" || scope === "project" ? scope : "session";

const editableScopes = (trusted: boolean): readonly ProfileSettingsScope[] =>
  trusted ? ["session", "global", "project"] : ["session", "global"];

/** The limits a scope sets itself, or undefined when it inherits them. */
const scopeNesting = (
  inspection: ProfileSettingsInspection,
  scope: ProfileSettingsScope,
): SubagentNestingPolicy | undefined =>
  scope === "session" ? inspection.session.nesting : inspection[scope]?.file.nesting;

/** What a scope without its own limits inherits: the next scope's, as its rows describe. */
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

export function subagentSettingsSubcommand(actions: FleetManagerActions): ExtensionSubcommand {
  /**
   * Runs only while this session is current: a replaced or stopped session must not change its
   * successor, and says nothing once it has been replaced.
   */
  const current = (
    run: (isCurrent: () => boolean) => Promise<SettingsResult>,
  ): Promise<SettingsResult> => {
    if (!actions.isAvailable()) return Promise.reject(new Error("Subagents are not active"));
    const owner = actions.captureModelRefresh();
    const isCurrent = () => owner.isCurrent() && actions.isAvailable();
    return run(isCurrent).then((result) =>
      isCurrent() ? result : Result.fail({ message: "", stale: true }),
    );
  };

  /**
   * Writes one scope's payload against the state it inspected: the session's revision, or the
   * document a saved scope holds. The shell refuses an untrusted Project before applying; trust
   * is rechecked right before a project write, since it may change while inspecting.
   */
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
    current((isCurrent) =>
      actions
        .inspectProfiles(isProjectTrusted(ctx))
        .then((inspection): SettingsResult | Promise<SettingsResult> => {
          if (!isCurrent()) return succeeded;
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
    current((isCurrent) =>
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
          if (snapshot.mode === value || !isCurrent()) return succeeded;
          return actions
            .setWriterWorkspaceMode(value)
            .then(() => succeeded, saveFailure("change the writer workspace"));
        }),
    );

  const applyFeatureToggle = (
    ctx: ExtensionCommandContext,
    toggle: SubagentFeatureToggle,
    value: string,
    scope: ProfileSettingsScope,
  ): Promise<SettingsResult> => {
    if (!FEATURE_VALUES.includes(value))
      return Promise.resolve(failed(`${toggle} must be true, false, or ${INHERIT}`));
    const enabled = value === INHERIT ? {} : { enabled: value === "true" };
    return saveToScope(ctx, scope, `save ${toggle}`, () => ({ toggle, ...enabled }), {
      session: actions.patchSessionFeatureToggle,
      saved: actions.patchFeatureToggle,
    });
  };

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

  const statusText = (ctx: ExtensionCommandContext): Promise<string> => {
    if (!actions.isAvailable()) return Promise.reject(new Error("Subagents are not active"));
    // One trust read decides both what is inspected and which scopes are reported.
    const trusted = isProjectTrusted(ctx);
    return Promise.all([actions.inspectWriterWorkspace(), actions.inspectProfiles(trusted)]).then(
      ([workspace, inspection]) => {
        const scopes = editableScopes(trusted);
        const scopeLine = (scope: ProfileSettingsScope) => {
          const own = scopeNesting(inspection, scope);
          return own
            ? `  ${scope}: maxDirectChildren = ${own.maxDirectChildren}, maxDepth = ${own.maxDepth}`
            : `  ${scope}: ${INHERIT}`;
        };
        const effective = inspection.session.effectiveConfig.nesting;
        return [
          "Subagents settings",
          `  ${WORKSPACE} = ${workspace.mode}${workspace.blockedCode ? ` (${WORKSPACE_BLOCKS[workspace.blockedCode]})` : ""}`,
          `  maxDirectChildren = ${effective.maxDirectChildren}, maxDepth = ${effective.maxDepth} (in effect)`,
          "Nesting limits by scope:",
          ...scopes.map(scopeLine),
          ...featureToggleStatusLines(inspection, scopes),
        ].join("\n");
      },
    );
  };

  // SettingsList shows a cycled value before it is saved, so a failed or stale apply restores
  // the row's last committed value.
  const committed = new Map<string, string>();
  const rowId = (id: string, scope: string | undefined) =>
    id === WORKSPACE ? id : `${settingScope(scope)}:${id}`;

  const open = (ctx: ExtensionCommandContext, session: SettingsSession<undefined>) => {
    if (!actions.isAvailable()) return Promise.resolve({ _tag: "Blocked" as const });
    const trusted = isProjectTrusted(ctx);
    return Promise.all([actions.inspectWriterWorkspace(), actions.inspectProfiles(trusted)]).then(
      ([workspace, inspection]) => {
        const scopes = editableScopes(trusted);
        const withCurrent = (values: readonly string[], currentValue: string) =>
          values.includes(currentValue) ? [...values] : [currentValue, ...values];
        const items: SettingItem[] = [
          {
            id: WORKSPACE,
            label: "Writer workspace",
            description: `Where writer subagents make changes. Saved for new sessions.${workspace.blockedCode ? ` ${WORKSPACE_BLOCKS[workspace.blockedCode]}.` : ""}`,
            currentValue: workspace.mode,
            values: [...WRITER_WORKSPACE_MODES],
          },
          ...featureToggleItems(inspection, scopes),
          ...scopes.flatMap((scope) =>
            NESTING_FIELD_IDS.map((field) => {
              const own = scopeNesting(inspection, scope);
              const currentValue = own ? String(own[field]) : INHERIT;
              return {
                id: `${scope}:${field}`,
                label: `${SCOPE_LABELS[scope]} · ${NESTING_FIELDS[field].label}`,
                description: `${NESTING_FIELDS[field].description} ${INHERIT} uses the next scope's limits.${scope === "session" ? "" : " Takes effect after /reload."}`,
                currentValue,
                values: withCurrent([...NESTING_FIELDS[field].presets, INHERIT], currentValue),
              };
            }),
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
    if (isSubagentFeatureToggle(id)) return applyFeatureToggle(ctx, id, value, scope);
    if (!isNestingField(id)) return Promise.resolve(failed(`Unknown setting: ${id}`));
    return applyNesting(ctx, id, value, scope);
  };

  return settingsSubcommand<undefined>({
    root: "subagents",
    description: "Configure the writer workspace, subagent features, and nesting limits",
    title: "Subagents",
    descriptors: [
      {
        id: WORKSPACE,
        description: "Where writer subagents make changes. Saved for new sessions.",
        values: [...WRITER_WORKSPACE_MODES],
        currentValue: () => "",
      },
      ...featureToggleDescriptors,
      ...NESTING_FIELD_IDS.map((field) => ({
        id: field,
        description: NESTING_FIELDS[field].description,
        values: [...NESTING_FIELDS[field].presets, INHERIT],
        openValues: true,
        currentValue: () => "",
      })),
    ],
    examples: [
      "writerWorkspace worktree",
      "ultracode true",
      "global ultracode true",
      "project ultracode inherit",
      "global maxDepth 2",
      "session maxDirectChildren inherit",
    ],
    notes: () => [
      "Feature switches and nesting limits apply to the named scope, session by default. Session",
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
