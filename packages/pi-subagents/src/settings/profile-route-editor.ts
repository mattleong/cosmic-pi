import { resolveNamedProfileSet } from "../config/options.ts";
import type { SubagentConfigInspection, SubagentConfigScope } from "../config/store.ts";
import { BUILTIN_PROFILE_ROUTES } from "../profiles/definitions.ts";
import type { SessionProfileSnapshot } from "../profiles/session-overrides.ts";
import {
  cloneProfileCandidates as cloneCandidates,
  MAX_PROFILE_CANDIDATES,
  normalizeProfileCandidate as cloneCandidate,
  normalizeDeclaredProfileRoute,
  profileCandidateValidationIssues,
  supportsSubagentFastMode,
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
  /** Claude or Codex model picked from that runtime's live catalog; neither has a built-in default. */
  readonly nativeModel?: string | undefined;
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

export const decodedAt = (inspection: ProfileSettingsInspection, scope: SubagentConfigScope) =>
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

export const resolvedSet = (inspection: ProfileSettingsInspection, set: PersistentProfileSetRef) =>
  resolveNamedProfileSet({ ...set, global: inspection.global, project: inspection.project });

const scopeRouteInvalid = (
  inspection: ProfileSettingsInspection,
  set: PersistentProfileSetRef,
  profile: ProfileId,
): boolean => resolvedSet(inspection, set).invalidProfiles.includes(profile);

const globalReferenceDraft = (
  inspection: ProfileSettingsInspection,
  profile: ProfileId,
): ProfileRouteDraft => {
  const name = inspection.global.file.defaultProfileSet;
  if (inspection.global.invalidDefaultProfileSet) return { kind: "invalid", candidates: [] };
  if (name === undefined)
    return {
      kind: "inherit",
      candidates: cloneCandidates(BUILTIN_PROFILE_ROUTES[profile].candidates),
    };
  const resolved = resolvedSet(inspection, { scope: "global", name });
  return resolved.invalidProfiles.includes(profile)
    ? { kind: "invalid", candidates: [] }
    : { kind: "inherit", candidates: cloneCandidates(resolved.profiles[profile].candidates) };
};

/** Whether resetting this route can remove an actual declaration, including a malformed one. */
export const hasOwnProfileRouteDeclaration = (
  inspection: ProfileSettingsInspection,
  target: ProfileWorkspaceTarget,
  profile: ProfileId,
): boolean => {
  if (target.kind === "session") return inspection.session.overrides[profile] !== undefined;
  const decoded = decodedAt(inspection, target.set.scope);
  if (!decoded) return false;
  return (
    declaredAt(inspection, target.set, profile) !== undefined ||
    (decoded.invalidProfileSetRoutes[target.set.name]?.includes(profile) ?? false)
  );
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
    return inheritSessionDraft(inspection, profile);
  }
  const set = target.set;
  if (scopeRouteInvalid(inspection, set, profile)) return { kind: "invalid", candidates: [] };
  const declared = declaredAt(inspection, set, profile);
  if (declared === undefined)
    return set.scope === "global"
      ? { kind: "reset", candidates: cloneCandidates(BUILTIN_PROFILE_ROUTES[profile].candidates) }
      : globalReferenceDraft(inspection, profile);
  if (declared === "disabled") return { kind: "disabled", candidates: [] };
  return { kind: "explicit", candidates: normalizeDeclaredProfileRoute(declared).candidates };
}

export const inheritSessionDraft = (
  inspection: ProfileSettingsInspection,
  profile: ProfileId,
): ProfileRouteDraft => ({
  kind: inspection.session.baseline.profileSources[profile].endsWith("-invalid")
    ? "invalid"
    : "inherit",
  candidates: cloneCandidates(inspection.session.baseline.profiles[profile].candidates),
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
  const current = draft.candidates[index];
  const other = draft.candidates[target];
  if (!current || !other) return draft;
  const reordered = [...draft.candidates];
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
    candidate,
    ...draft.candidates.slice(index + 1),
  ]);
};

export const defaultRouteCandidate = (profile: ProfileId): ProfileCandidate =>
  cloneCandidate(BUILTIN_PROFILE_ROUTES[profile].candidates[0]!);

export const runtimeLabel = (runtime: SubagentRuntime): string =>
  runtime === "pi" ? "Pi" : runtime === "claude" ? "Claude" : "Codex";

const candidateIssueMessage = (
  candidate: ProfileCandidate,
  code: ProfileCandidateValidationIssueCode,
): string => {
  switch (code) {
    case "model_selector_invalid":
      return `Model is not a valid ${runtimeLabel(candidate.runtime)} model name.`;
    case "parent_requires_local_pi":
      return "The parent model is available only with Local Pi.";
    case "fork_requires_local_pi":
      return "Fork is available only with Local Pi.";
    case "retention_requires_herdr_read_only":
      return "Only Herdr read-only runs can stay open after reporting.";
    case "fast_mode_unsupported":
      return `Fast mode is not available with ${runtimeLabel(candidate.runtime)}/${candidate.model}.`;
    case "effort_unsupported":
      return `${runtimeLabel(candidate.runtime)} does not support the ${candidate.effort} reasoning level.`;
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
      patch.runtime === "pi" ? replacementPiModel(next.host, defaults) : defaults.nativeModel;
    if (!model)
      return {
        notices,
        error:
          patch.runtime === "pi"
            ? "Herdr Pi needs a Pi model, but none is available. Check that Pi is signed in."
            : `Choose a ${runtimeLabel(patch.runtime)} model.`,
      };
    next = { ...next, model };
    notices.push(`Model changed to ${model} for ${runtimeLabel(patch.runtime)}.`);
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
            error: "Herdr Pi needs a Pi model, but none is available. Check that Pi is signed in.",
          };
        next = { ...next, model: defaults.piModel };
        notices.push(
          `The parent model works only with Local Pi. Model changed to ${defaults.piModel}.`,
        );
        break;
      case "fork_requires_local_pi":
        next = { ...next, context: "fresh" };
        notices.push("Fork works only with Local Pi. Context changed to Fresh.");
        break;
      case "retention_requires_herdr_read_only":
        next = { ...next, closeOnReport: true };
        notices.push(
          "Only Herdr read-only runs can stay open after reporting. This run will now close after reporting.",
        );
        break;
      case "fast_mode_unsupported":
        next = { ...next, openaiFastMode: false };
        notices.push("The selected model does not support fast mode. Fast mode turned off.");
        break;
      case "effort_unsupported":
        notices.push(
          `${runtimeLabel(next.runtime)} does not support the ${next.effort} reasoning level. Reasoning changed to the profile default.`,
        );
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
    notices.push(
      `${model} does not support the ${candidate.effort} reasoning level. Reasoning changed to the profile default.`,
    );
  }
  if (next.openaiFastMode && !fastModeAvailable) {
    next = { ...next, openaiFastMode: false };
    notices.push(`${model} does not support fast mode. Fast mode turned off.`);
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
          ? `A profile can have at most ${MAX_PROFILE_CANDIDATES} Primary/Fallback choices.`
          : "This profile won't run until you fix it, disable it, or undo your changes.",
    };
  for (const [index, candidate] of draft.candidates.entries()) {
    const error = candidateValidationError(candidate);
    if (error)
      return {
        valid: false,
        error: `${index === 0 ? "Primary" : `Fallback ${index}`}: ${error}`,
      };
  }
  const candidates = cloneCandidates(draft.candidates);
  return {
    valid: true,
    route: candidates.length === 1 ? candidates[0] : candidates,
  };
}
