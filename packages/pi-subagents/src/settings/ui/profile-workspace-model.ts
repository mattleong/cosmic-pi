import { fastModeMark } from "pi-better-openai/fast-models";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import { managerNoticeGlyph } from "pi-cosmic-ui/manager";
import { PROFILE_DEFINITIONS } from "../../profiles/definitions.ts";
import type { ProfileCandidate, ProfileId } from "../../profiles/model.ts";
import type { ProjectedPiModel } from "../profile-model-catalog.ts";
import type { SubagentEffort } from "../../domain/routing.ts";
import {
  candidateEfforts,
  loadProfileRouteDraft,
  profileWorkspaceScope,
  updateCandidateControls,
  type CandidateUpdate,
  type ProfileFastModes,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
  type ProfileSettingsScope,
  type ProfileWorkspaceTarget,
} from "../profile-route-editor.ts";
import { findOrUndefined } from "pi-cosmic-core/array";

export type ProfileWorkspacePane = "profiles" | "fields";

export type ProfileWorkspaceField =
  | "model"
  | "effort"
  | "writeIntent"
  | "advanced"
  | "context"
  | "openaiFastMode";

interface ProfileWorkspaceFieldRow {
  readonly field: ProfileWorkspaceField;
  readonly label: string;
  readonly value: string;
  readonly fixed: boolean;
  readonly fixedReason?: string | undefined;
}

/** Model capabilities from the current catalog, resolving inherited and unavailable models. */
export interface ProfileEditorModels {
  readonly parentModel?: string | undefined;
  readonly availableModel: (
    selector: string,
  ) => Pick<ProjectedPiModel, "fastModes" | "supportedEfforts"> | undefined;
}

interface CandidateFieldChangeOptions {
  readonly supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined;
  readonly fastModes?: ProfileFastModes | undefined;
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

/** The reasoning level a candidate runs with, resolving the profile default. */
export const candidateEffortLevel = (
  profile: ProfileId,
  candidate: ProfileCandidate,
  parentEffort: SubagentEffort,
): string =>
  candidate.effort === "default"
    ? (profileDefaultEffort(profile) ?? parentEffort)
    : candidate.effort;

/** An unpinned reasoning level reads as the level it inherits, such as `inherit (low)`. */
export const inheritedEffortLabel = (level: string): string => `inherit (${level})`;

export const candidateEffortLabel = (
  profile: ProfileId,
  candidate: ProfileCandidate,
  parentEffort: SubagentEffort,
): string =>
  candidate.effort === "default"
    ? inheritedEffortLabel(candidateEffortLevel(profile, candidate, parentEffort))
    : candidate.effort;

/**
 * A candidate's model as the editor shows it: the `parent` choice reads as the inherited model it
 * runs on, such as `inherit (anthropic/claude-opus-5-5)`, or `inherit (claude-opus-5-5)` where a
 * table column is short.
 */
export const candidateModelLabel = (
  candidate: Pick<ProfileCandidate, "model">,
  parentModel: string | undefined,
  short = false,
): string => {
  if (candidate.model !== "parent") return candidate.model;
  if (parentModel === undefined) return "inherit";
  const model = short ? (Str.split(parentModel, "/").at(-1) ?? parentModel) : parentModel;
  return `inherit (${model})`;
};

export const candidateFastMark = (
  candidate: ProfileCandidate,
  models: ProfileEditorModels,
): string => {
  const mode = candidate.openaiFastMode;
  return mode && models.availableModel(candidate.model)?.fastModes.includes(mode)
    ? ` ${fastModeMark(mode)}`
    : "";
};

export const targetProfilePrimarySummary = (
  inspection: ProfileSettingsInspection,
  target: ProfileWorkspaceTarget,
  profile: ProfileId,
  parentModel?: string,
): string => {
  const draft = loadProfileRouteDraft(inspection, target, profile);
  const kind = draftKindLabel(draft, profileWorkspaceScope(target));
  const primary = draft.candidates[0];
  if (primary) return `${kind} · ${candidateModelLabel(primary, parentModel)}`;
  return draft.kind === "disabled" || draft.kind === "invalid" ? kind : `${kind} · disabled`;
};

const advancedSummaryValues = (
  candidate: ProfileCandidate,
  fastModes: ProfileFastModes,
): ReadonlyArray<string> =>
  Arr.filter(
    [
      candidate.context === "fork" ? "forked context" : undefined,
      candidate.openaiFastMode ? fastModeValue(candidate, fastModes) : undefined,
    ],
    Predicate.isNotUndefined,
  );

const fastModeValue = (candidate: ProfileCandidate, fastModes: ProfileFastModes): string => {
  const mode = candidate.openaiFastMode;
  const value = mode === "ultrafast" ? "ultrafast" : mode ? "on, fast" : "off";
  return (mode ? !fastModes.includes(mode) : fastModes.length === 0)
    ? `${value}, unavailable`
    : value;
};

const advancedCandidateRows = (
  candidate: ProfileCandidate,
  fastModes: ProfileFastModes,
): ReadonlyArray<ProfileWorkspaceFieldRow> => {
  const fastFixed = fastModes.length === 0 && !candidate.openaiFastMode;
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
      value: fastModeValue(candidate, fastModes),
      fixed: fastFixed,
      ...(fastFixed && { fixedReason: "OpenAI fast mode is unavailable on the selected model." }),
    },
  ];
};

