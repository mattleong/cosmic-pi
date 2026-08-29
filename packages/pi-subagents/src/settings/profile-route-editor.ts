import type { SubagentConfigInspection, SubagentConfigScope } from "../config/store.ts";
import { BUILTIN_PROFILE_ROUTES } from "../profiles/definitions.ts";
import type { SessionProfileSnapshot } from "../profiles/session-overrides.ts";
import {
  cloneProfileCandidates as cloneCandidates,
  MAX_PROFILE_CANDIDATES,
  normalizeProfileCandidate as cloneCandidate,
  PROFILE_NATIVE_MODEL_DEFAULTS,
  profileCandidateValidationIssues,
  supportsSubagentFastMode,
  type DeclaredProfileCandidate,
  type DeclaredProfileRoute,
  type ProfileCandidate,
  type ProfileCandidateValidationIssueCode,
  type ProfileId,
} from "../profiles/model.ts";
import {
  subagentRuntimeEfforts,
  type SubagentEffort,
  type SubagentHost,
  type SubagentRuntime,
} from "../domain/routing.ts";

export type ProfileSettingsScope = "session" | SubagentConfigScope;

export interface PersistentProfileSetRef {
  readonly scope: SubagentConfigScope;
  readonly name: string;
}

export type ProfileWorkspaceTarget =
  | { readonly kind: "session" }
  | { readonly kind: "profile-set"; readonly set: PersistentProfileSetRef };

export const profileWorkspaceScope = (target: ProfileWorkspaceTarget): ProfileSettingsScope =>
  target.kind === "session" ? "session" : target.set.scope;

export const profileWorkspaceTargetLabel = (target: ProfileWorkspaceTarget): string =>
  target.kind === "session"
    ? "Session"
    : `[${target.set.scope === "project" ? "P" : "G"}] ${target.set.name}`;

export interface ProfileSettingsInspection extends SubagentConfigInspection {
  readonly session: SessionProfileSnapshot;
}

export type ProfileRouteDraftKind = "explicit" | "disabled" | "reset" | "inherit" | "invalid";

/** A staged route declaration. Reference candidates make reset/inherit routes inspectable and copyable. */
export interface ProfileRouteDraft {
  readonly kind: ProfileRouteDraftKind;
  readonly candidates: ReadonlyArray<ProfileCandidate>;
}

export interface CandidateControlDefaults {
  /** First authenticated canonical Pi model, used when `parent` becomes unavailable. */
  readonly piModel?: string | undefined;
}

export interface CandidateUpdate {
  readonly candidate?: ProfileCandidate | undefined;
  readonly notices: ReadonlyArray<string>;
  readonly error?: string | undefined;
}

export const runtimeEfforts = (
  runtime: SubagentRuntime,
  supportedModelEfforts?: ReadonlyArray<SubagentEffort> | undefined,
): ReadonlyArray<SubagentEffort> => {
  const supportedByRuntime = subagentRuntimeEfforts(runtime);
  return supportedModelEfforts
    ? supportedModelEfforts.filter((effort) => supportedByRuntime.includes(effort))
    : supportedByRuntime;
};

// SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
const candidatesFromDeclaration = (
  declared: DeclaredProfileRoute,
): ReadonlyArray<ProfileCandidate> =>
  declared === "disabled"
    ? []
    : Array.isArray(declared)
      ? cloneCandidates(declared)
      : [cloneCandidate(declared as DeclaredProfileCandidate)];

const decodedAt = (inspection: ProfileSettingsInspection, scope: SubagentConfigScope) =>
  scope === "global" ? inspection.global : inspection.project;

const profileSetAt = (inspection: ProfileSettingsInspection, set: PersistentProfileSetRef) => {
  const decoded = decodedAt(inspection, set.scope);
  const profileSets = decoded?.file.profileSets;
  return profileSets && Object.prototype.hasOwnProperty.call(profileSets, set.name)
    ? profileSets[set.name]
    : undefined;
};

