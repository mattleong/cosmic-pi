import { managerNoticeGlyph } from "pi-cosmic-ui/manager";
import { PROFILE_DEFINITIONS } from "../../profiles/definitions.ts";
import {
  isLocalPiProfileCandidate,
  isRetainableProfileCandidate,
  supportsSubagentFastMode,
  type ProfileCandidate,
  type ProfileId,
} from "../../profiles/model.ts";
import type { SubagentEffort, SubagentHost, SubagentRuntime } from "../../domain/routing.ts";
import {
  loadProfileRouteDraft,
  profileWorkspaceScope,
  runtimeEfforts,
  updateCandidateControls,
  type CandidateUpdate,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
  type ProfileSettingsScope,
  type ProfileWorkspaceTarget,
} from "../profile-route-editor.ts";

export type ProfileWorkspacePane = "profiles" | "candidates" | "fields";
export type ProfileWorkspaceField =
  | "model"
  | "effort"
  | "writeIntent"
  | "runWith"
  | "advanced"
  | "context"
  | "openaiFastMode"
  | "closeOnReport"
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
  readonly piModel?: string | undefined;
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

const routeOptionCountLabel = (count: number): string =>
  count === 1 ? "Primary only" : `Primary + ${count - 1} fallback${count === 2 ? "" : "s"}`;

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

export const effectiveCandidateEffort = (
  profile: ProfileId,
  candidate: ProfileCandidate,
  parentEffort: SubagentEffort,
): SubagentEffort =>
  candidate.effort === "default"
    ? (() => {
        const definition = PROFILE_DEFINITIONS[profile];
        return "defaultEffort" in definition ? definition.defaultEffort : parentEffort;
      })()
    : candidate.effort;

export const candidateEffortLabel = (
  profile: ProfileId,
  candidate: ProfileCandidate,
  parentEffort: SubagentEffort,
): string => {
  const effective = effectiveCandidateEffort(profile, candidate, parentEffort);
  return candidate.effort === "default" ? `${effective} (profile default)` : effective;
};

export const candidateFastModeApplied = (
  candidate: ProfileCandidate,
  parentModel?: string | undefined,
): boolean => {
  if (!candidate.openaiFastMode) return false;
  const model =
    candidate.runtime === "pi" && candidate.model === "parent" ? parentModel : candidate.model;
  return model !== undefined && supportsSubagentFastMode(candidate.runtime, model);
};

export const runWithValue = (candidate: ProfileCandidate): string =>
  `${candidate.host}/${candidate.runtime}`;

export const runWithLabel = (candidate: ProfileCandidate): string => {
  const runtime =
    candidate.runtime === "pi" ? "Pi" : candidate.runtime === "claude" ? "Claude" : "Codex";
  return `${candidate.host === "local" ? "Local" : "Herdr"} ${runtime}`;
};

export const targetProfileRouteDraft = (
  inspection: ProfileSettingsInspection,
  target: ProfileWorkspaceTarget,
  profile: ProfileId,
): ProfileRouteDraft => loadProfileRouteDraft(inspection, target, profile);

export const profileRouteDraftSummary = (
  profile: ProfileId,
  draft: ProfileRouteDraft,
  parentEffort: SubagentEffort,
  parentModel?: string | undefined,
): string => {
  if (draft.kind === "invalid")
    return `${managerNoticeGlyph("error")} invalid, won't run until fixed`;
  const first = draft.candidates[0];
  if (!first) return "disabled";
  const effort = candidateEffortLabel(profile, first, parentEffort);
  const fast = candidateFastModeApplied(first, parentModel) ? " ⚡" : "";
  return `${routeOptionCountLabel(draft.candidates.length)} · ${first.model} · ${runWithLabel(first)} · ${effort}${fast}`;
};