export const candidateFieldRows = (
  candidate: ProfileCandidate,
  profile: ProfileId,
  parentEffort: SubagentEffort,
  models: ProfileEditorModels,
  advancedExpanded = false,
): ReadonlyArray<ProfileWorkspaceFieldRow> => {
  const fastModes = models.availableModel(candidate.model)?.fastModes ?? [];
  const advancedValues = advancedSummaryValues(candidate, fastModes);
  return [
    {
      field: "model",
      label: "Model",
      value: candidateModelLabel(candidate, models.parentModel),
      fixed: false,
    },
    {
      field: "effort",
      label: "Reasoning",
      value: candidateEffortLabel(profile, candidate, parentEffort),
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
    ...(advancedExpanded ? advancedCandidateRows(candidate, fastModes) : []),
  ];
};

export type ProfileWorkspaceRow = ProfileWorkspaceFieldRow &
  (
    | { readonly scope: "candidate"; readonly candidateIndex: number }
    | { readonly scope: "profile"; readonly candidateIndex?: undefined }
  );

/**
 * The fields pane's rows: each candidate's settings, or, for a profile with no candidates, one
 * `Add model…` row so the pane always offers a next step. Actions on a candidate (Manage, Add
 * fallback, Undo) are keys, not rows.
 */
export const profileWorkspaceRows = (
  draft: ProfileRouteDraft,
  profile: ProfileId,
  parentEffort: SubagentEffort,
  models: ProfileEditorModels,
  expanded: ReadonlySet<number>,
): ReadonlyArray<ProfileWorkspaceRow> =>
  draft.candidates.length === 0
    ? [
        {
          scope: "profile",
          field: "model",
          label: "Add model…",
          value: Match.value(draft.kind).pipe(
            Match.when("invalid", () => "repair this profile"),
            Match.when("disabled", () => "enable this profile"),
            Match.orElse(() => ""),
          ),
          fixed: false,
        },
      ]
    : Arr.flatMap(draft.candidates, (candidate, candidateIndex) =>
        Arr.map(
          candidateFieldRows(
            candidate,
            profile,
            parentEffort,
            models,
            expanded.has(candidateIndex),
          ),
          (row): ProfileWorkspaceRow => ({ ...row, scope: "candidate", candidateIndex }),
        ),
      );

export type SelectableCandidateField = Exclude<ProfileWorkspaceField, "model" | "advanced">;

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
        label: effectiveDefault ? inheritedEffortLabel(effectiveDefault) : "inherit",
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
  return [
    { value: "false", label: "Off", description: "Use standard service for this choice" },
    ...Arr.map(options.fastModes ?? [], (mode) =>
      mode === "ultrafast"
        ? {
            value: mode,
            label: "Ultrafast",
            description: "Request OpenAI ultrafast service for this choice",
          }
        : {
            value: "true",
            label: "On, fast",
            description: "Request OpenAI priority service for this choice",
          },
    ),
  ];
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
  const effort = findOrUndefined(
    candidateEfforts(options.supportedEfforts),
    (entry) => entry === value,
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
      return value === "true" || value === "false" || value === "ultrafast"
        ? {
            candidate: {
              ...candidate,
              openaiFastMode: value === "ultrafast" ? value : value === "true",
            },
            notices: [],
          }
        : invalidSelection(field);
  }
  return Fn.absurd(field);
}
