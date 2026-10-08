/**
 * Feature switches in `/subagents settings`: one `true`, `false`, or `inherit` value per Session,
 * Global, and trusted Project scope. A Session value applies at once and lasts for the session;
 * saved values take effect after /reload.
 */
import type { SettingItem } from "@earendil-works/pi-tui";
import {
  DEFAULT_SUBAGENT_FEATURE_TOGGLES,
  SUBAGENT_FEATURE_TOGGLES,
  type SubagentFeatureToggle,
} from "../config/schema.ts";
import {
  SCOPE_LABELS,
  type ProfileSettingsInspection,
  type ProfileSettingsScope,
} from "./profile-route-editor.ts";

export const INHERIT = "inherit";
export const FEATURE_VALUES: readonly string[] = ["true", "false", INHERIT];

const FEATURE_TOGGLES = {
  ultracode: {
    label: "Ultracode",
    description:
      "Opts into multi-agent workflows: the main agent gets subagent_workflow and runs substantive tasks as workflows by default. Off, /ultracode <task> still runs one request as a workflow.",
  },
} as const satisfies Record<
  SubagentFeatureToggle,
  { readonly label: string; readonly description: string }
>;

/** The value a scope declares itself, or undefined when it inherits. */
const ownToggle = (
  inspection: ProfileSettingsInspection,
  scope: ProfileSettingsScope,
  toggle: SubagentFeatureToggle,
): boolean | undefined =>
  scope === "session" ? inspection.session.features?.[toggle] : inspection[scope]?.file[toggle];

const shown = (value: boolean | undefined): string =>
  value === undefined ? INHERIT : String(value);

/** What `inherit` falls back to in each scope. */
const inheritedValue = (scope: ProfileSettingsScope, toggle: SubagentFeatureToggle): string => {
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
  scopes: readonly ProfileSettingsScope[],
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
  scopes: readonly ProfileSettingsScope[],
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