const declaredAt = (
  inspection: ProfileSettingsInspection,
  set: PersistentProfileSetRef,
  profile: ProfileId,
): DeclaredProfileRoute | undefined => profileSetAt(inspection, set)?.profiles[profile];

const scopeRouteInvalid = (
  inspection: ProfileSettingsInspection,
  set: PersistentProfileSetRef,
  profile: ProfileId,
): boolean => {
  const decoded = decodedAt(inspection, set.scope);
  return (
    !decoded ||
    decoded.invalidProfileSets.includes(set.name) ||
    !profileSetAt(inspection, set) ||
    (decoded.invalidProfileSetRoutes[set.name]?.includes(profile) ?? false)
  );
};

const globalReferenceCandidates = (
  inspection: ProfileSettingsInspection,
  profile: ProfileId,
): ReadonlyArray<ProfileCandidate> => {
  const name = inspection.global.file.defaultProfileSet;
  if (inspection.global.invalidDefaultProfileSet) return [];
  if (name === undefined) return cloneCandidates(BUILTIN_PROFILE_ROUTES[profile].candidates);
  const set: PersistentProfileSetRef = { scope: "global", name };
  if (scopeRouteInvalid(inspection, set, profile)) return [];
  const declared = declaredAt(inspection, set, profile);
  return declared === undefined
    ? cloneCandidates(BUILTIN_PROFILE_ROUTES[profile].candidates)
    : candidatesFromDeclaration(declared);
};

/** Loads the exact declaration state without collapsing or reordering ordered candidates. */
export function loadProfileRouteDraft(
  inspection: ProfileSettingsInspection,
  target: ProfileWorkspaceTarget,
  profile: ProfileId,
): ProfileRouteDraft {
  if (target.kind === "session") {
    const declared = inspection.session.overrides[profile];
    if (declared)
      return declared.candidates.length === 0
        ? { kind: "disabled", candidates: [] }
        : { kind: "explicit", candidates: cloneCandidates(declared.candidates) };
    return {
      kind: "inherit",
      candidates: cloneCandidates(inspection.session.baseConfig.profiles[profile].candidates),
    };
  }
  const set = target.set;
  if (scopeRouteInvalid(inspection, set, profile)) return { kind: "invalid", candidates: [] };
  const declared = declaredAt(inspection, set, profile);
  if (declared === undefined)
    return set.scope === "global"
      ? { kind: "reset", candidates: cloneCandidates(BUILTIN_PROFILE_ROUTES[profile].candidates) }
      : { kind: "inherit", candidates: globalReferenceCandidates(inspection, profile) };
  if (declared === "disabled") return { kind: "disabled", candidates: [] };
  return { kind: "explicit", candidates: candidatesFromDeclaration(declared) };
}

export const resetGlobalDraft = (profile: ProfileId): ProfileRouteDraft => ({
  kind: "reset",
  candidates: cloneCandidates(BUILTIN_PROFILE_ROUTES[profile].candidates),
});

export const inheritProjectDraft = (
  inspection: ProfileSettingsInspection,
  profile: ProfileId,
): ProfileRouteDraft => ({
  kind: "inherit",
  candidates: globalReferenceCandidates(inspection, profile),
});

export const inheritSessionDraft = (
  inspection: ProfileSettingsInspection,
  profile: ProfileId,
): ProfileRouteDraft => ({
  kind: "inherit",
  candidates: cloneCandidates(inspection.session.baseConfig.profiles[profile].candidates),
});

export const disableRouteDraft = (): ProfileRouteDraft => ({ kind: "disabled", candidates: [] });

const explicitDraft = (candidates: ReadonlyArray<ProfileCandidate>): ProfileRouteDraft => ({
  kind: "explicit",
  candidates: cloneCandidates(candidates),
});

