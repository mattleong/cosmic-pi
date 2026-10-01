import { managerNoticeGlyph } from "pi-cosmic-ui/manager";
import { PROFILE_DEFINITIONS } from "../../profiles/definitions.ts";
import {
  isLocalPiProfileCandidate,
  supportsSubagentFastMode,
  type ProfileCandidate,
  type ProfileId,
} from "../../profiles/model.ts";
import type { SubagentEffort } from "../../domain/routing.ts";
import {
  loadProfileRouteDraft,
  profileWorkspaceScope,
  runtimeEfforts,
  runtimeLabel,
  updateCandidateControls,
  type CandidateUpdate,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
  type ProfileSettingsScope,
  type ProfileWorkspaceTarget,
} from "../profile-route-editor.ts";

export type ProfileWorkspacePane = "profiles" | "fields";
export type ProfileWorkspaceField =
  | "model"
  | "effort"
  | "writeIntent"
  | "runWith"
  | "advanced"
  | "context"
  | "openaiFastMode"
  | "actions"
  | "add"
  | "reset";

export interface ProfileWorkspaceFieldRow {
  readonly field: ProfileWorkspaceField;
  readonly label: string;
  readonly value: string;
  readonly fixed: boolean;
  readonly fixedReason?: string | undefined;
}

export interface CandidateFieldChangeOptions {
  readonly supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined;
  readonly fastModeAvailable?: boolean | undefined;
  readonly profile?: ProfileId | undefined;
  readonly parentEffort?: SubagentEffort | undefined;
}

