import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { freezeSnapshot } from "pi-cosmic-core";
import type { ResolvedSubagentConfig } from "../config/options.ts";
import {
  decodeProfileCandidate,
  decodeSubagentNesting,
  type SubagentNestingPolicy,
} from "../config/schema.ts";
import { MAX_PROFILE_CANDIDATES } from "./model.ts";
import {
  cloneProfileRoute,
  PROFILE_IDS,
  sameProfileRoute,
  type ProfileCandidate,
  type ProfileId,
  type ProfileRoute,
} from "./model.ts";

export type SessionProfileOverrides = Partial<Readonly<Record<ProfileId, ProfileRoute>>>;

export interface SessionProfileOverrideSeed {
  readonly revision: number;
  readonly overrides: SessionProfileOverrides;
  readonly nesting?: SubagentNestingPolicy | undefined;
}

export interface SessionProfileSnapshot extends SessionProfileOverrideSeed {
  readonly baseConfig: ResolvedSubagentConfig;
  readonly effectiveConfig: ResolvedSubagentConfig;
}

export interface SessionProfilePatch {
  readonly profile: ProfileId;
  /** Undefined clears the temporary declaration and reveals the loaded base route. */
  readonly route?: ProfileRoute | undefined;
  readonly expectedRevision: number;
}

export interface SessionNestingPatch {
  /** Undefined clears the session policy and reveals persistent configuration. */
  readonly nesting?: SubagentNestingPolicy | undefined;
  readonly expectedRevision: number;
}

export class SessionProfileConflictError extends Schema.TaggedError<SessionProfileConflictError>()(
  "SessionProfileConflictError",
  {
    expectedRevision: Schema.Number,
    actualRevision: Schema.Number,
    message: Schema.String,
  },
) {}

