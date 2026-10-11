import { supportsFastModel } from "pi-better-openai/fast-models";
import * as Equivalence from "effect/Equivalence";
import {
  SUBAGENT_EFFORTS,
  subagentRuntimeSupportsEffort,
  type SubagentContextMode,
  type SubagentEffort,
  type SubagentHost,
  type SubagentRuntime,
  type SubagentWriteIntent,
} from "../domain/routing.ts";

export const PROFILE_IDS = [
  "scout",
  "researcher",
  "planner",
  "worker",
  "reviewer",
  "oracle",
  "generalist",
] as const;

export type ProfileId = (typeof PROFILE_IDS)[number];

export const mapProfileIds = <A>(f: (id: ProfileId) => A) => ({
  scout: f("scout"),
  researcher: f("researcher"),
  planner: f("planner"),
  worker: f("worker"),
  reviewer: f("reviewer"),
  oracle: f("oracle"),
  generalist: f("generalist"),
});

export const completeProfileRecord = <A>(
  partial: Partial<Readonly<Record<ProfileId, A>>>,
): Record<ProfileId, A> | undefined => {
  const { scout, researcher, planner, worker, reviewer, oracle, generalist } = partial;
  return scout !== undefined &&
    researcher !== undefined &&
    planner !== undefined &&
    worker !== undefined &&
    reviewer !== undefined &&
    oracle !== undefined &&
    generalist !== undefined
    ? { scout, researcher, planner, worker, reviewer, oracle, generalist }
    : undefined;
};

export const isProfileId = (value: string): value is ProfileId =>
  PROFILE_IDS.some((profileId) => profileId === value);

export const MAX_PROFILE_CANDIDATES = 32;
export const MAX_PROFILE_MODEL_SELECTOR_CHARS = 256;
export const PROFILE_CANDIDATE_HOSTS = ["local"] as const;
export const PROFILE_CANDIDATE_RUNTIMES = ["pi", "claude", "codex"] as const;
export const PROFILE_CANDIDATE_CONTEXTS = ["fresh", "fork"] as const;
export const PROFILE_CANDIDATE_WRITE_INTENTS = ["read-only", "writer"] as const;
export const PROFILE_CANDIDATE_EFFORTS = ["default", ...SUBAGENT_EFFORTS] as const;
export type ProfileCandidateEffort = (typeof PROFILE_CANDIDATE_EFFORTS)[number];

const SAFE_NATIVE_MODEL_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*(?:\[[1-9][0-9]*[kKmM]\])?$/;

export const isSafeNativeModelSelector = (selector: string): boolean =>
  selector.length <= MAX_PROFILE_MODEL_SELECTOR_CHARS && SAFE_NATIVE_MODEL_SELECTOR.test(selector);

const splitPiModelSelector = (
  selector: string,
): { readonly provider: string; readonly model: string } | undefined => {
  const slash = selector.indexOf("/");
  if (slash <= 0 || slash >= selector.length - 1) return undefined;
  return { provider: selector.slice(0, slash), model: selector.slice(slash + 1) };
};

export const isNativeProfileModelSelector = (runtime: string, selector: string): boolean => {
  if (!isSafeNativeModelSelector(selector)) return false;
  if (selector === "parent") return runtime === "pi";
  if (runtime !== "pi") return true;
  const split = splitPiModelSelector(selector);
  return (
    split !== undefined &&
    /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(split.provider) &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(split.model) &&
    split.model
      .split("/")
      .every((segment) => segment !== "." && segment !== ".." && segment.length > 0)
  );
};

export interface ProfileCandidate {
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly model: string;
  readonly effort: ProfileCandidateEffort;
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  readonly openaiFastMode?: boolean | undefined;
  readonly closeOnReport: boolean;
}

export interface ProfileRoute {
  readonly candidates: ReadonlyArray<ProfileCandidate>;
}

export type DeclaredProfileCandidate = Omit<ProfileCandidate, "closeOnReport"> & {
  readonly closeOnReport?: boolean | undefined;
};
export type DeclaredProfileRoute =
  | DeclaredProfileCandidate
  | ReadonlyArray<DeclaredProfileCandidate>
  | "disabled";

export const normalizeProfileCandidate = (
  candidate: DeclaredProfileCandidate,
): ProfileCandidate => ({
  ...candidate,
  closeOnReport: candidate.closeOnReport ?? true,
});

export const cloneProfileCandidates = (
  candidates: ReadonlyArray<DeclaredProfileCandidate>,
): ReadonlyArray<ProfileCandidate> => candidates.map(normalizeProfileCandidate);

export const cloneProfileRoute = (route: ProfileRoute): ProfileRoute => ({
  candidates: cloneProfileCandidates(route.candidates),
});

