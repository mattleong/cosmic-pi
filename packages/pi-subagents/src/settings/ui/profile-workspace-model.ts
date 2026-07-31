import type { SubagentConfigInspection, SubagentConfigScope } from "../../config/store.ts";
import type {
  ProfileCandidate,
  ProfileCandidateEffort,
  ProfileId,
  ProfileRouteSource,
} from "../../profiles/model.ts";
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
  | "closeOnReport";

export const PROFILE_WORKSPACE_FIELDS: ReadonlyArray<ProfileWorkspaceField> = [
  "host",
  "runtime",
  "model",
  "effort",
  "context",
  "writeIntent",
  "closeOnReport",
];

export interface ProfileWorkspaceFieldRow {
  readonly field: ProfileWorkspaceField;
  readonly label: string;
  readonly value: string;
  readonly fixed: boolean;
}

export interface CandidateFieldChangeOptions {
  readonly piModel?: string | undefined;
  readonly supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined;
}

export interface CandidateFieldChoice {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

export const profileSourceLabel = (source: ProfileRouteSource): string => {
  switch (source) {
    case "project":
      return "project override";
    case "global":
      return "global";
    case "builtin":
      return "built-in";
    case "project-invalid":
      return "project invalid";
    case "global-invalid":
      return "global invalid";
  }
};

export const draftKindLabel = (draft: ProfileRouteDraft, scope: SubagentConfigScope): string => {
  switch (draft.kind) {
    case "explicit":
      return "explicit";
    case "disabled":
      return "disabled";
    case "invalid":
      return "invalid · fail-closed";
    case "inherit":
      return "inherits global";
    case "reset":
      return scope === "global" ? "built-in" : "scope default";
  }
};

export const effectiveProfileSummary = (
  inspection: SubagentConfigInspection,
  profile: ProfileId,
): string => {
  const route = inspection.config.profiles[profile];
  const source = profileSourceLabel(inspection.config.profileSources[profile]);
  const first = route.candidates[0];
  if (!first)
    return inspection.config.profileSources[profile].endsWith("-invalid")
      ? `${source} · fail-closed`
      : `${source} · disabled`;
  const count = route.candidates.length;
  return `${source} · ${count} candidate${count === 1 ? "" : "s"} · ${first.host}/${first.runtime}`;
};

export const candidateFieldRows = (
  candidate: ProfileCandidate,
): ReadonlyArray<ProfileWorkspaceFieldRow> => {
  const localPi = candidate.host === "local" && candidate.runtime === "pi";
  const retainedAllowed = candidate.host === "herdr" && candidate.writeIntent === "read-only";
  return [
    { field: "host", label: "Host", value: candidate.host, fixed: false },
    { field: "runtime", label: "Runtime", value: candidate.runtime, fixed: false },
    { field: "model", label: "Model", value: candidate.model, fixed: false },
    { field: "effort", label: "Effort", value: candidate.effort, fixed: false },
    {
      field: "context",
      label: "Context",
      value: candidate.context,
      fixed: !localPi,
    },
    {
      field: "writeIntent",
      label: "Write intent",
      value: candidate.writeIntent,
      fixed: false,
    },
    {
      field: "closeOnReport",
      label: "Report policy",
      value: candidate.closeOnReport ? "close after report" : "retain for guidance",
      fixed: !retainedAllowed,
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
  if (field === "effort")
    return [
      { value: "default", label: "Runtime default", description: "Use the runtime default" },
      ...runtimeEfforts(candidate.runtime, options.supportedEfforts).map((effort) => ({
        value: effort,
        label: effort,
        description: `Use ${effort} reasoning effort`,
      })),
    ];
  if (field === "context")
    return candidate.host === "local" && candidate.runtime === "pi"
      ? [
          { value: "fresh", label: "Fresh", description: "Start with a new context" },
          { value: "fork", label: "Fork", description: "Fork the active parent context" },
        ]
      : [{ value: "fresh", label: "Fresh", description: "Required by this host/runtime" }];
  if (field === "writeIntent")
    return [
      { value: "read-only", label: "Read-only", description: "Inspect without modifying files" },
      { value: "writer", label: "Writer", description: "May modify files under writer policy" },
    ];
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
  if (field === "closeOnReport" && (value === "true" || value === "false"))
    return { candidate: { ...candidate, closeOnReport: value === "true" }, notices: [] };
  return { error: `Invalid ${field} selection.`, notices: [] };
}
