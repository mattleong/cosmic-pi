import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { managerNoticeGlyph } from "pi-cosmic-ui/manager";
import { PROFILE_DEFINITIONS } from "../../profiles/definitions.ts";
import {
  MAX_PROFILE_CANDIDATES,
  supportsSubagentFastMode,
  type ProfileCandidate,
  type ProfileId,
} from "../../profiles/model.ts";
import type { SubagentEffort } from "../../domain/routing.ts";
import {
  CANDIDATE_LIMIT_REACHED,
  candidateEfforts,
  loadProfileRouteDraft,
  profileRouteOptionLabel,
  profileWorkspaceScope,
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
  | "advanced"
  | "context"
  | "openaiFastMode"
  | "actions"
  | "add"
  | "reset";

interface ProfileWorkspaceFieldRow {
  readonly field: ProfileWorkspaceField;
  readonly label: string;
  readonly value: string;
  readonly fixed: boolean;
  readonly fixedReason?: string | undefined;
}

interface CandidateFieldChangeOptions {
  readonly supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined;
  readonly fastModeAvailable?: boolean | undefined;
  readonly profile?: ProfileId | undefined;
  readonly parentEffort?: SubagentEffort | undefined;
}

interface CandidateFieldChoice {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

const draftKindLabel = (draft: ProfileRouteDraft, scope: ProfileSettingsScope): string => {
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
  return Fn.absurd(draft.kind);
};

const profileDefaultEffort = (profile: ProfileId): SubagentEffort | undefined => {
  const definition = PROFILE_DEFINITIONS[profile];
  return "defaultEffort" in definition ? definition.defaultEffort : undefined;
};

export const candidateEffortLabel = (
  profile: ProfileId,
  candidate: ProfileCandidate,
  parentEffort: SubagentEffort,
): string =>
  candidate.effort === "default"
    ? `${profileDefaultEffort(profile) ?? parentEffort} (profile default)`
    : candidate.effort;

export const candidateFastModeAvailable = (
  candidate: ProfileCandidate,
  parentModel: string | undefined,
): boolean => {
  const model = candidate.model === "parent" ? parentModel : candidate.model;
  return model !== undefined && supportsSubagentFastMode(model);
};

export const candidateFastModeApplied = (
  candidate: ProfileCandidate,
  parentModel?: string,
): boolean =>
  candidate.openaiFastMode === true && candidateFastModeAvailable(candidate, parentModel);

export const targetProfilePrimarySummary = (
  inspection: ProfileSettingsInspection,
  target: ProfileWorkspaceTarget,
  profile: ProfileId,
): string => {
  const draft = loadProfileRouteDraft(inspection, target, profile);
  const kind = draftKindLabel(draft, profileWorkspaceScope(target));
  const primary = draft.candidates[0];
  if (primary) return `${kind} · ${primary.model}`;
  return draft.kind === "disabled" || draft.kind === "invalid" ? kind : `${kind} · disabled`;
};

const advancedSummaryValues = (
  candidate: ProfileCandidate,
  parentModel: string | undefined,
): ReadonlyArray<string> =>
  Arr.filter(
    [
      candidate.context === "fork" ? "forked context" : undefined,
      candidateFastModeApplied(candidate, parentModel) ? "fast mode" : undefined,
    ],
    Predicate.isNotUndefined,
  );

const advancedCandidateRows = (
  candidate: ProfileCandidate,
  parentModel: string | undefined,
): ReadonlyArray<ProfileWorkspaceFieldRow> => {
  const fastAvailable = candidateFastModeAvailable(candidate, parentModel);
  const fastFixed = !fastAvailable && !candidate.openaiFastMode;
  return [
    {
      field: "context",
      label: "  Context",
      value: candidate.context,
      fixed: false,
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
  parentModel?: string,
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
    {
      field: "advanced",
      label: advancedExpanded ? "Advanced ▾" : "Advanced ▸",
      value: advancedExpanded
        ? ""
        : advancedValues.length > 0
          ? Arr.join(advancedValues, ", ")
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

export type ProfileWorkspaceRow = ProfileWorkspaceFieldRow &
  (
    | { readonly scope: "candidate"; readonly candidateIndex: number }
    | { readonly scope: "profile"; readonly candidateIndex?: undefined }
  );

export const profileWorkspaceRows = (
  draft: ProfileRouteDraft,
  profile: ProfileId,
  parentEffort: SubagentEffort,
  parentModel: string | undefined,
  expanded: ReadonlySet<number>,
  canUndo = false,
): ReadonlyArray<ProfileWorkspaceRow> => [
  ...Arr.flatMap(draft.candidates, (candidate, candidateIndex) =>
    Arr.map(
      candidateFieldRows(
        candidate,
        profile,
        parentEffort,
        parentModel,
        expanded.has(candidateIndex),
        candidateIndex,
      ),
      (row): ProfileWorkspaceRow => ({
        field: row.field,
        label: row.label,
        value: row.value,
        fixed: row.fixed,
        fixedReason: row.fixedReason,
        scope: "candidate",
        candidateIndex,
      }),
    ),
  ),
  {
    scope: "profile",
    field: draft.candidates.length === 0 ? "model" : "add",
    label: draft.candidates.length === 0 ? "Add model…" : "Add fallback…",
    value: Match.value(draft.kind).pipe(
      Match.when("invalid", () => "repair this profile"),
      Match.when("disabled", () => "enable this profile"),
      Match.orElse(() => ""),
    ),
    fixed: draft.candidates.length >= MAX_PROFILE_CANDIDATES,
    fixedReason: CANDIDATE_LIMIT_REACHED,
  },
  {
    scope: "profile",
    field: "reset",
    label: "Undo changes",
    value: "",
    fixed: !canUndo,
    fixedReason: "No undoable changes from this visit.",
  },
];

export type SelectableCandidateField = Exclude<
  ProfileWorkspaceField,
  "model" | "advanced" | "actions" | "add" | "reset"
>;

export const candidateFieldChoices = (
  field: SelectableCandidateField,
  options: CandidateFieldChangeOptions,
): ReadonlyArray<CandidateFieldChoice> => {
  if (field === "effort") {
    const effectiveDefault =
      (options.profile ? profileDefaultEffort(options.profile) : undefined) ?? options.parentEffort;
    return [
      {
        value: "default",
        label: effectiveDefault ? `${effectiveDefault} (profile default)` : "Profile default",
        description: "Follow the profile's default reasoning level instead of pinning an override.",
      },
      ...Arr.map(candidateEfforts(options.supportedEfforts), (effort) => ({
        value: effort,
        label: effort,
        description: `Use the ${effort} reasoning level`,
      })),
    ];
  }
  if (field === "context")
    return [
      { value: "fresh", label: "Fresh", description: "Start without earlier context" },
      { value: "fork", label: "Fork", description: "Copy the current Pi context" },
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
  if (field === "openaiFastMode")
    return [
      { value: "false", label: "Off", description: "Do not request priority service" },
      ...(options.fastModeAvailable === true
        ? [
            {
              value: "true",
              label: "On, fast",
              description: "Request OpenAI priority service for this choice",
            },
          ]
        : []),
    ];
  return [];
};

const invalidSelection = (field: SelectableCandidateField): CandidateUpdate => ({
  error: `Invalid ${field} selection.`,
  notices: [],
});

const selectEffort = (
  candidate: ProfileCandidate,
  value: string,
  options: CandidateFieldChangeOptions,
): CandidateUpdate => {
  if (value === "default") return { candidate: { ...candidate, effort: "default" }, notices: [] };
  const effort = Option.getOrUndefined(
    Arr.findFirst(candidateEfforts(options.supportedEfforts), (entry) => entry === value),
  );
  return effort ? { candidate: { ...candidate, effort }, notices: [] } : invalidSelection("effort");
};

export function selectCandidateField(
  candidate: ProfileCandidate,
  field: SelectableCandidateField,
  value: string,
  options: CandidateFieldChangeOptions,
): CandidateUpdate {
  if (!Arr.some(candidateFieldChoices(field, options), (choice) => choice.value === value))
    return invalidSelection(field);
  switch (field) {
    case "effort":
      return selectEffort(candidate, value, options);
    case "context":
      return value === "fresh" || value === "fork"
        ? { candidate: { ...candidate, context: value }, notices: [] }
        : invalidSelection(field);
    case "writeIntent":
      return value === "read-only" || value === "writer"
        ? updateCandidateControls(candidate, { writeIntent: value })
        : invalidSelection(field);
    case "openaiFastMode":
      return value === "true" || value === "false"
        ? { candidate: { ...candidate, openaiFastMode: value === "true" }, notices: [] }
        : invalidSelection(field);
  }
  return Fn.absurd(field);
}
