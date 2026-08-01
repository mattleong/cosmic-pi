import { MAX_PROFILE_CANDIDATES, isNativeProfileModelSelector } from "../config/schema.ts";
import type { SubagentConfigInspection, SubagentConfigScope } from "../config/store.ts";
import { BUILTIN_PROFILE_ROUTES } from "../profiles/definitions.ts";
import { supportsSubagentFastMode } from "../run/fast-mode.ts";
import type {
  DeclaredProfileCandidate,
  DeclaredProfileRoute,
  ProfileCandidate,
  ProfileCandidateEffort,
  ProfileId,
} from "../profiles/model.ts";
import {
  subagentRuntimeEfforts,
  subagentRuntimeSupportsEffort,
  type SubagentEffort,
  type SubagentHost,
  type SubagentRuntime,
} from "../run/model.ts";
import { isSafeNativeModelSelector } from "../run/native-model-selector.ts";

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

export const NATIVE_MODEL_DEFAULTS = {
  claude: "claude-opus-5",
  codex: "gpt-5.6-codex",
} as const;

export const runtimeEfforts = (
  runtime: SubagentRuntime,
  supportedModelEfforts?: ReadonlyArray<SubagentEffort> | undefined,
): ReadonlyArray<SubagentEffort> => {
  const supportedByRuntime = subagentRuntimeEfforts(runtime);
  return supportedModelEfforts
    ? supportedModelEfforts.filter((effort) => supportedByRuntime.includes(effort))
    : supportedByRuntime;
};

const cloneCandidate = (
  candidate: DeclaredProfileCandidate | ProfileCandidate,
): ProfileCandidate => ({
  ...candidate,
  fastMode: candidate.fastMode ?? false,
  closeOnReport: candidate.closeOnReport ?? true,
});

const cloneCandidates = (
  candidates: ReadonlyArray<DeclaredProfileCandidate | ProfileCandidate>,
): ReadonlyArray<ProfileCandidate> => candidates.map(cloneCandidate);

const candidatesFromDeclaration = (
  declared: DeclaredProfileRoute,
): ReadonlyArray<ProfileCandidate> =>
  declared === "disabled"
    ? []
    : Array.isArray(declared)
      ? cloneCandidates(declared)
      : [cloneCandidate(declared as DeclaredProfileCandidate)];

const declaredAt = (
  inspection: SubagentConfigInspection,
  scope: SubagentConfigScope,
  profile: ProfileId,
): DeclaredProfileRoute | undefined =>
  scope === "global"
    ? inspection.global.file.profiles?.[profile]
    : inspection.project?.file.profiles?.[profile];

const scopeRouteInvalid = (
  inspection: SubagentConfigInspection,
  scope: SubagentConfigScope,
  profile: ProfileId,
): boolean =>
  (scope === "global" ? inspection.global : inspection.project)?.invalidProfileRoutes.includes(
    profile,
  ) ?? false;

const globalReferenceCandidates = (
  inspection: SubagentConfigInspection,
  profile: ProfileId,
): ReadonlyArray<ProfileCandidate> => {
  if (inspection.global.invalidProfileRoutes.includes(profile)) return [];
  const declared = inspection.global.file.profiles?.[profile];
  return declared === undefined
    ? cloneCandidates(BUILTIN_PROFILE_ROUTES[profile].candidates)
    : candidatesFromDeclaration(declared);
};