export const targetProfilePrimarySummary = (
  inspection: ProfileSettingsInspection,
  target: ProfileWorkspaceTarget,
  profile: ProfileId,
  draft: ProfileRouteDraft = targetProfileRouteDraft(inspection, target, profile),
): string => {
  const kind = draftKindLabel(draft, profileWorkspaceScope(target));
  const primary = draft.candidates[0];
  if (primary) return `${kind} · ${primary.model}`;
  return draft.kind === "disabled" || draft.kind === "invalid" ? kind : `${kind} · disabled`;
};

export const profileDescription = (profile: ProfileId): string =>
  PROFILE_DEFINITIONS[profile].description;

const advancedSummaryValues = (
  candidate: ProfileCandidate,
  parentModel: string | undefined,
): ReadonlyArray<string> =>
  [
    isLocalPiProfileCandidate(candidate) && candidate.context === "fork"
      ? "forked context"
      : undefined,
    candidateFastModeApplied(candidate, parentModel) ? "fast mode" : undefined,
    !candidate.closeOnReport ? "stays open after reporting" : undefined,
  ].filter((value): value is string => value !== undefined);

const fastModeFieldRow = (
  candidate: ProfileCandidate,
  parentModel: string | undefined,
  fastAvailable: boolean,
): ProfileWorkspaceFieldRow => ({
  field: "openaiFastMode",
  label: "  OpenAI fast mode",
  value: fastAvailable
    ? candidateFastModeApplied(candidate, parentModel)
      ? "on, priority"
      : "off, standard"
    : candidate.openaiFastMode
      ? "on, but unavailable"
      : "off, unavailable",
  fixed: !fastAvailable && !candidate.openaiFastMode,
  ...(!fastAvailable &&
    !candidate.openaiFastMode && {
      fixedReason: "The selected model does not support OpenAI fast mode.",
    }),
});

const advancedCandidateRows = (
  candidate: ProfileCandidate,
  parentModel: string | undefined,
): ReadonlyArray<ProfileWorkspaceFieldRow> => {
  const localPi = isLocalPiProfileCandidate(candidate);
  const retainedAllowed = isRetainableProfileCandidate(candidate);
  const fastModel =
    candidate.runtime === "pi" && candidate.model === "parent" ? parentModel : candidate.model;
  const fastAvailable =
    fastModel !== undefined && supportsSubagentFastMode(candidate.runtime, fastModel);
  return [
    {
      field: "context",
      label: "  Context",
      value: candidate.context,
      fixed: !localPi,
      ...(!localPi && { fixedReason: "Fork is available only with Local Pi." }),
    },
    fastModeFieldRow(candidate, parentModel, fastAvailable),
    {
      field: "closeOnReport",
      label: "  After reporting",
      value: candidate.closeOnReport ? "close after reporting" : "stay open after reporting",
      fixed: !retainedAllowed,
      ...(!retainedAllowed && {
        fixedReason: "Only Herdr read-only runs can stay open after reporting.",
      }),
    },
  ];
};

export const candidateFieldRows = (
  candidate: ProfileCandidate,
  profile?: ProfileId,
  parentEffort: SubagentEffort = "high",
  parentModel?: string | undefined,
  advancedExpanded = false,
  position: { readonly index: number; readonly count: number } = { index: 0, count: 1 },
): ReadonlyArray<ProfileWorkspaceFieldRow> => {
  const advanced = advancedCandidateRows(candidate, parentModel);
  const advancedValues = advancedSummaryValues(candidate, parentModel);
  const essential: ReadonlyArray<ProfileWorkspaceFieldRow> = [
    { field: "model", label: "Model", value: candidate.model, fixed: false },
    {
      field: "effort",
      label: "Reasoning",
      value: profile ? candidateEffortLabel(profile, candidate, parentEffort) : candidate.effort,
      fixed: false,
    },
    { field: "writeIntent", label: "File access", value: candidate.writeIntent, fixed: false },
    { field: "runWith", label: "Run with", value: runWithLabel(candidate), fixed: false },
    ...(advanced.length > 0
      ? [
          {
            field: "advanced" as const,
            label: advancedExpanded ? "Advanced ▾" : "Advanced ▸",
            value: advancedExpanded
              ? ""
              : advancedValues.length > 0
                ? advancedValues.join(", ")
                : "all standard",
            fixed: false,
          },
        ]
      : []),
  ];
  return [
    ...essential,
    ...(advancedExpanded ? advanced : []),
    {
      field: "actions",
      label: `Manage ${profileRouteOptionLabel(position.index)}…`,
      value: "",
      fixed: false,
    },
  ];
};