const SessionOverrideRouteInputSchema = Schema.Struct({
  candidates: Schema.Array(Schema.Unknown),
});
const SessionOverridesInputSchema = Schema.Struct({
  scout: Schema.optional(SessionOverrideRouteInputSchema),
  researcher: Schema.optional(SessionOverrideRouteInputSchema),
  planner: Schema.optional(SessionOverrideRouteInputSchema),
  worker: Schema.optional(SessionOverrideRouteInputSchema),
  reviewer: Schema.optional(SessionOverrideRouteInputSchema),
  oracle: Schema.optional(SessionOverrideRouteInputSchema),
  generalist: Schema.optional(SessionOverrideRouteInputSchema),
});
const SessionProfileOverrideSeedInputSchema = Schema.Struct({
  revision: Schema.Number.check(
    Schema.isFinite(),
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  overrides: SessionOverridesInputSchema,
  nesting: Schema.optional(Schema.Unknown),
});
const exactDecodeOptions = { onExcessProperty: "error" as const };

type OwnDataProperty =
  | { readonly valid: true; readonly present: false }
  | { readonly valid: true; readonly present: true; readonly value: unknown }
  | { readonly valid: false };

const ownDataProperty = <ValueInput>(value: ValueInput, key: string): OwnDataProperty => {
  if (!Predicate.isObjectKeyword(value)) return { valid: true, present: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { valid: true, present: false };
    return "value" in descriptor
      ? { valid: true, present: true, value: descriptor.value }
      : { valid: false };
  } catch {
    return { valid: false };
  }
};

/** Rejects known oversized candidate arrays before Schema can traverse any candidate element. */
const preflightSessionOverrideCandidateLengths = <ValueInput>(value: ValueInput): boolean => {
  const overrides = ownDataProperty(value, "overrides");
  if (!overrides.valid) return false;
  if (!overrides.present) return true;
  for (const profile of PROFILE_IDS) {
    const route = ownDataProperty(overrides.value, profile);
    if (!route.valid) return false;
    if (!route.present) continue;
    const candidates = ownDataProperty(route.value, "candidates");
    if (!candidates.valid) return false;
    if (!candidates.present) continue;
    let isArray: boolean;
    try {
      isArray = Array.isArray(candidates.value);
    } catch {
      return false;
    }
    if (!isArray) continue;
    const length = ownDataProperty(candidates.value, "length");
    if (
      !length.valid ||
      !length.present ||
      !Predicate.isNumber(length.value) ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > MAX_PROFILE_CANDIDATES
    )
      return false;
  }
  return true;
};

export const emptySessionProfileOverrideSeed = (): SessionProfileOverrideSeed =>
  freezeSnapshot({ revision: 0, overrides: {} });

export const cloneSessionProfileOverrideSeed = (
  seed: SessionProfileOverrideSeed,
): SessionProfileOverrideSeed => {
  const overrides: Partial<Record<ProfileId, ProfileRoute>> = {};
  for (const profile of PROFILE_IDS) {
    const route = seed.overrides[profile];
    if (route) overrides[profile] = cloneProfileRoute(route);
  }
  const base = { revision: Math.max(0, Math.floor(seed.revision)), overrides };
  return freezeSnapshot(
    seed.nesting === undefined ? base : { ...base, nesting: { ...seed.nesting } },
  );
};

/** Strict unknown-boundary decoder for process-memory reload handoffs. */
export const decodeSessionProfileOverrideSeed = <ValueInput>(
  value: ValueInput,
): SessionProfileOverrideSeed | undefined => {
  if (!preflightSessionOverrideCandidateLengths(value)) return undefined;
  const decoded = Schema.decodeUnknownOption(
    SessionProfileOverrideSeedInputSchema,
    exactDecodeOptions,
  )(value);
  if (Option.isNone(decoded) || !Number.isSafeInteger(decoded.value.revision)) return undefined;
  const overrides: Partial<Record<ProfileId, ProfileRoute>> = {};
  for (const profile of PROFILE_IDS) {
    const route = decoded.value.overrides[profile];
    if (!route) continue;
    if (route.candidates.length > MAX_PROFILE_CANDIDATES) return undefined;
    const candidates: ProfileCandidate[] = [];
    for (const input of route.candidates) {
      const candidate = decodeProfileCandidate(input);
      if (!candidate) return undefined;
      candidates.push(candidate);
    }
    overrides[profile] = { candidates };
  }
  const nesting =
    decoded.value.nesting === undefined ? undefined : decodeSubagentNesting(decoded.value.nesting);
  if (decoded.value.nesting !== undefined && nesting === undefined) return undefined;
  return cloneSessionProfileOverrideSeed(
    nesting === undefined
      ? { revision: decoded.value.revision, overrides }
      : { revision: decoded.value.revision, overrides, nesting },
  );
};

export const applySessionProfileOverrides = (
  baseConfig: ResolvedSubagentConfig,
  overrides: SessionProfileOverrides,
  nesting?: SubagentNestingPolicy,
): ResolvedSubagentConfig => {
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  const profiles = {} as Record<ProfileId, ProfileRoute>;
  const profileSources = { ...baseConfig.profileSources };
  for (const profile of PROFILE_IDS) {
    const route = overrides[profile];
    profiles[profile] = cloneProfileRoute(route ?? baseConfig.profiles[profile]);
    if (route) profileSources[profile] = "session";
  }
  return freezeSnapshot({
    ...baseConfig,
    profiles,
    profileSources,
    nesting: nesting ? { ...nesting } : baseConfig.nesting,
    nestingSource: nesting ? "session" : baseConfig.nestingSource,
  });
};

export const makeSessionProfileSnapshot = (
  baseConfig: ResolvedSubagentConfig,
  seed: SessionProfileOverrideSeed = emptySessionProfileOverrideSeed(),
): SessionProfileSnapshot => {
  const cloned = cloneSessionProfileOverrideSeed(seed);
  const base = {
    revision: cloned.revision,
    overrides: cloned.overrides,
    baseConfig,
    effectiveConfig: applySessionProfileOverrides(baseConfig, cloned.overrides, cloned.nesting),
  };
  return freezeSnapshot(cloned.nesting ? { ...base, nesting: cloned.nesting } : base);
};

export const sessionProfileSeed = (snapshot: SessionProfileSnapshot): SessionProfileOverrideSeed =>
  freezeSnapshot(
    snapshot.nesting === undefined
      ? { revision: snapshot.revision, overrides: snapshot.overrides }
      : { revision: snapshot.revision, overrides: snapshot.overrides, nesting: snapshot.nesting },
  );

export const patchSessionProfileSnapshot = (
  snapshot: SessionProfileSnapshot,
  patch: SessionProfilePatch,
): Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError> => {
  if (patch.expectedRevision !== snapshot.revision)
    return Effect.fail(
      new SessionProfileConflictError({
        expectedRevision: patch.expectedRevision,
        actualRevision: snapshot.revision,
        message:
          "Session profile settings changed while this page was open; refresh the profile workspace and try again.",
      }),
    );
  const current = snapshot.overrides[patch.profile];
  if (patch.route === undefined && current === undefined) return Effect.succeed(snapshot);
  if (patch.route !== undefined && current !== undefined && sameProfileRoute(current, patch.route))
    return Effect.succeed(snapshot);
  const overrides = { ...snapshot.overrides } satisfies Partial<Record<ProfileId, ProfileRoute>>;
  if (patch.route === undefined) delete overrides[patch.profile];
  else overrides[patch.profile] = cloneProfileRoute(patch.route);
  const nextSeed: SessionProfileOverrideSeed = snapshot.nesting
    ? { revision: snapshot.revision + 1, overrides, nesting: snapshot.nesting }
    : { revision: snapshot.revision + 1, overrides };
  return Effect.succeed(makeSessionProfileSnapshot(snapshot.baseConfig, nextSeed));
};

export const patchSessionNestingSnapshot = (
  snapshot: SessionProfileSnapshot,
  patch: SessionNestingPatch,
): Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError> => {
  if (patch.expectedRevision !== snapshot.revision)
    return Effect.fail(
      new SessionProfileConflictError({
        expectedRevision: patch.expectedRevision,
        actualRevision: snapshot.revision,
        message:
          "Session subagent settings changed while this page was open; refresh and try again.",
      }),
    );
  const same =
    snapshot.nesting?.maxDirectChildren === patch.nesting?.maxDirectChildren &&
    snapshot.nesting?.maxDepth === patch.nesting?.maxDepth;
  if (same) return Effect.succeed(snapshot);
  const nextSeed: SessionProfileOverrideSeed = patch.nesting
    ? {
        revision: snapshot.revision + 1,
        overrides: snapshot.overrides,
        nesting: patch.nesting,
      }
    : { revision: snapshot.revision + 1, overrides: snapshot.overrides };
  return Effect.succeed(makeSessionProfileSnapshot(snapshot.baseConfig, nextSeed));
};

export const clearSessionProfileSnapshot = (
  snapshot: SessionProfileSnapshot,
  expectedRevision: number,
): Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError> => {
  if (expectedRevision !== snapshot.revision)
    return Effect.fail(
      new SessionProfileConflictError({
        expectedRevision,
        actualRevision: snapshot.revision,
        message:
          "Session profile settings changed while this page was open; refresh the profile workspace and try again.",
      }),
    );
  if (Object.keys(snapshot.overrides).length === 0) return Effect.succeed(snapshot);
  const nextSeed: SessionProfileOverrideSeed = snapshot.nesting
    ? { revision: snapshot.revision + 1, overrides: {}, nesting: snapshot.nesting }
    : { revision: snapshot.revision + 1, overrides: {} };
  return Effect.succeed(makeSessionProfileSnapshot(snapshot.baseConfig, nextSeed));
};
