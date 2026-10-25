import { supportsFastModel } from "pi-better-openai/fast-models";
import * as Arr from "effect/Array";
import * as Equivalence from "effect/Equivalence";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  SUBAGENT_EFFORTS,
  type SubagentContextMode,
  type SubagentEffort,
  type SubagentWriteIntent,
} from "../domain/routing.ts";
import type { CustomAgent } from "./agents.ts";

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

export const isProfileId = Schema.is(Schema.Literals(PROFILE_IDS));

export const MAX_PROFILE_CANDIDATES = 32;
export const MAX_PROFILE_MODEL_SELECTOR_CHARS = 256;
export const PROFILE_CANDIDATE_CONTEXTS = ["fresh", "fork"] as const;
export const PROFILE_CANDIDATE_WRITE_INTENTS = ["read-only", "writer"] as const;
export const PROFILE_CANDIDATE_EFFORTS = ["default", ...SUBAGENT_EFFORTS] as const;
type ProfileCandidateEffort = (typeof PROFILE_CANDIDATE_EFFORTS)[number];

const SAFE_NATIVE_MODEL_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

export const isSafeNativeModelSelector = (selector: string): boolean =>
  selector.length <= MAX_PROFILE_MODEL_SELECTOR_CHARS && SAFE_NATIVE_MODEL_SELECTOR.test(selector);

const splitPiModelSelector = (
  selector: string,
): { readonly provider: string; readonly model: string } | undefined => {
  const slash = Option.getOrElse(Fn.pipe(selector, Str.indexOf("/")), () => -1);
  if (slash <= 0 || slash >= selector.length - 1) return undefined;
  return {
    provider: Fn.pipe(selector, Str.slice(0, slash)),
    model: Fn.pipe(selector, Str.slice(slash + 1)),
  };
};

/** `parent`, or a safe `provider/model` selector. */
export const isProfileModelSelector = (selector: string): boolean => {
  if (!isSafeNativeModelSelector(selector)) return false;
  if (selector === "parent") return true;
  const split = splitPiModelSelector(selector);
  return (
    split !== undefined &&
    /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(split.provider) &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(split.model) &&
    Fn.pipe(
      split.model,
      Str.split("/"),
      Arr.every((segment) => segment !== "." && segment !== ".." && segment.length > 0),
    )
  );
};

export interface ProfileCandidate {
  readonly model: string;
  readonly effort: ProfileCandidateEffort;
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  readonly openaiFastMode?: boolean | undefined;
}

export interface ProfileRoute {
  readonly candidates: ReadonlyArray<ProfileCandidate>;
}

export type DeclaredProfileRoute = ProfileCandidate | ReadonlyArray<ProfileCandidate> | "disabled";

export const normalizeProfileCandidate = ({
  model,
  effort,
  context,
  writeIntent,
  openaiFastMode,
}: ProfileCandidate): ProfileCandidate => ({
  model,
  effort,
  context,
  writeIntent,
  ...(openaiFastMode !== undefined && { openaiFastMode }),
});

export const cloneProfileCandidates = (
  candidates: ReadonlyArray<ProfileCandidate>,
): ReadonlyArray<ProfileCandidate> => Arr.map(candidates, normalizeProfileCandidate);

export const cloneProfileRoute = (route: ProfileRoute): ProfileRoute => ({
  candidates: cloneProfileCandidates(route.candidates),
});

export const normalizeDeclaredProfileRoute = (route: DeclaredProfileRoute): ProfileRoute => {
  if (route === "disabled") return { candidates: [] };
  return { candidates: cloneProfileCandidates(Arr.ensure(route)) };
};

export const supportsSubagentFastMode = (model: string): boolean => {
  if (model === "parent") return true;
  const selected = splitPiModelSelector(model);
  return selected ? supportsFastModel(selected.provider, selected.model) : false;
};

