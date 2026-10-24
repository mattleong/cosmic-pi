import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { resolveNamedProfileSet } from "../config/options.ts";
import type { SubagentConfigInspection, SubagentConfigScope } from "../config/store.ts";
import { builtinProfileCandidate } from "../profiles/definitions.ts";
import type { SessionProfileSnapshot } from "../profiles/session-overrides.ts";
import {
  cloneProfileCandidates as cloneCandidates,
  MAX_PROFILE_CANDIDATES,
  normalizeProfileCandidate as cloneCandidate,
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

export const profileTargetKey = (target: ProfileWorkspaceTarget): string =>
  target.kind === "session" ? "session" : `${target.set.scope}:${target.set.name}`;

export const SCOPE_LABELS = {
  session: "Session",
  global: "Global",
  project: "Project",
} as const satisfies Record<ProfileSettingsScope, string>;

export interface ProfileSettingsInspection extends SubagentConfigInspection {
  readonly session: SessionProfileSnapshot;
}

type ProfileRouteDraftKind = "explicit" | "disabled" | "reset" | "inherit" | "invalid";

export interface ProfileRouteDraft {
  readonly kind: ProfileRouteDraftKind;
  readonly candidates: ReadonlyArray<ProfileCandidate>;
}

interface CandidateControlDefaults {
  readonly nativeModel?: string | undefined;
}

export interface CandidateUpdate {
  readonly candidate?: ProfileCandidate | undefined;
  readonly notices: ReadonlyArray<string>;
  readonly error?: string | undefined;
}

export const runtimeEfforts = (
  runtime: SubagentRuntime,
  supportedModelEfforts?: ReadonlyArray<SubagentEffort>,
): ReadonlyArray<SubagentEffort> => {
  const supportedByRuntime = subagentRuntimeEfforts(runtime);
  return supportedModelEfforts
    ? Arr.filter(supportedModelEfforts, (effort) => supportedByRuntime.includes(effort))
    : supportedByRuntime;
};

const profileSetAt = (inspection: ProfileSettingsInspection, set: PersistentProfileSetRef) => {
  const profileSets = inspection[set.scope]?.file.profileSets;
  return profileSets && Rec.has(profileSets, set.name) ? profileSets[set.name] : undefined;
};

const declaredAt = (
  inspection: ProfileSettingsInspection,
  set: PersistentProfileSetRef,
  profile: ProfileId,
): DeclaredProfileRoute | undefined => profileSetAt(inspection, set)?.profiles[profile];

export const resolvedSet = (inspection: ProfileSettingsInspection, set: PersistentProfileSetRef) =>
  resolveNamedProfileSet({ ...set, global: inspection.global, project: inspection.project });

export const hasOwnProfileRouteDeclaration = (
  inspection: ProfileSettingsInspection,
  target: ProfileWorkspaceTarget,
  profile: ProfileId,
): boolean => {
  if (target.kind === "session") return inspection.session.overrides[profile] !== undefined;
  const decoded = inspection[target.set.scope];
  if (!decoded) return false;
  return (
    declaredAt(inspection, target.set, profile) !== undefined ||
    (decoded.invalidProfileSetRoutes[target.set.name]?.includes(profile) ?? false)
  );
};

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
    const { baseline } = inspection.session;
    return {
      kind: Fn.pipe(baseline.profileSources[profile], Str.endsWith("-invalid"))
        ? "invalid"
        : "inherit",
      candidates: cloneCandidates(baseline.profiles[profile].candidates),
    };
  }
  const set = target.set;
  const resolved = resolvedSet(inspection, set);
  if (resolved.invalidProfiles.includes(profile)) return { kind: "invalid", candidates: [] };
  const declared = declaredAt(inspection, set, profile);
  return {
    kind:
      declared === undefined
        ? set.scope === "global"
          ? "reset"
          : "inherit"
        : declared === "disabled"
          ? "disabled"
          : "explicit",
    candidates: cloneCandidates(resolved.profiles[profile].candidates),
  };
}

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
    Arr.map(draft.candidates, (current, candidateIndex) =>
      candidateIndex === index ? candidate : current,
    ),
  );

