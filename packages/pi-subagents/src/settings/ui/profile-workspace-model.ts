import type { ProfileSettingsInspection, ProfileSettingsScope } from "../profile-route-editor.ts";
import { PROFILE_DEFINITIONS } from "../../profiles/definitions.ts";
import type {
  ProfileCandidate,
  ProfileCandidateEffort,
  ProfileId,
  ProfileRouteSource,
} from "../../profiles/model.ts";
import { supportsSubagentFastMode } from "../../run/fast-mode.ts";
import type { SubagentEffort } from "../../run/model.ts";
import {
  runtimeEfforts,
  updateCandidateControls,
  type CandidateUpdate,
  type ProfileRouteDraft,
} from "../profile-route-editor.ts";

export type ProfileWorkspacePane = "profiles" | "candidates" | "fields";
export type ProfileWorkspaceField =
  | "host"
  | "runtime"
  | "model"
  | "effort"
  | "context"
  | "writeIntent"
  | "fastMode"
  | "closeOnReport";

export const PROFILE_WORKSPACE_FIELDS: ReadonlyArray<ProfileWorkspaceField> = [
  "host",
  "runtime",
  "model",
  "effort",
  "context",
  "writeIntent",
  "fastMode",
  "closeOnReport",
];

/** Screen-owned printable shortcuts that win over configured movement keys. */
export const PROFILE_WORKSPACE_SHORTCUTS: ReadonlySet<string> = new Set([
  "/",
  "J",
  "K",
  "X",
  "a",
  "c",
  "d",
  "i",
  "r",
  "s",
  "x",
]);

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

export const profileSourceLabel = (source: ProfileRouteSource): string => {
  switch (source) {
    case "session":
      return "[S] session";
    case "project":
      return "[P] project";
    case "global":
      return "[G] global";
    case "builtin":
      return "[B] built-in";
    case "project-invalid":
      return "[P] project invalid";
    case "global-invalid":
      return "[G] global invalid";
  }
};

export const draftKindLabel = (draft: ProfileRouteDraft, scope: ProfileSettingsScope): string => {
  switch (draft.kind) {
    case "explicit":
      return "explicit";
    case "disabled":
      return "— disabled";
    case "invalid":
      return "× invalid · fails closed";
    case "inherit":
      return scope === "session" ? "inherits active config" : "inherits global";
    case "reset":
      return scope === "global" ? "built-in" : "scope default";
  }
};

export const effectiveCandidateEffort = (
  profile: ProfileId,
  candidate: ProfileCandidate,
  parentEffort: SubagentEffort,
): SubagentEffort =>
  candidate.effort === "default"
    ? (PROFILE_DEFINITIONS[profile].defaultEffort ?? parentEffort)
    : candidate.effort;

export const candidateEffortLabel = (
  profile: ProfileId,
  candidate: ProfileCandidate,
  parentEffort: SubagentEffort,
): string => {
  const effective = effectiveCandidateEffort(profile, candidate, parentEffort);
  return candidate.effort === "default" ? `${effective} (default)` : effective;
};

export const candidateFastModeApplied = (
  candidate: ProfileCandidate,
  parentModel?: string | undefined,
): boolean => {
  if (!candidate.fastMode) return false;
  const model =
    candidate.runtime === "pi" && candidate.model === "parent" ? parentModel : candidate.model;
  return model !== undefined && supportsSubagentFastMode(candidate.runtime, model);
};

export const effectiveProfileSummary = (
  inspection: ProfileSettingsInspection,
  profile: ProfileId,
  parentEffort: SubagentEffort = "high",
  parentModel?: string | undefined,
): string => {
  const route = inspection.session.effectiveConfig.profiles[profile];
  const source = profileSourceLabel(inspection.session.effectiveConfig.profileSources[profile]);
  const first = route.candidates[0];
  if (!first)
    return inspection.session.effectiveConfig.profileSources[profile].endsWith("-invalid")
      ? `${source} · × fails closed`
      : `${source} · — disabled`;
  const count = route.candidates.length;
  const effort = candidateEffortLabel(profile, first, parentEffort);
  const fast = candidateFastModeApplied(first, parentModel) ? " ⚡" : "";
  return `${source} · ${count} candidate${count === 1 ? "" : "s"} · ${first.host}/${first.runtime} · ${first.model}:${effort}${fast}`;
};

