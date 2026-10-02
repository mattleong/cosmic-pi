/**
 * Feature switches in `/subagents settings`: one `true`, `false`, or `inherit` value per Global and
 * trusted Project scope. Saved values take effect after /reload; there is no session scope.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import * as Result from "effect/Result";
import { failureMessage, isProjectTrusted } from "pi-cosmic-core";
import { SUBAGENT_FEATURE_TOGGLES, type SubagentFeatureToggle } from "../config/schema.ts";
import type { FleetManagerActions } from "./controller.ts";
import type { ProfileSettingsInspection } from "./profile-route-editor.ts";
import { profileSetPatchBase } from "./profile-write-context.ts";

export type SettingsResult = Result.Result<
  undefined,
  { readonly message: string; readonly stale?: boolean }
>;

export type FeatureScope = "global" | "project";

const INHERIT = "inherit";
const FEATURE_VALUES: readonly string[] = ["true", "false", INHERIT];

interface FeatureToggleInfo {
  readonly label: string;
  readonly description: string;
}

const FEATURE_TOGGLES = {
  scriptedWorkflows: {
    label: "Scripted subagent workflows",
    description:
      "Lets native codemode scripts start, await, check, and stop subagents. Off removes only these subagent tools from scripts; codemode itself and direct subagent calls stay available.",
  },
} as const satisfies Record<SubagentFeatureToggle, FeatureToggleInfo>;

const failed = (message: string): SettingsResult => Result.fail({ message });
const succeeded: SettingsResult = Result.succeed(undefined);

/** The value a scope's own document declares, or undefined when it inherits. */
const ownToggle = (
  inspection: ProfileSettingsInspection,
  scope: FeatureScope,
  toggle: SubagentFeatureToggle,
): boolean | undefined =>
  scope === "project" ? inspection.project?.file[toggle] : inspection.global.file[toggle];

const shown = (value: boolean | undefined): string =>
  value === undefined ? INHERIT : String(value);

const scopeLabel = (scope: FeatureScope): string => (scope === "project" ? "Project" : "Global");

/** Help and completion descriptors; the shared settings shell validates their values. */
export const featureToggleDescriptors = SUBAGENT_FEATURE_TOGGLES.map((toggle) => ({
  id: toggle,
  description: `${FEATURE_TOGGLES[toggle].label}. Global or project; takes effect after /reload.`,
  values: [...FEATURE_VALUES],
  currentValue: () => "",
}));

/** Picker rows for each editable scope, showing what that scope's own file declares. */
export const featureToggleItems = (
  inspection: ProfileSettingsInspection,
  scopes: readonly FeatureScope[],
): SettingItem[] =>
  scopes.flatMap((scope) =>
    SUBAGENT_FEATURE_TOGGLES.map((toggle) => {
      const inherited = scope === "project" ? "the global value" : "the default, true";
      return {
        id: `${scope}:${toggle}`,
        label: `${scopeLabel(scope)} · ${FEATURE_TOGGLES[toggle].label}`,
        description: `${FEATURE_TOGGLES[toggle].description} This session uses ${String(inspection.session.effectiveConfig[toggle])}; ${INHERIT} uses ${inherited}. Takes effect after /reload.`,
        currentValue: shown(ownToggle(inspection, scope, toggle)),
        values: [...FEATURE_VALUES],
      };
    }),
  );

/** `status` lines: the values this session runs with, then each scope's own declarations. */
export const featureToggleStatusLines = (
  inspection: ProfileSettingsInspection,
  scopes: readonly FeatureScope[],
): string[] => [
  "Features in effect:",
  ...SUBAGENT_FEATURE_TOGGLES.map(
    (toggle) => `  ${toggle} = ${String(inspection.session.effectiveConfig[toggle])}`,
  ),
  "Features by scope (take effect after /reload):",
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

/** Saves or clears one scope's switch against the document it inspected, rechecking trust. */
export const applyFeatureToggle = (
  host: FeatureToggleSettingsHost,
  ctx: ExtensionCommandContext,
  toggle: SubagentFeatureToggle,
  value: string,
  scope: string | undefined,
): Promise<SettingsResult> => {
  if (scope !== "global" && scope !== "project")
    return Promise.resolve(
      failed(`${toggle} can't be set for one session; name global or project`),
    );
  if (!FEATURE_VALUES.includes(value))
    return Promise.resolve(failed(`${toggle} must be true, false, or ${INHERIT}`));
  const enabled = value === INHERIT ? undefined : value === "true";
  const trusted = isProjectTrusted(ctx);
  if (scope === "project" && !trusted) return Promise.resolve(failed(host.untrusted));
  return host.current((isCurrent) =>
    host.actions
      .inspectProfiles(trusted)
      .then((inspection): SettingsResult | Promise<SettingsResult> => {
        if (!isCurrent()) return succeeded;
        // Trust is rechecked right before a project write: it may change while inspecting.
        const projectTrusted = isProjectTrusted(ctx);
        if (scope === "project" && !projectTrusted) return failed(host.untrusted);
        return host.actions
          .patchFeatureToggle({
            ...profileSetPatchBase(inspection, scope, projectTrusted),
            toggle,
            ...(enabled !== undefined && { enabled }),
          })
          .then(
            () => succeeded,
            (error) =>
              failed(
                `Couldn't save ${toggle}: ${failureMessage(
                  error instanceof Error ? error.message : "",
                  "unknown error",
                )}`,
              ),
          );
      }),
  );
};