export const removeRouteCandidate = (
  draft: ProfileRouteDraft,
  index: number,
): ProfileRouteDraft => {
  const candidates = Arr.filter(draft.candidates, (_, candidateIndex) => candidateIndex !== index);
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
  cloneCandidate(builtinProfileCandidate(profile));

const RUNTIME_LABELS = {
  pi: "Pi",
  claude: "Claude",
} as const satisfies Record<SubagentRuntime, string>;

export const runtimeLabel = (runtime: SubagentRuntime): string => RUNTIME_LABELS[runtime];

export const profileRouteOptionLabel = (index: number): string =>
  index <= 0 ? "Primary" : `Fallback ${index}`;

export const CANDIDATE_LIMIT_ERROR = `A profile can have at most ${MAX_PROFILE_CANDIDATES} Primary/Fallback choices.`;
export const CANDIDATE_LIMIT_REACHED = `The ${MAX_PROFILE_CANDIDATES}-candidate limit has been reached.`;

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
    case "fast_mode_unsupported":
      return `Fast mode is not available with ${runtimeLabel(candidate.runtime)}/${candidate.model}.`;
    case "effort_unsupported":
      return `${runtimeLabel(candidate.runtime)} does not support the ${candidate.effort} reasoning level.`;
  }
  return Fn.absurd(code);
};

const candidateValidationError = (candidate: ProfileCandidate): string | undefined => {
  const issue = profileCandidateValidationIssues(candidate)[0];
  return issue ? candidateIssueMessage(candidate, issue.code) : undefined;
};

export function updateCandidateControls(
  candidate: ProfileCandidate,
  patch: Partial<Pick<ProfileCandidate, "runtime" | "writeIntent">>,
  defaults: CandidateControlDefaults,
): CandidateUpdate {
  const notices: string[] = [];
  let next: ProfileCandidate = { ...candidate, ...patch };

  if (patch.runtime !== undefined && patch.runtime !== candidate.runtime) {
    const model = patch.runtime === "pi" ? "parent" : defaults.nativeModel;
    if (!model)
      return {
        notices,
        error: `Choose a ${runtimeLabel(patch.runtime)} model.`,
      };
    next = { ...next, model };
    notices.push(`Model changed to ${model} for ${runtimeLabel(patch.runtime)}.`);
  }

  for (;;) {
    const issue = profileCandidateValidationIssues(next)[0];
    if (!issue) return { candidate: next, notices };
    switch (issue.code) {
      case "model_selector_invalid":
      case "parent_requires_local_pi":
        return { notices, error: candidateIssueMessage(next, issue.code) };
      case "fork_requires_local_pi":
        next = { ...next, context: "fresh" };
        notices.push("Fork works only with Local Pi. Context changed to Fresh.");
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
  supportedEfforts?: ReadonlyArray<SubagentEffort>,
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

type RouteDeclarationResult =
  | { readonly valid: true; readonly route?: DeclaredProfileRoute | undefined }
  | { readonly valid: false; readonly error: string };

export function declaredRouteForDraft(draft: ProfileRouteDraft): RouteDeclarationResult {
  if (draft.kind === "reset" || draft.kind === "inherit") return { valid: true };
  if (draft.kind === "disabled") return { valid: true, route: "disabled" };
  if (draft.candidates.length > MAX_PROFILE_CANDIDATES)
    return { valid: false, error: CANDIDATE_LIMIT_ERROR };
  if (draft.kind === "invalid" || draft.candidates.length === 0)
    return {
      valid: false,
      error: "This profile won't run until you fix it, disable it, or undo your changes.",
    };
  for (const [index, candidate] of draft.candidates.entries()) {
    const error = candidateValidationError(candidate);
    if (error) return { valid: false, error: `${profileRouteOptionLabel(index)}: ${error}` };
  }
  const candidates = cloneCandidates(draft.candidates);
  return {
    valid: true,
    route: candidates.length === 1 ? candidates[0] : candidates,
  };
}