export const addRouteCandidate = (
  draft: ProfileRouteDraft,
  candidate: ProfileCandidate,
): ProfileRouteDraft | undefined =>
  draft.candidates.length >= MAX_PROFILE_CANDIDATES
    ? undefined
    : explicitDraft([...draft.candidates, candidate]);

export const replaceRouteCandidate = (
  draft: ProfileRouteDraft,
  index: number,
  candidate: ProfileCandidate,
): ProfileRouteDraft =>
  explicitDraft(
    draft.candidates.map((current, candidateIndex) =>
      candidateIndex === index ? candidate : current,
    ),
  );

export const removeRouteCandidate = (
  draft: ProfileRouteDraft,
  index: number,
): ProfileRouteDraft => {
  const candidates = draft.candidates.filter((_, candidateIndex) => candidateIndex !== index);
  return candidates.length === 0 ? disableRouteDraft() : explicitDraft(candidates);
};

export const moveRouteCandidate = (
  draft: ProfileRouteDraft,
  index: number,
  direction: "up" | "down",
): ProfileRouteDraft => {
  const target = direction === "up" ? index - 1 : index + 1;
  if (
    index < 0 ||
    target < 0 ||
    index >= draft.candidates.length ||
    target >= draft.candidates.length
  )
    return draft;
  const candidates = cloneCandidates(draft.candidates);
  const current = candidates[index];
  const other = candidates[target];
  if (!current || !other) return draft;
  const reordered = [...candidates];
  reordered[index] = other;
  reordered[target] = current;
  return explicitDraft(reordered);
};

export const duplicateRouteCandidate = (
  draft: ProfileRouteDraft,
  index: number,
): ProfileRouteDraft | undefined => {
  if (draft.candidates.length >= MAX_PROFILE_CANDIDATES) return undefined;
  const candidate = draft.candidates[index];
  if (!candidate) return draft;
  return explicitDraft([
    ...draft.candidates.slice(0, index + 1),
    cloneCandidate(candidate),
    ...draft.candidates.slice(index + 1),
  ]);
};

export const defaultRouteCandidate = (profile: ProfileId): ProfileCandidate =>
  cloneCandidate(BUILTIN_PROFILE_ROUTES[profile].candidates[0]!);

const candidateIssueMessage = (
  candidate: ProfileCandidate,
  code: ProfileCandidateValidationIssueCode,
): string => {
  switch (code) {
    case "model_selector_invalid":
      return `Model is not a valid bounded ${candidate.runtime} selector.`;
    case "parent_requires_local_pi":
      return "Parent model is valid only for local Pi.";
    case "fork_requires_local_pi":
      return "Fork context is valid only for local Pi.";
    case "retention_requires_herdr_read_only":
      return "Retaining a reported run is valid only for Herdr read-only candidates.";
    case "fast_mode_unsupported":
      return `Fast mode is unavailable for ${candidate.runtime}/${candidate.model}.`;
    case "effort_unsupported":
      return `${candidate.runtime} does not support effort ${candidate.effort}.`;
  }
};

export const candidateValidationError = (candidate: ProfileCandidate): string | undefined => {
  const issue = profileCandidateValidationIssues(candidate)[0];
  return issue ? candidateIssueMessage(candidate, issue.code) : undefined;
};

const replacementPiModel = (
  host: SubagentHost,
  defaults: CandidateControlDefaults,
): string | undefined => (host === "local" ? "parent" : defaults.piModel);

/**
 * Applies controlling fields and visibly normalizes every incompatible dependent field.
 * An unavailable Herdr Pi replacement fails without changing the staged candidate.
 */