export const profileRouteDraftSummary = (
  profile: ProfileId,
  draft: ProfileRouteDraft,
  parentEffort: SubagentEffort,
  parentModel?: string | undefined,
): string => {
  if (draft.kind === "invalid") return "× invalid · fails closed";
  const first = draft.candidates[0];
  if (!first) return "— disabled";
  const count = draft.candidates.length;
  const effort = candidateEffortLabel(profile, first, parentEffort);
  const fast = candidateFastModeApplied(first, parentModel) ? " ⚡" : "";
  return `${count} candidate${count === 1 ? "" : "s"} · ${first.host}/${first.runtime} · ${first.model}:${effort}${fast}`;
};

export const candidateFieldRows = (
  candidate: ProfileCandidate,
  profile?: ProfileId,
  parentEffort: SubagentEffort = "high",
  parentModel?: string | undefined,
): ReadonlyArray<ProfileWorkspaceFieldRow> => {
  const localPi = candidate.host === "local" && candidate.runtime === "pi";
  const retainedAllowed = candidate.host === "herdr" && candidate.writeIntent === "read-only";
  const fastModel =
    candidate.runtime === "pi" && candidate.model === "parent" ? parentModel : candidate.model;
  const fastAvailable =
    fastModel !== undefined && supportsSubagentFastMode(candidate.runtime, fastModel);
  const fastUnavailableReason =
    candidate.runtime === "claude"
      ? "Claude does not support OpenAI fast mode"
      : candidate.model === "parent" && !parentModel
        ? "no active parent model is available"
        : "the selected model does not support OpenAI fast mode";
  return [
    { field: "host", label: "Host", value: candidate.host, fixed: false },
    { field: "runtime", label: "Runtime", value: candidate.runtime, fixed: false },
    { field: "model", label: "Model", value: candidate.model, fixed: false },
    {
      field: "effort",
      label: "Effort",
      value: profile ? candidateEffortLabel(profile, candidate, parentEffort) : candidate.effort,
      fixed: false,
    },
    {
      field: "context",
      label: "Context",
      value: localPi ? candidate.context : `${candidate.context} · fixed: fork requires local Pi`,
      fixed: !localPi,
      ...(!localPi ? { fixedReason: "Fork context is available only to local Pi." } : {}),
    },
    {
      field: "writeIntent",
      label: "Write intent",
      value: candidate.writeIntent,
      fixed: false,
    },
    {
      field: "fastMode",
      label: "OpenAI fast mode",
      value: fastAvailable
        ? candidateFastModeApplied(candidate, parentModel)
          ? "on · priority"
          : "off · standard"
        : candidate.fastMode
          ? `configured on · unavailable: ${fastUnavailableReason} · turn off`
          : `unavailable · ${fastUnavailableReason}`,
      fixed: !fastAvailable && !candidate.fastMode,
      ...(!fastAvailable && !candidate.fastMode
        ? { fixedReason: `${fastUnavailableReason}.` }
        : {}),
    },
    {
      field: "closeOnReport",
      label: "Report policy",
      value: retainedAllowed
        ? candidate.closeOnReport
          ? "close after report"
          : "retain for guidance"
        : "close after report · fixed: retain requires Herdr read-only",
      fixed: !retainedAllowed,
      ...(!retainedAllowed
        ? { fixedReason: "Retention is available only to Herdr read-only candidates." }
        : {}),
    },
  ];
};