const PROFILE_CANDIDATE_VALIDATION_ISSUE_CODES = [
  "model_selector_invalid",
  "fast_mode_unsupported",
] as const;
export type ProfileCandidateValidationIssueCode =
  (typeof PROFILE_CANDIDATE_VALIDATION_ISSUE_CODES)[number];
interface ProfileCandidateValidationIssue {
  readonly code: ProfileCandidateValidationIssueCode;
}

export const profileCandidateValidationIssues = (
  candidate: ProfileCandidate,
): ReadonlyArray<ProfileCandidateValidationIssue> => {
  const issues: ProfileCandidateValidationIssue[] = [];
  if (!isProfileModelSelector(candidate.model)) issues.push({ code: "model_selector_invalid" });
  if (candidate.openaiFastMode === true && !supportsSubagentFastMode(candidate.model))
    issues.push({ code: "fast_mode_unsupported" });
  return issues;
};

export const profileCandidateLabel = (candidate: ProfileCandidate): string =>
  `${candidate.model}:${candidate.effort}:${candidate.context}:${candidate.writeIntent}:openaiFastMode=${candidate.openaiFastMode ?? false}`;

const PROFILE_CANDIDATE_KEYS = ["model", "effort", "context", "writeIntent"] as const;

export const sameProfileCandidate = Equivalence.make<ProfileCandidate>(
  (left, right) =>
    Arr.every(PROFILE_CANDIDATE_KEYS, (key) => left[key] === right[key]) &&
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

/** A launch routes through its profile's configured route or a per-launch model override. */
export type LaunchRouteSource = ProfileRouteSource | "override";

/**
 * A per-launch model override: the only candidate a launch tries, with no fallback. Context and
 * write intent still come from the profile, or the agent when one is launched; fast mode is off.
 */
export interface SubagentModelOverride {
  readonly model: string;
  readonly effort?: ProfileCandidateEffort | undefined;
}

export const modelOverrideCandidate = (
  override: SubagentModelOverride,
  definition: Pick<ProfileDefinition, "defaultContext" | "defaultWriteIntent">,
  agent?: Pick<CustomAgent, "effort" | "context" | "writeIntent">,
): ProfileCandidate => ({
  model: override.model,
  effort: override.effort ?? agent?.effort ?? "default",
  context: agent?.context ?? definition.defaultContext,
  writeIntent: agent?.writeIntent ?? definition.defaultWriteIntent,
});

export interface ProfileDefinition {
  readonly id: ProfileId;
  readonly description: string;
  readonly guidance: string;
  readonly defaultContext: SubagentContextMode;
  readonly defaultWriteIntent: SubagentWriteIntent;
  readonly defaultEffort?: SubagentEffort | undefined;
}

/** The route fields that identify a skipped candidate; effort may already be resolved. */
type SkippedCandidateRoute = Pick<ProfileCandidate, "model" | "effort">;

export const skippedCandidateRoute = ({
  model,
  effort,
}: SkippedCandidateRoute): SkippedCandidateRoute => ({ model, effort });

export const skippedCandidateLabel = ({ model, effort }: SkippedCandidateRoute): string =>
  `${model}:${effort}`;

export interface SkippedProfileCandidate {
  readonly candidateIndex?: number | undefined;
  readonly candidate: SkippedCandidateRoute;
  readonly code: string;
  readonly reason: string;
}

/** The launch-time route, frozen so later edits never change what a run reports as its next candidate. */
export interface ProfileRouteContinuation {
  readonly candidates: ReadonlyArray<ProfileCandidate>;
  readonly selectedCandidateIndex: number;
}

export type SubagentSelectionSource = "profile-candidate" | "profile-parent-candidate";

export interface SubagentSelectionProvenance {
  readonly source: SubagentSelectionSource;
  readonly routeSource?: LaunchRouteSource | undefined;
  readonly candidateIndex?: number | undefined;
  readonly reason: string;
  readonly skippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
  readonly warning?: string | undefined;
}