export function updateCandidateControls(
  candidate: ProfileCandidate,
  patch: Partial<Pick<ProfileCandidate, "host" | "runtime" | "writeIntent">>,
  defaults: CandidateControlDefaults,
): CandidateUpdate {
  const notices: string[] = [];
  let next: ProfileCandidate = { ...candidate, ...patch };

  if (patch.runtime !== undefined && patch.runtime !== candidate.runtime) {
    const model =
      patch.runtime === "pi"
        ? replacementPiModel(next.host, defaults)
        : PROFILE_NATIVE_MODEL_DEFAULTS[patch.runtime];
    if (!model)
      return {
        notices,
        error: "Herdr Pi requires an authenticated canonical Pi model, but none is available.",
      };
    next = { ...next, model };
    notices.push(`Model reset to ${model} for ${patch.runtime}.`);
  }

  for (;;) {
    const issue = profileCandidateValidationIssues(next)[0];
    if (!issue) return { candidate: next, notices };
    switch (issue.code) {
      case "model_selector_invalid":
        return { notices, error: candidateIssueMessage(next, issue.code) };
      case "parent_requires_local_pi":
        if (!defaults.piModel)
          return {
            notices: [],
            error: "Herdr Pi requires an authenticated canonical Pi model, but none is available.",
          };
        next = { ...next, model: defaults.piModel };
        notices.push(`Parent is local-only; model reset to ${defaults.piModel}.`);
        break;
      case "fork_requires_local_pi":
        next = { ...next, context: "fresh" };
        notices.push("Fork is local-Pi-only; context reset to fresh.");
        break;
      case "retention_requires_herdr_read_only":
        next = { ...next, closeOnReport: true };
        notices.push("Only Herdr read-only runs may be retained; close-on-report reset to true.");
        break;
      case "fast_mode_unsupported":
        next = { ...next, openaiFastMode: false };
        notices.push("Fast mode is unavailable for the selected runtime/model; reset to off.");
        break;
      case "effort_unsupported":
        notices.push(`Effort ${next.effort} is unavailable for ${next.runtime}; reset to default.`);
        next = { ...next, effort: "default" };
        break;
    }
  }
}

export function updateCandidateModel(
  candidate: ProfileCandidate,
  model: string,
  supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined,
  fastModeAvailable = model === "parent" || supportsSubagentFastMode(candidate.runtime, model),
): CandidateUpdate {
  let next = { ...candidate, model };
  const notices: string[] = [];
  if (
    next.effort !== "default" &&
    supportedEfforts !== undefined &&
    !runtimeEfforts(candidate.runtime, supportedEfforts).includes(next.effort)
  ) {
    next = { ...next, effort: "default" };
    notices.push(`Effort ${candidate.effort} is unavailable for ${model}; reset to default.`);
  }
  if (next.openaiFastMode && !fastModeAvailable) {
    next = { ...next, openaiFastMode: false };
    notices.push(`Fast mode is unavailable for ${model}; reset to off.`);
  }
  const error = candidateValidationError(next);
  return error ? { notices, error } : { candidate: next, notices };
}

export type RouteDeclarationResult =
  | { readonly valid: true; readonly route?: DeclaredProfileRoute | undefined }
  | { readonly valid: false; readonly error: string };

export function declaredRouteForDraft(draft: ProfileRouteDraft): RouteDeclarationResult {
  if (draft.kind === "reset" || draft.kind === "inherit") return { valid: true };
  if (draft.kind === "disabled") return { valid: true, route: "disabled" };
  if (
    draft.kind === "invalid" ||
    draft.candidates.length === 0 ||
    draft.candidates.length > MAX_PROFILE_CANDIDATES
  )
    return {
      valid: false,
      error:
        draft.candidates.length > MAX_PROFILE_CANDIDATES
          ? `A profile route may contain at most ${MAX_PROFILE_CANDIDATES} candidates.`
          : "Replace the invalid route, disable it, or restore its scope default.",
    };
  for (let index = 0; index < draft.candidates.length; index += 1) {
    const candidate = draft.candidates[index];
    if (!candidate) continue;
    const error = candidateValidationError(candidate);
    if (error) return { valid: false, error: `Candidate ${index + 1}: ${error}` };
  }
  const candidates = cloneCandidates(draft.candidates);
  return {
    valid: true,
    route: candidates.length === 1 ? candidates[0] : candidates,
  };
}