export interface CandidateFieldChoice {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

export const profileRouteOptionLabel = (index: number): string =>
  index <= 0 ? "Primary" : `Fallback ${index}`;

export const draftKindLabel = (draft: ProfileRouteDraft, scope: ProfileSettingsScope): string => {
  switch (draft.kind) {
    case "explicit":
      return "custom";
    case "disabled":
      return "disabled";
    case "invalid":
      return `${managerNoticeGlyph("error")} invalid, won't run until fixed`;
    case "inherit":
      return scope === "session" ? "unchanged" : "uses Global or built-in default";
    case "reset":
      return scope === "global" ? "built-in default" : "default";
  }
};

const profileDefaultEffort = (profile: ProfileId): SubagentEffort | undefined => {
  const definition = PROFILE_DEFINITIONS[profile];
  return "defaultEffort" in definition ? definition.defaultEffort : undefined;
};

export const effectiveCandidateEffort = (
  profile: ProfileId,
  candidate: ProfileCandidate,
  parentEffort: SubagentEffort,
): SubagentEffort =>
  candidate.effort === "default"
    ? (profileDefaultEffort(profile) ?? parentEffort)
    : candidate.effort;

export const candidateEffortLabel = (
  profile: ProfileId,
  candidate: ProfileCandidate,
  parentEffort: SubagentEffort,
): string => {
  const effective = effectiveCandidateEffort(profile, candidate, parentEffort);
  return candidate.effort === "default" ? `${effective} (profile default)` : effective;
};

const candidateFastModeAvailable = (
  candidate: ProfileCandidate,
  parentModel: string | undefined,
): boolean => {
  const model =
    candidate.runtime === "pi" && candidate.model === "parent" ? parentModel : candidate.model;
  return model !== undefined && supportsSubagentFastMode(candidate.runtime, model);
};

export const candidateFastModeApplied = (
  candidate: ProfileCandidate,
  parentModel?: string | undefined,
): boolean =>
  candidate.openaiFastMode === true && candidateFastModeAvailable(candidate, parentModel);

export const runWithValue = (candidate: ProfileCandidate): string =>
  `${candidate.host}/${candidate.runtime}`;

export const runWithLabel = (candidate: Pick<ProfileCandidate, "host" | "runtime">): string =>
  `Local ${runtimeLabel(candidate.runtime)}`;

export const targetProfilePrimarySummary = (
  inspection: ProfileSettingsInspection,
  target: ProfileWorkspaceTarget,
  profile: ProfileId,
  draft: ProfileRouteDraft = loadProfileRouteDraft(inspection, target, profile),
): string => {
  const kind = draftKindLabel(draft, profileWorkspaceScope(target));
  const primary = draft.candidates[0];
  if (primary) return `${kind} · ${primary.model}`;
  return draft.kind === "disabled" || draft.kind === "invalid" ? kind : `${kind} · disabled`;
};

const advancedSummaryValues = (
  candidate: ProfileCandidate,
  parentModel: string | undefined,
): ReadonlyArray<string> =>
  [
    isLocalPiProfileCandidate(candidate) && candidate.context === "fork"
      ? "forked context"
      : undefined,
    candidateFastModeApplied(candidate, parentModel) ? "fast mode" : undefined,
  ].filter((value): value is string => value !== undefined);

const advancedCandidateRows = (
  candidate: ProfileCandidate,
  parentModel: string | undefined,
): ReadonlyArray<ProfileWorkspaceFieldRow> => {
  const localPi = isLocalPiProfileCandidate(candidate);
  const fastAvailable = candidateFastModeAvailable(candidate, parentModel);
  const fastFixed = !fastAvailable && !candidate.openaiFastMode;
  return [
    {
      field: "context",
      label: "  Context",
      value: candidate.context,
      fixed: !localPi,
      ...(!localPi && { fixedReason: "Fork is available only with Local Pi." }),
    },
    {
      field: "openaiFastMode",
      label: "  OpenAI fast mode",
      value: fastAvailable
        ? candidate.openaiFastMode
          ? "on, priority"
          : "off, standard"
        : candidate.openaiFastMode
          ? "on, but unavailable"
          : "off, unavailable",
      fixed: fastFixed,
      ...(fastFixed && { fixedReason: "The selected model does not support OpenAI fast mode." }),
    },
  ];
};

export const candidateFieldRows = (
  candidate: ProfileCandidate,
  profile?: ProfileId,
  parentEffort: SubagentEffort = "high",
  parentModel?: string | undefined,
  advancedExpanded = false,
  candidateIndex = 0,
): ReadonlyArray<ProfileWorkspaceFieldRow> => {
  const advancedValues = advancedSummaryValues(candidate, parentModel);
  return [
    { field: "model", label: "Model", value: candidate.model, fixed: false },
    {
      field: "effort",
      label: "Reasoning",
      value: profile ? candidateEffortLabel(profile, candidate, parentEffort) : candidate.effort,
      fixed: false,
    },
    { field: "writeIntent", label: "File access", value: candidate.writeIntent, fixed: false },
    { field: "runWith", label: "Run with", value: runWithLabel(candidate), fixed: false },
    {
      field: "advanced",
      label: advancedExpanded ? "Advanced ▾" : "Advanced ▸",
      value: advancedExpanded
        ? ""
        : advancedValues.length > 0
          ? advancedValues.join(", ")
          : "all standard",
      fixed: false,
    },
    ...(advancedExpanded ? advancedCandidateRows(candidate, parentModel) : []),
    {
      field: "actions",
      label: `Manage ${profileRouteOptionLabel(candidateIndex)}…`,
      value: "",
      fixed: false,
    },
  ];
};

export type SelectableCandidateField = Exclude<
  ProfileWorkspaceField,
  "model" | "advanced" | "actions" | "add" | "reset"
>;

const RUN_WITH_CHOICES = (["local"] as const).flatMap((host) =>
  (["pi", "claude", "codex"] as const).map((runtime) => ({
    value: `${host}/${runtime}`,
    label: runWithLabel({ host, runtime }),
    description: `Run ${runtime === "pi" ? "Pi" : runtime === "claude" ? "Claude Code" : "Codex"} locally on this computer`,
    host,
    runtime,
  })),
);

export const runWithChoice = (
  value: string,
): Pick<ProfileCandidate, "host" | "runtime"> | undefined => {
  const choice = RUN_WITH_CHOICES.find((entry) => entry.value === value);
  return choice && { host: choice.host, runtime: choice.runtime };
};

export const candidateFieldChoices = (
  candidate: ProfileCandidate,
  field: SelectableCandidateField,
  options: CandidateFieldChangeOptions,
): ReadonlyArray<CandidateFieldChoice> => {
  if (field === "runWith") return RUN_WITH_CHOICES;
  if (field === "effort") {
    const effectiveDefault =
      (options.profile ? profileDefaultEffort(options.profile) : undefined) ?? options.parentEffort;
    return [
      {
        value: "default",
        label: effectiveDefault ? `${effectiveDefault} (profile default)` : "Profile default",
        description: "Follow the profile's default reasoning level instead of pinning an override.",
      },
      ...runtimeEfforts(candidate.runtime, options.supportedEfforts).map((effort) => ({
        value: effort,
        label: effort,
        description: `Use the ${effort} reasoning level`,
      })),
    ];
  }
  if (field === "context")
    return [
      { value: "fresh", label: "Fresh", description: "Start without earlier context" },
      ...(isLocalPiProfileCandidate(candidate)
        ? [{ value: "fork", label: "Fork", description: "Copy the current Pi context" }]
        : []),
    ];
  if (field === "writeIntent")
    return [
      {
        value: "read-only",
        label: "Read-only",
        description: "Inspect and validate, but do not change project files",
      },
      {
        value: "writer",
        label: "Writer",
        description: "May change files within its assigned safety restrictions",
      },
    ];
  if (field === "openaiFastMode") {
    const available =
      options.fastModeAvailable ??
      (candidate.model !== "parent" &&
        supportsSubagentFastMode(candidate.runtime, candidate.model));
    return [
      { value: "false", label: "Off", description: "Do not request priority service" },
      ...(available
        ? [
            {
              value: "true",
              label: "On, fast",
              description: "Request OpenAI priority service for this choice",
            },
          ]
        : []),
    ];
  }
  return [];
};

// SAFETY: Every value comes from candidateFieldChoices for the same field.
export function selectCandidateField(
  candidate: ProfileCandidate,
  field: SelectableCandidateField,
  value: string,
  options: CandidateFieldChangeOptions,
): CandidateUpdate {
  if (!candidateFieldChoices(candidate, field, options).some((choice) => choice.value === value))
    return { error: `Invalid ${field} selection.`, notices: [] };
  if (field === "runWith") {
    const choice = runWithChoice(value);
    return choice
      ? updateCandidateControls(candidate, { host: choice.host, runtime: choice.runtime }, {})
      : { error: "Invalid Run with selection.", notices: [] };
  }
  if (field === "effort") {
    const effort = runtimeEfforts(candidate.runtime, options.supportedEfforts).find(
      (entry) => entry === value,
    );
    if (value === "default") return { candidate: { ...candidate, effort: "default" }, notices: [] };
    if (effort) return { candidate: { ...candidate, effort }, notices: [] };
  }
  if (field === "context" && (value === "fresh" || value === "fork"))
    return { candidate: { ...candidate, context: value }, notices: [] };
  if (field === "writeIntent" && (value === "read-only" || value === "writer"))
    return updateCandidateControls(candidate, { writeIntent: value }, {});
  if (field === "openaiFastMode" && (value === "true" || value === "false"))
    return { candidate: { ...candidate, openaiFastMode: value === "true" }, notices: [] };
  return { error: `Invalid ${field} selection.`, notices: [] };
}
