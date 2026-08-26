import { supportsFastModel } from "pi-better-openai/fast-models";
import * as Equivalence from "effect/Equivalence";
import {
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

export const isProfileId = (value: string): value is ProfileId =>
  PROFILE_IDS.some((profileId) => profileId === value);

export const normalizeProfileId = (value: string): ProfileId | undefined =>
  isProfileId(value) ? value : undefined;

export const MAX_PROFILE_CANDIDATES = 32;
export const MAX_PROFILE_MODEL_SELECTOR_CHARS = 256;
export const PROFILE_CANDIDATE_HOSTS = ["local", "herdr"] as const;
export const PROFILE_CANDIDATE_RUNTIMES = ["pi", "claude", "codex"] as const;
export const PROFILE_CANDIDATE_CONTEXTS = ["fresh", "fork"] as const;
export const PROFILE_CANDIDATE_WRITE_INTENTS = ["read-only", "writer"] as const;
export const PROFILE_CANDIDATE_EFFORTS = [
  "default",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const PROFILE_NATIVE_MODEL_DEFAULTS = {
  claude: "claude-opus-5",
  codex: "gpt-5.6-codex",
} as const;
export type ProfileCandidateEffort = (typeof PROFILE_CANDIDATE_EFFORTS)[number];

const SAFE_NATIVE_MODEL_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*(?:\[[1-9][0-9]*[kKmM]\])?$/;

/** Syntax-only argv/config safety grammar; catalog availability is a runtime rule. */
export const isSafeNativeModelSelector = (selector: string): boolean =>
  selector.length <= MAX_PROFILE_MODEL_SELECTOR_CHARS && SAFE_NATIVE_MODEL_SELECTOR.test(selector);

/** Runtime-specific native selector grammar; catalog canonicalization remains a runtime rule. */
export const isNativeProfileModelSelector = (runtime: string, selector: string): boolean => {
  if (!isSafeNativeModelSelector(selector)) return false;
  if (selector === "parent") return runtime === "pi";
  if (runtime !== "pi") return true;
  const slash = selector.indexOf("/");
  if (slash <= 0 || slash >= selector.length - 1) return false;
  const provider = selector.slice(0, slash);
  const model = selector.slice(slash + 1);
  return (
    /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(provider) &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(model) &&
    model.split("/").every((segment) => segment !== "." && segment !== ".." && segment.length > 0)
  );
};

/** A v4 route candidate. Profile choices apply except for the protocol-only Herdr-to-local fallback. */
export interface ProfileCandidate {
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly model: string;
  readonly effort: ProfileCandidateEffort;
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  /** Requests OpenAI priority service for supported Pi/Codex models. Defaults to false. */
  readonly fastMode: boolean;
  /** Omitted configuration values normalize to true. */
  readonly closeOnReport: boolean;
}

/** Runtime-normalized route. The configured `disabled` value is represented by zero candidates. */
export interface ProfileRoute {
  readonly candidates: ReadonlyArray<ProfileCandidate>;
}

export type DeclaredProfileCandidate = Omit<ProfileCandidate, "closeOnReport" | "fastMode"> & {
  readonly fastMode?: boolean | undefined;
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
  fastMode: candidate.fastMode ?? false,
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
  // SAFETY: Configuration decoding validates the persisted declaration before this typed access.
  const candidates = Array.isArray(route)
    ? (route as ReadonlyArray<DeclaredProfileCandidate>)
    : [route as DeclaredProfileCandidate];
  return { candidates: cloneProfileCandidates(candidates) };
};

export const isLocalPiProfileCandidate = (
  candidate: Pick<ProfileCandidate, "host" | "runtime">,
): boolean => candidate.host === "local" && candidate.runtime === "pi";

export const isRetainableProfileCandidate = (
  candidate: Pick<ProfileCandidate, "host" | "writeIntent">,
): boolean => candidate.host === "herdr" && candidate.writeIntent === "read-only";

const splitPiModelSelector = (
  selector: string,
): { readonly provider: string; readonly model: string } | undefined => {
  const slash = selector.indexOf("/");
  if (slash <= 0 || slash >= selector.length - 1) return undefined;
  return { provider: selector.slice(0, slash), model: selector.slice(slash + 1) };
};

/**
 * Static persisted-route policy. `parent` is deferred to the live parent-model check, explicit Pi
 * selectors must already be priority-tier eligible, and Codex defers tier support to its catalog.
 */
export const supportsProfileFastModeStatically = (
  candidate: Pick<ProfileCandidate, "runtime" | "model">,
): boolean => {
  if (candidate.runtime === "codex") return isNativeProfileModelSelector("codex", candidate.model);
  if (candidate.runtime !== "pi") return false;
  if (candidate.model === "parent") return true;
  const selected = splitPiModelSelector(candidate.model);
  return selected ? supportsFastModel(selected.provider, selected.model) : false;
};

export const PROFILE_CANDIDATE_VALIDATION_ISSUE_CODES = [
  "model_selector_invalid",
  "parent_requires_local_pi",
  "fork_requires_local_pi",
  "retention_requires_herdr_read_only",
  "fast_mode_unsupported",
  "effort_unsupported",
] as const;
export type ProfileCandidateValidationIssueCode =
  (typeof PROFILE_CANDIDATE_VALIDATION_ISSUE_CODES)[number];
export interface ProfileCandidateValidationIssue {
  readonly code: ProfileCandidateValidationIssueCode;
}

/** Exhaustive candidate issues in the repair and user-message order. */
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
  if (!candidate.closeOnReport && !isRetainableProfileCandidate(candidate))
    issues.push({ code: "retention_requires_herdr_read_only" });
  if (candidate.fastMode && !supportsProfileFastModeStatically(candidate))
    issues.push({ code: "fast_mode_unsupported" });
  if (
    candidate.effort !== "default" &&
    !subagentRuntimeSupportsEffort(candidate.runtime, candidate.effort)
  )
    issues.push({ code: "effort_unsupported" });
  return issues;
};

export const profileCandidateLabel = (candidate: ProfileCandidate): string =>
  `${candidate.host}/${candidate.runtime}/${candidate.model}:${candidate.effort}:${candidate.context}:${candidate.writeIntent}:fastMode=${candidate.fastMode}:closeOnReport=${candidate.closeOnReport}`;

const candidateEquivalences = {
  host: Equivalence.strictEqual<SubagentHost>(),
  runtime: Equivalence.strictEqual<SubagentRuntime>(),
  model: Equivalence.strictEqual<string>(),
  effort: Equivalence.strictEqual<ProfileCandidateEffort>(),
  context: Equivalence.strictEqual<SubagentContextMode>(),
  writeIntent: Equivalence.strictEqual<SubagentWriteIntent>(),
  fastMode: Equivalence.strictEqual<boolean>(),
  closeOnReport: Equivalence.strictEqual<boolean>(),
} satisfies {
  readonly [Key in keyof ProfileCandidate]: Equivalence.Equivalence<ProfileCandidate[Key]>;
};

export const sameProfileCandidate = Equivalence.Struct(candidateEquivalences);
export const sameProfileCandidates = Equivalence.Array(sameProfileCandidate);
export const sameProfileRoute = Equivalence.mapInput(
  sameProfileCandidates,
  (route: ProfileRoute) => route.candidates,
);
export type ProfileRouteSource =
  | "session"
  | "project"
  | "global"
  | "builtin"
  | "project-invalid"
  | "global-invalid";

export interface ProfileDefinition {
  readonly id: ProfileId;
  readonly description: string;
  readonly guidance: string;
  readonly defaultContext: SubagentContextMode;
  readonly defaultWriteIntent: SubagentWriteIntent;
  /** Soft built-in preference used by candidates whose effort is `default`. */
  readonly defaultEffort?: SubagentEffort | undefined;
}

export interface SkippedProfileCandidate {
  /** Zero-based configured candidate index. */
  readonly candidateIndex?: number | undefined;
  readonly candidate: string;
  readonly code: string;
  readonly reason: string;
}

/** Immutable launch-time route state used only to continue after an explicit retry action. */
export interface ProfileRouteContinuation {
  readonly profile: ProfileId;
  readonly routeSource: ProfileRouteSource;
  readonly candidates: ReadonlyArray<ProfileCandidate>;
  /** Zero-based candidate selected for the run carrying this continuation. */
  readonly selectedCandidateIndex: number;
  /** Static/dynamic skips accumulated before selection, including same-candidate host fallback. */
  readonly skippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
}

export type SubagentSelectionSource = "profile-candidate" | "profile-parent-candidate";

export interface SubagentSelectionProvenance {
  readonly source: SubagentSelectionSource;
  /** Configuration layer that supplied the selected ordered route. */
  readonly routeSource?: ProfileRouteSource | undefined;
  readonly host?: SubagentHost | undefined;
  readonly runtime?: SubagentRuntime | undefined;
  readonly closeOnReport?: boolean | undefined;
  /** Zero-based configured candidate index. */
  readonly candidateIndex?: number | undefined;
  readonly reason: string;
  readonly skippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
  readonly warning?: string | undefined;
}