export const normalizeDeclaredProfileRoute = (route: DeclaredProfileRoute): ProfileRoute => {
  if (route === "disabled") return { candidates: [] };
  return { candidates: cloneProfileCandidates("host" in route ? [route] : route) };
};

export const isLocalPiProfileCandidate = (
  candidate: Pick<ProfileCandidate, "host" | "runtime">,
): boolean => candidate.host === "local" && candidate.runtime === "pi";

export const supportsSubagentFastMode = (runtime: SubagentRuntime, model: string): boolean => {
  if (runtime === "codex") return isNativeProfileModelSelector("codex", model);
  if (runtime !== "pi") return false;
  if (model === "parent") return true;
  const selected = splitPiModelSelector(model);
  return selected ? supportsFastModel(selected.provider, selected.model) : false;
};

export const PROFILE_CANDIDATE_VALIDATION_ISSUE_CODES = [
  "model_selector_invalid",
  "parent_requires_local_pi",
  "fork_requires_local_pi",
  "close_after_report_required",
  "fast_mode_unsupported",
  "effort_unsupported",
] as const;
export type ProfileCandidateValidationIssueCode =
  (typeof PROFILE_CANDIDATE_VALIDATION_ISSUE_CODES)[number];
export interface ProfileCandidateValidationIssue {
  readonly code: ProfileCandidateValidationIssueCode;
}

export const profileCandidateValidationIssues = (
  candidate: ProfileCandidate,
): ReadonlyArray<ProfileCandidateValidationIssue> => {
  const issues: ProfileCandidateValidationIssue[] = [];
  if (!isNativeProfileModelSelector(candidate.runtime, candidate.model))
    issues.push({ code: "model_selector_invalid" });
  if (candidate.model === "parent" && !isLocalPiProfileCandidate(candidate))
    issues.push({ code: "parent_requires_local_pi" });
  if (candidate.context === "fork" && !isLocalPiProfileCandidate(candidate))
    issues.push({ code: "fork_requires_local_pi" });
  if (!candidate.closeOnReport) issues.push({ code: "close_after_report_required" });
  if (
    candidate.openaiFastMode === true &&
    !supportsSubagentFastMode(candidate.runtime, candidate.model)
  )
    issues.push({ code: "fast_mode_unsupported" });
  if (
    candidate.effort !== "default" &&
    !subagentRuntimeSupportsEffort(candidate.runtime, candidate.effort)
  )
    issues.push({ code: "effort_unsupported" });
  return issues;
};

export const profileCandidateLabel = (candidate: ProfileCandidate): string =>
  `${candidate.host}/${candidate.runtime}/${candidate.model}:${candidate.effort}:${candidate.context}:${candidate.writeIntent}:openaiFastMode=${candidate.openaiFastMode ?? false}:closeOnReport=${candidate.closeOnReport}`;

export const PROFILE_CANDIDATE_BASE_KEYS = [
  "host",
  "runtime",
  "model",
  "effort",
  "context",
  "writeIntent",
  "closeOnReport",
] as const;

export const sameProfileCandidate = Equivalence.make<ProfileCandidate>(
  (left, right) =>
    PROFILE_CANDIDATE_BASE_KEYS.every((key) => left[key] === right[key]) &&
    (left.openaiFastMode ?? false) === (right.openaiFastMode ?? false),
);
export const sameProfileRoute = Equivalence.mapInput(
  Equivalence.Array(sameProfileCandidate),
  (route: ProfileRoute) => route.candidates,
);
export const PROFILE_ROUTE_SOURCES = [
  "session",
  "project",
  "global",
  "builtin",
  "project-invalid",
  "global-invalid",
] as const;
export type ProfileRouteSource = (typeof PROFILE_ROUTE_SOURCES)[number];

export interface ProfileDefinition {
  readonly id: ProfileId;
  readonly description: string;
  readonly guidance: string;
  readonly defaultContext: SubagentContextMode;
  readonly defaultWriteIntent: SubagentWriteIntent;
  readonly defaultEffort?: SubagentEffort | undefined;
}

export interface SkippedProfileCandidate {
  readonly candidateIndex?: number | undefined;
  readonly candidate: string;
  readonly code: string;
  readonly reason: string;
}

export interface ProfileRouteContinuation {
  readonly profile: ProfileId;
  readonly routeSource: ProfileRouteSource;
  readonly candidates: ReadonlyArray<ProfileCandidate>;
  readonly selectedCandidateIndex: number;
  readonly skippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
}

export type SubagentSelectionSource = "profile-candidate" | "profile-parent-candidate";

export interface SubagentSelectionProvenance {
  readonly source: SubagentSelectionSource;
  readonly routeSource?: ProfileRouteSource | undefined;
  readonly candidateIndex?: number | undefined;
  readonly reason: string;
  readonly skippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
  readonly warning?: string | undefined;
}