export const candidateFieldChoices = (
  candidate: ProfileCandidate,
  field: Exclude<ProfileWorkspaceField, "model">,
  options: CandidateFieldChangeOptions,
): ReadonlyArray<CandidateFieldChoice> => {
  if (field === "host")
    return [
      { value: "local", label: "Local", description: "Run in a session-scoped local process" },
      { value: "herdr", label: "Herdr", description: "Run through the persistent Herdr host" },
    ];
  if (field === "runtime")
    return [
      { value: "pi", label: "Pi", description: "Use a canonical authenticated Pi model" },
      { value: "claude", label: "Claude Code", description: "Use Claude's native runtime" },
      { value: "codex", label: "Codex", description: "Use Codex app-server" },
    ];
  if (field === "effort") {
    const definition = options.profile ? PROFILE_DEFINITIONS[options.profile] : undefined;
    const effectiveDefault = definition?.defaultEffort ?? options.parentEffort;
    const defaultChoice = effectiveDefault
      ? {
          value: "default",
          label: `${effectiveDefault} (default)`,
          description: definition?.defaultEffort
            ? `Use the ${options.profile} profile default: ${effectiveDefault}`
            : `Use the current parent effort (${effectiveDefault}) when available; otherwise high`,
        }
      : {
          value: "default",
          label: "Profile default",
          description: "Use the profile's soft default effort",
        };
    return [
      defaultChoice,
      ...runtimeEfforts(candidate.runtime, options.supportedEfforts).map((effort) => ({
        value: effort,
        label: effort,
        description: `Use ${effort} reasoning effort`,
      })),
    ];
  }
  if (field === "context")
    return candidate.host === "local" && candidate.runtime === "pi"
      ? [
          { value: "fresh", label: "Fresh", description: "Start with a new context" },
          { value: "fork", label: "Fork", description: "Fork the active parent context" },
        ]
      : [{ value: "fresh", label: "Fresh", description: "Required by this host/runtime" }];
  if (field === "writeIntent")
    return [
      {
        value: "read-only",
        label: "Read-only",
        description: "Inspect and validate with Bash; do not modify project files",
      },
      { value: "writer", label: "Writer", description: "May modify files under writer policy" },
    ];
  if (field === "fastMode") {
    const available =
      options.fastModeAvailable ??
      (candidate.model !== "parent" &&
        supportsSubagentFastMode(candidate.runtime, candidate.model));
    return [
      { value: "false", label: "Off", description: "Use the model's standard service tier" },
      ...(available
        ? [
            {
              value: "true",
              label: "On · Fast",
              description: "Request OpenAI priority service for this candidate",
            },
          ]
        : []),
    ];
  }
  return candidate.host === "herdr" && candidate.writeIntent === "read-only"
    ? [
        {
          value: "true",
          label: "Close after report",
          description: "Close after the first accepted report",
        },
        {
          value: "false",
          label: "Retain for guidance",
          description: "Keep the read-only run for another assignment",
        },
      ]
    : [
        {
          value: "true",
          label: "Close after report",
          description: "Required by the current policy",
        },
      ];
};

/** Selects one exact field value while preserving route normalization rules. */
export function selectCandidateField(
  candidate: ProfileCandidate,
  field: Exclude<ProfileWorkspaceField, "model">,
  value: string,
  options: CandidateFieldChangeOptions,
): CandidateUpdate {
  if (!candidateFieldChoices(candidate, field, options).some((choice) => choice.value === value))
    return { error: `Invalid ${field} selection.`, notices: [] };
  if (field === "host" && (value === "local" || value === "herdr"))
    return updateCandidateControls(candidate, { host: value }, { piModel: options.piModel });
  if (field === "runtime" && (value === "pi" || value === "claude" || value === "codex"))
    return updateCandidateControls(candidate, { runtime: value }, { piModel: options.piModel });
  if (
    field === "effort" &&
    (value === "default" ||
      runtimeEfforts(candidate.runtime, options.supportedEfforts).includes(value as SubagentEffort))
  )
    return {
      candidate: { ...candidate, effort: value as ProfileCandidateEffort },
      notices: [],
    };
  if (field === "context" && (value === "fresh" || value === "fork"))
    return { candidate: { ...candidate, context: value }, notices: [] };
  if (field === "writeIntent" && (value === "read-only" || value === "writer"))
    return updateCandidateControls(candidate, { writeIntent: value }, { piModel: options.piModel });
  if (field === "fastMode" && (value === "true" || value === "false"))
    return { candidate: { ...candidate, fastMode: value === "true" }, notices: [] };
  if (field === "closeOnReport" && (value === "true" || value === "false"))
    return { candidate: { ...candidate, closeOnReport: value === "true" }, notices: [] };
  return { error: `Invalid ${field} selection.`, notices: [] };
}
