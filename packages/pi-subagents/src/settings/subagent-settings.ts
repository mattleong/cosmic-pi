/**
 * `/subagents settings` through the shared settings shell: the writer workspace, feature switches
 * for the global or trusted-project scope, and nesting limits for the session, global, or
 * trusted-project scope.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text, type SettingItem } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import {
  failureMessage,
  invokeHostCallback,
  isProjectTrusted,
  type ExtensionSubcommand,
} from "pi-cosmic-core";
import {
  settingsSubcommand,
  type SettingsCommandOptions,
} from "pi-cosmic-ui/boundary/host-settings-command";
import { openOwnedSurfacePromise } from "pi-cosmic-ui/boundary/host-surface";
import {
  createSettingsListSurface,
  managerSettingsTheme,
  settingsRowGenerations,
} from "pi-cosmic-ui/manager/settings-surface";
import {
  MAX_DIRECT_CHILDREN,
  MAX_SUBAGENT_DEPTH,
  MIN_DIRECT_CHILDREN,
  MIN_SUBAGENT_DEPTH,
  WRITER_WORKSPACE_MODES,
  isSubagentFeatureToggle,
  type SubagentNestingPolicy,
  type WriterWorkspaceMode,
} from "../config/schema.ts";
import type { WriterWorkspaceBlockCode } from "../run/workspace-control.ts";
import type { FleetManagerActions } from "./controller.ts";
import {
  applyFeatureToggle,
  featureToggleDescriptors,
  featureToggleItems,
  featureToggleStatusLines,
  type FeatureScope,
  type SettingsResult,
} from "./feature-settings.ts";
import type { ProfileSettingsInspection } from "./profile-route-editor.ts";
import { profileSetPatchBase } from "./profile-write-context.ts";

type NestingScope = "session" | "global" | "project";
type NestingField = keyof SubagentNestingPolicy;

const INHERIT = "inherit";
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
  { name: "session", description: "Change nesting limits for this session only" },
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

const WORKSPACE_LABELS = {
  worktree: "worktree",
  "shared-checkout": "shared-checkout",
} satisfies Record<WriterWorkspaceMode, string>;

const isWorkspaceMode = (value: string): value is WriterWorkspaceMode =>
  WRITER_WORKSPACE_MODES.some((mode) => mode === value);

/** The limits a scope sets itself, or undefined when it inherits them. */
const scopeNesting = (
  inspection: ProfileSettingsInspection,
  scope: NestingScope,
): SubagentNestingPolicy | undefined =>
  scope === "session"
    ? inspection.session.nesting
    : scope === "project"
      ? inspection.project?.file.nesting
      : inspection.global.file.nesting;

const effectiveNesting = (inspection: ProfileSettingsInspection): SubagentNestingPolicy =>
  inspection.session.nesting ?? inspection.session.effectiveConfig.nesting;

const parseLimit = (field: NestingField, value: string): number | undefined => {
  const { minimum, maximum } = NESTING_FIELDS[field];
  const parsed = /^(?:0|[1-9][0-9]*)$/u.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
};