export type SelectableCandidateField = Exclude<
  ProfileWorkspaceField,
  "model" | "advanced" | "actions" | "add" | "reset"
>;

const RUN_WITH_CHOICES: ReadonlyArray<
  CandidateFieldChoice & { readonly host: SubagentHost; readonly runtime: SubagentRuntime }
> = [
  {
    value: "local/pi",
    label: "Local Pi",
    description: "Run Pi locally on this computer",
    host: "local",
    runtime: "pi",
  },
  {
    value: "local/claude",
    label: "Local Claude",
    description: "Run Claude Code locally on this computer",
    host: "local",
    runtime: "claude",
  },
  {
    value: "local/codex",
    label: "Local Codex",
    description: "Run Codex locally on this computer",
    host: "local",
    runtime: "codex",
  },
  {
    value: "herdr/pi",
    label: "Herdr Pi",
    description: "Run Pi in a Herdr pane",
    host: "herdr",
    runtime: "pi",
  },
  {
    value: "herdr/claude",
    label: "Herdr Claude",
    description: "Run Claude Code in a Herdr pane",
    host: "herdr",
    runtime: "claude",
  },
  {
    value: "herdr/codex",
    label: "Herdr Codex",
    description: "Run Codex in a Herdr pane",
    host: "herdr",
    runtime: "codex",
  },
];

export const candidateFieldChoices = (
  candidate: ProfileCandidate,
  field: SelectableCandidateField,
  options: CandidateFieldChangeOptions,
): ReadonlyArray<CandidateFieldChoice> => {
  if (field === "runWith") return RUN_WITH_CHOICES;
  if (field === "effort") {
    const definition = options.profile ? PROFILE_DEFINITIONS[options.profile] : undefined;
    const defaultEffort =
      definition && "defaultEffort" in definition ? definition.defaultEffort : undefined;
    const effectiveDefault = defaultEffort ?? options.parentEffort;
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
    return isLocalPiProfileCandidate(candidate)
      ? [
          { value: "fresh", label: "Fresh", description: "Start without earlier context" },
          { value: "fork", label: "Fork", description: "Copy the current Pi context" },
        ]
      : [{ value: "fresh", label: "Fresh", description: "Start without earlier context" }];
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
  return isRetainableProfileCandidate(candidate)
    ? [
        {
          value: "true",
          label: "Close after reporting",
          description: "Close when the report is accepted",
        },
        {
          value: "false",
          label: "Stay open after reporting",
          description: "Keep this Herdr read-only run open for another assignment",
        },
      ]
    : [
        {
          value: "true",
          label: "Close after reporting",
          description: "This selection must close after reporting",
        },
      ];
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
    const choice = RUN_WITH_CHOICES.find((entry) => entry.value === value);
    return choice
      ? updateCandidateControls(
          candidate,
          { host: choice.host, runtime: choice.runtime },
          { piModel: options.piModel },
        )
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
    return updateCandidateControls(candidate, { writeIntent: value }, { piModel: options.piModel });
  if (field === "openaiFastMode" && (value === "true" || value === "false"))
    return { candidate: { ...candidate, openaiFastMode: value === "true" }, notices: [] };
  if (field === "closeOnReport" && (value === "true" || value === "false"))
    return { candidate: { ...candidate, closeOnReport: value === "true" }, notices: [] };
  return { error: `Invalid ${field} selection.`, notices: [] };
}