/** Loads the exact declaration state without collapsing or reordering ordered candidates. */
export function loadProfileRouteDraft(
  inspection: SubagentConfigInspection,
  scope: SubagentConfigScope,
  profile: ProfileId,
): ProfileRouteDraft {
  if (scopeRouteInvalid(inspection, scope, profile)) return { kind: "invalid", candidates: [] };
  const declared = declaredAt(inspection, scope, profile);
  if (declared === undefined)
    return scope === "global"
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
  inspection: SubagentConfigInspection,
  profile: ProfileId,
): ProfileRouteDraft => ({
  kind: "inherit",
  candidates: globalReferenceCandidates(inspection, profile),
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

const effortAllowedForRuntime = (
  runtime: SubagentRuntime,
  effort: ProfileCandidateEffort,
): boolean => effort === "default" || subagentRuntimeSupportsEffort(runtime, effort);

export function candidateValidationError(candidate: ProfileCandidate): string | undefined {
  if (
    !isSafeNativeModelSelector(candidate.model) ||
    !isNativeProfileModelSelector(candidate.runtime, candidate.model)
  )
    return `Model is not a valid bounded ${candidate.runtime} selector.`;
  if (candidate.model === "parent" && (candidate.host !== "local" || candidate.runtime !== "pi"))
    return "Parent model is valid only for local Pi.";
  if (candidate.context === "fork" && (candidate.host !== "local" || candidate.runtime !== "pi"))
    return "Fork context is valid only for local Pi.";
  if (
    !candidate.closeOnReport &&
    (candidate.host !== "herdr" || candidate.writeIntent !== "read-only")
  )
    return "Retaining a reported run is valid only for Herdr read-only candidates.";
  if (
    candidate.fastMode &&
    candidate.model !== "parent" &&
    !supportsSubagentFastMode(candidate.runtime, candidate.model)
  )
    return `Fast mode is unavailable for ${candidate.runtime}/${candidate.model}.`;
  if (!effortAllowedForRuntime(candidate.runtime, candidate.effort))
    return `${candidate.runtime} does not support effort ${candidate.effort}.`;
  return undefined;
}

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
        : NATIVE_MODEL_DEFAULTS[patch.runtime];
    if (!model)
      return {
        notices,
        error: "Herdr Pi requires an authenticated canonical Pi model, but none is available.",
      };
    next = { ...next, model };
    notices.push(`Model reset to ${model} for ${patch.runtime}.`);
  }

  if (next.runtime === "pi" && next.model === "parent" && next.host !== "local") {
    if (!defaults.piModel)
      return {
        notices: [],
        error: "Herdr Pi requires an authenticated canonical Pi model, but none is available.",
      };
    next = { ...next, model: defaults.piModel };
    notices.push(`Parent is local-only; model reset to ${defaults.piModel}.`);
  }

  if (next.context === "fork" && (next.host !== "local" || next.runtime !== "pi")) {
    next = { ...next, context: "fresh" };
    notices.push("Fork is local-Pi-only; context reset to fresh.");
  }
  if (!next.closeOnReport && (next.host !== "herdr" || next.writeIntent !== "read-only")) {
    next = { ...next, closeOnReport: true };
    notices.push("Only Herdr read-only runs may be retained; close-on-report reset to true.");
  }
  if (
    next.fastMode &&
    next.model !== "parent" &&
    !supportsSubagentFastMode(next.runtime, next.model)
  ) {
    next = { ...next, fastMode: false };
    notices.push("Fast mode is unavailable for the selected runtime/model; reset to off.");
  }
  if (!effortAllowedForRuntime(next.runtime, next.effort)) {
    next = { ...next, effort: "default" };
    notices.push(
      `Effort ${candidate.effort} is unavailable for ${next.runtime}; reset to default.`,
    );
  }
  return { candidate: next, notices };
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
  if (next.fastMode && !fastModeAvailable) {
    next = { ...next, fastMode: false };
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

const boundedMiddle = (value: string, maximum: number): string => {
  const characters = [...value];
  if (characters.length <= maximum) return value;
  const left = Math.max(1, Math.floor((maximum - 1) / 2));
  return `${characters.slice(0, left).join("")}…${characters.slice(characters.length - (maximum - left - 1)).join("")}`;
};

/** Bounded one-line summary that still names every product field. */
export const candidateMenuSummary = (candidate: ProfileCandidate, index: number): string =>
  `${String(index + 1).padStart(2, "0")} · ${candidate.host}/${candidate.runtime} · ${boundedMiddle(candidate.model, 56)} · ${candidate.effort} · ${candidate.context} · ${candidate.writeIntent} · ${candidate.fastMode ? "fast" : "standard"} · ${candidate.closeOnReport ? "close" : "retain"}`;

export const completeRouteSummary = (
  draft: ProfileRouteDraft,
  scope: SubagentConfigScope,
): string => {
  if (draft.kind === "disabled") return "Disabled";
  if (draft.kind === "invalid") return "Invalid fail-closed route (replacement required)";
  const disposition =
    draft.kind === "reset"
      ? "Reset to built-in (remove global declaration)"
      : draft.kind === "inherit"
        ? "Inherit global (remove project declaration)"
        : "Explicit ordered route";
  const candidates = draft.candidates
    .map(
      (candidate, index) =>
        `${index + 1}. host=${candidate.host} · runtime=${candidate.runtime} · model=${candidate.model} · effort=${candidate.effort} · context=${candidate.context} · writeIntent=${candidate.writeIntent} · fastMode=${candidate.fastMode} · closeOnReport=${candidate.closeOnReport}`,
    )
    .join("\n");
  return candidates
    ? `${disposition}\n${candidates}`
    : scope === "project"
      ? "Inherit global (resolved route has no candidates)"
      : "Reset to built-in";
};
