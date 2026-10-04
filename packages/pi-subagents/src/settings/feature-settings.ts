/**
 * Feature switches in `/subagents settings`: one `true`, `false`, or `inherit` value per Session,
 * Global, and trusted Project scope. A Session value applies at once and lasts for the session;
 * saved values take effect after /reload.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import * as Result from "effect/Result";
import { failureMessage, isProjectTrusted } from "pi-cosmic-core";
import {
  DEFAULT_SUBAGENT_FEATURE_TOGGLES,
  SUBAGENT_FEATURE_TOGGLES,
  type SubagentFeatureToggle,
} from "../config/schema.ts";
import type { FleetManagerActions } from "./controller.ts";
import type { ProfileSettingsInspection } from "./profile-route-editor.ts";
import { profileSetPatchBase } from "./profile-write-context.ts";

export type SettingsResult = Result.Result<
  undefined,
  { readonly message: string; readonly stale?: boolean }
>;

export type FeatureScope = "session" | "global" | "project";

const INHERIT = "inherit";
const FEATURE_VALUES: readonly string[] = ["true", "false", INHERIT];

interface FeatureToggleInfo {
  readonly label: string;
  readonly description: string;
}

const FEATURE_TOGGLES = {
  ultracode: {
    label: "Ultracode",
    description:
      "Opts into multi-agent workflows: the main agent gets subagent_workflow and runs substantive tasks as workflows by default. Off, /ultracode <task> still runs one request as a workflow.",
  },
} as const satisfies Record<SubagentFeatureToggle, FeatureToggleInfo>;

const failed = (message: string): SettingsResult => Result.fail({ message });
const succeeded: SettingsResult = Result.succeed(undefined);

/** The value a scope declares itself, or undefined when it inherits. */
const ownToggle = (
  inspection: ProfileSettingsInspection,
  scope: FeatureScope,
  toggle: SubagentFeatureToggle,
): boolean | undefined => {
  if (scope === "session") return inspection.session.features?.[toggle];
  return scope === "project" ? inspection.project?.file[toggle] : inspection.global.file[toggle];
};

const shown = (value: boolean | undefined): string =>
  value === undefined ? INHERIT : String(value);

const SCOPE_LABELS = {
  session: "Session",
  global: "Global",
  project: "Project",
} as const satisfies Record<FeatureScope, string>;

/** What `inherit` falls back to in each scope. */
const inheritedValue = (scope: FeatureScope, toggle: SubagentFeatureToggle): string => {
  if (scope === "session") return "the saved value";
  if (scope === "project") return "the global value";
  return `the default, ${String(DEFAULT_SUBAGENT_FEATURE_TOGGLES[toggle])}`;
};

const effectiveLine = (inspection: ProfileSettingsInspection, toggle: SubagentFeatureToggle) => {
  const config = inspection.session.effectiveConfig;
  return `${toggle} = ${String(config[toggle])} (${config.featureSources[toggle]})`;
};

/** Help and completion descriptors; the shared settings shell validates their values. */
export const featureToggleDescriptors = SUBAGENT_FEATURE_TOGGLES.map((toggle) => ({
  id: toggle,
  description: `${FEATURE_TOGGLES[toggle].label}. Session applies now; global or project after /reload.`,
  values: [...FEATURE_VALUES],
  currentValue: () => "",
}));

/** Picker rows for each editable scope, showing what that scope declares itself. */
export const featureToggleItems = (
  inspection: ProfileSettingsInspection,
  scopes: readonly FeatureScope[],
): SettingItem[] =>
  scopes.flatMap((scope) =>
    SUBAGENT_FEATURE_TOGGLES.map((toggle) => ({
      id: `${scope}:${toggle}`,
      label: `${SCOPE_LABELS[scope]} · ${FEATURE_TOGGLES[toggle].label}`,
      description: `${FEATURE_TOGGLES[toggle].description} This session uses ${String(inspection.session.effectiveConfig[toggle])}; ${INHERIT} uses ${inheritedValue(scope, toggle)}.${scope === "session" ? "" : " Takes effect after /reload."}`,
      currentValue: shown(ownToggle(inspection, scope, toggle)),
      values: [...FEATURE_VALUES],
    })),
  );

/** `status` lines: the values this session runs with, then each scope's own declarations. */
export const featureToggleStatusLines = (
  inspection: ProfileSettingsInspection,
  scopes: readonly FeatureScope[],
): string[] => [
  "Features in effect:",
  ...SUBAGENT_FEATURE_TOGGLES.map((toggle) => `  ${effectiveLine(inspection, toggle)}`),
  "Features by scope (session applies now; global and project after /reload):",
  ...scopes.map(
    (scope) =>
      `  ${scope}: ${SUBAGENT_FEATURE_TOGGLES.map(
        (toggle) => `${toggle} = ${shown(ownToggle(inspection, scope, toggle))}`,
      ).join(", ")}`,
  ),
];

export interface FeatureToggleSettingsHost {
  readonly actions: FleetManagerActions;
  /** Runs only while the invoking session is current; a replaced session's result is stale. */
  readonly current: (
    run: (isCurrent: () => boolean) => Promise<SettingsResult>,
  ) => Promise<SettingsResult>;
  readonly untrusted: string;
}

const saveFailure =
  (toggle: SubagentFeatureToggle) =>
  (error: Error | string): SettingsResult =>
    failed(
      `Couldn't save ${toggle}: ${failureMessage(
        error instanceof Error ? error.message : "",
        "unknown error",
      )}`,
    );

/**
 * Sets or clears one scope's switch against the state it inspected: the session's revision, or
 * the document a saved scope holds, rechecking trust right before a project write.
 */
export const applyFeatureToggle = (
  host: FeatureToggleSettingsHost,
  ctx: ExtensionCommandContext,
  toggle: SubagentFeatureToggle,
  value: string,
  scope: string | undefined,
): Promise<SettingsResult> => {
  const target: FeatureScope = scope === "global" || scope === "project" ? scope : "session";
  if (!FEATURE_VALUES.includes(value))
    return Promise.resolve(failed(`${toggle} must be true, false, or ${INHERIT}`));
  const enabled = value === INHERIT ? undefined : value === "true";
  const trusted = isProjectTrusted(ctx);
  if (target === "project" && !trusted) return Promise.resolve(failed(host.untrusted));
  return host.current((isCurrent) =>
    host.actions
      .inspectProfiles(trusted)
      .then((inspection): SettingsResult | Promise<SettingsResult> => {
        if (!isCurrent()) return succeeded;
        if (target === "session")
          return host.actions
            .patchSessionFeatureToggle({
              toggle,
              ...(enabled !== undefined && { enabled }),
              expectedRevision: inspection.session.revision,
            })
            .then(() => succeeded, saveFailure(toggle));
        // Trust is rechecked right before a project write: it may change while inspecting.
        const projectTrusted = isProjectTrusted(ctx);
        if (target === "project" && !projectTrusted) return failed(host.untrusted);
        return host.actions
          .patchFeatureToggle({
            ...profileSetPatchBase(inspection, target, projectTrusted),
            toggle,
            ...(enabled !== undefined && { enabled }),
          })
          .then(() => succeeded, saveFailure(toggle));
      }),
  );
};