const failed = (message: string): SettingsResult => Result.fail({ message });
const succeeded: SettingsResult = Result.succeed(undefined);

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
          return actions.setWriterWorkspaceMode(value).then(
            () => succeeded,
            (error) =>
              failed(
                `Couldn't change the writer workspace: ${failureMessage(
                  error instanceof Error ? error.message : "",
                  "unknown error",
                )}`,
              ),
          );
        }),
    );

  const applyNesting = (
    ctx: ExtensionCommandContext,
    field: NestingField,
    value: string,
    scope: NestingScope,
  ): Promise<SettingsResult> => {
    const limit = value === INHERIT ? undefined : parseLimit(field, value);
    if (value !== INHERIT && limit === undefined) {
      const { minimum, maximum } = NESTING_FIELDS[field];
      return Promise.resolve(
        failed(`${field} must be a whole number from ${minimum} to ${maximum}`),
      );
    }
    const trusted = isProjectTrusted(ctx);
    if (scope === "project" && !trusted) return Promise.resolve(failed(UNTRUSTED));
    return current((isCurrent) =>
      actions
        .inspectProfiles(trusted)
        .then((inspection): SettingsResult | Promise<SettingsResult> => {
          if (!isCurrent()) return succeeded;
          const base = scopeNesting(inspection, scope) ?? effectiveNesting(inspection);
          const nesting = limit === undefined ? undefined : { ...base, [field]: limit };
          const patch = nesting ? { nesting } : {};
          // Trust is rechecked right before a project write: it may change while inspecting.
          if (scope === "project" && !isProjectTrusted(ctx)) return failed(UNTRUSTED);
          const save =
            scope === "session"
              ? actions.patchSessionNesting({
                  expectedRevision: inspection.session.revision,
                  ...patch,
                })
              : actions.patchNesting({
                  ...profileSetPatchBase(inspection, scope, isProjectTrusted(ctx)),
                  ...patch,
                });
          return save.then(
            () => succeeded,
            (error) =>
              failed(
                `Couldn't save the nesting limits: ${failureMessage(
                  error instanceof Error ? error.message : "",
                  "unknown error",
                )}`,
              ),
          );
        }),
    );
  };

  const statusText = (ctx: ExtensionCommandContext): Promise<string> =>
    !actions.isAvailable()
      ? Promise.reject(new Error("Subagents are not active"))
      : Promise.all([
          actions.inspectWriterWorkspace(),
          actions.inspectProfiles(isProjectTrusted(ctx)),
        ]).then(([workspace, inspection]) => {
          const trusted = isProjectTrusted(ctx);
          const scopeLine = (scope: NestingScope) => {
            const own = scopeNesting(inspection, scope);
            return own
              ? `  ${scope}: maxDirectChildren = ${own.maxDirectChildren}, maxDepth = ${own.maxDepth}`
              : `  ${scope}: ${INHERIT}`;
          };
          const effective = effectiveNesting(inspection);
          return [
            "Subagents settings",
            `  ${WORKSPACE} = ${WORKSPACE_LABELS[workspace.mode]}${workspace.blockedCode ? ` (${WORKSPACE_BLOCKS[workspace.blockedCode]})` : ""}`,
            `  maxDirectChildren = ${effective.maxDirectChildren}, maxDepth = ${effective.maxDepth} (in effect)`,
            "Nesting limits by scope:",
            scopeLine("session"),
            scopeLine("global"),
            ...(trusted ? [scopeLine("project")] : []),
            ...featureToggleStatusLines(inspection, trusted ? ["global", "project"] : ["global"]),
          ].join("\n");
        });

  const open = (
    ctx: ExtensionCommandContext,
    session: Parameters<SettingsCommandOptions<undefined>["open"]>[1],
  ) => {
    if (!actions.isAvailable()) return Promise.resolve({ _tag: "Blocked" as const });
    const trusted = isProjectTrusted(ctx);
    return Promise.all([actions.inspectWriterWorkspace(), actions.inspectProfiles(trusted)]).then(
      ([workspace, inspection]) => {
        const scopes: readonly NestingScope[] = trusted
          ? ["session", "global", "project"]
          : ["session", "global"];
        const featureScopes: readonly FeatureScope[] = trusted ? ["global", "project"] : ["global"];
        const withCurrent = (values: readonly string[], currentValue: string) =>
          values.includes(currentValue) ? [...values] : [currentValue, ...values];
        const items: SettingItem[] = [
          {
            id: WORKSPACE,
            label: "Writer workspace",
            description: `Where writer subagents make changes. Saved for new sessions.${workspace.blockedCode ? ` ${WORKSPACE_BLOCKS[workspace.blockedCode]}.` : ""}`,
            currentValue: WORKSPACE_LABELS[workspace.mode],
            values: Object.values(WORKSPACE_LABELS),
          },
          ...featureToggleItems(inspection, featureScopes),
          ...scopes.flatMap((scope) =>
            NESTING_FIELD_IDS.map((field) => {
              const own = scopeNesting(inspection, scope);
              const currentValue = own ? String(own[field]) : INHERIT;
              return {
                id: `${scope}:${field}`,
                label: `${scope[0]!.toUpperCase()}${scope.slice(1)} · ${NESTING_FIELDS[field].label}`,
                description: `${NESTING_FIELDS[field].description} ${INHERIT} uses the next scope's limits.${scope === "session" ? "" : " Takes effect after /reload."}`,
                currentValue,
                values: withCurrent([...NESTING_FIELDS[field].presets, INHERIT], currentValue),
              };
            }),
          ),
        ];
        const generations = settingsRowGenerations();
        return openOwnedSurfacePromise<undefined>(ctx, {
          placement: "inline",
          closedValue: undefined,
          create: ({ tui, theme, keybindings, finish }) =>
            createSettingsListSurface({
              header: new Text(theme.fg("accent", theme.bold("Subagents settings")), 1, 1),
              items,
              height: Math.min(12, items.length + 2),
              listTheme: managerSettingsTheme(theme),
              onChange: (id, value, list) => {
                const [scope, field] = id.includes(":") ? id.split(":") : [undefined, id];
                const generation = generations.begin(id);
                void session.apply(
                  field ?? id,
                  value,
                  (shown) => {
                    if (!generations.isCurrent(id, generation)) return false;
                    invokeHostCallback(() => {
                      list.updateValue(id, shown);
                      tui.requestRender();
                    }, undefined);
                    return true;
                  },
                  scope,
                );
              },
              onCancel: () => finish(undefined),
              matchesKeybinding: invokeHostCallback(
                () => Predicate.isFunction(keybindings?.matches),
                false,
              )
                ? (data, bindingId) =>
                    invokeHostCallback(() => keybindings.matches(data, bindingId), false)
                : undefined,
              requestRender: () => invokeHostCallback(() => tui.requestRender(), undefined),
              dim: (text) => invokeHostCallback(() => theme.fg("dim", text), text),
              bridge: { invoke: invokeHostCallback },
            }).surface,
        });
      },
    );
  };

  return settingsSubcommand<undefined>({
    root: "subagents",
    description: "Configure the writer workspace, subagent features, and nesting limits",
    title: "Subagents",
    descriptors: [
      {
        id: WORKSPACE,
        description: "Where writer subagents make changes. Saved for new sessions.",
        values: Object.values(WORKSPACE_LABELS),
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
      "global scriptedWorkflows false",
      "project automaticProfileRouting inherit",
      "global maxDepth 2",
      "session maxDirectChildren inherit",
    ],
    notes: () => [
      "Nesting limits apply to the named scope, session by default. Session changes apply now;",
      `global and project changes after /reload. ${INHERIT} clears a scope's own limits.`,
      "Feature switches need global or project and take effect after /reload; project wins.",
      "The writer workspace applies to new sessions and ignores the scope.",
    ],
    scopes: SCOPES,
    scopeBlocked: (ctx, scope) =>
      scope === "project" && !isProjectTrusted(ctx) ? UNTRUSTED : undefined,
    config: () => undefined,
    status: statusText,
    apply: (ctx, id, value, _signal, scope) => {
      if (id === WORKSPACE) return applyWorkspace(value);
      if (isSubagentFeatureToggle(id))
        return applyFeatureToggle(
          { actions, current, untrusted: UNTRUSTED },
          ctx,
          id,
          value,
          scope,
        );
      if (!isNestingField(id)) return Promise.resolve(failed(`Unknown setting: ${id}`));
      const target: NestingScope = scope === "global" || scope === "project" ? scope : "session";
      return applyNesting(ctx, id, value, target);
    },
    afterApply: () => undefined,
    open,
  });
}
