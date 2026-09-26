import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { freezeSnapshot } from "pi-cosmic-core";
import type { ResolvedProfileSetSelection, ResolvedSubagentConfig } from "../config/options.ts";
import {
  decodeProfileCandidate,
  decodeSubagentNesting,
  isProfileSetName,
  ownDataProperty,
  type SubagentNestingPolicy,
} from "../config/schema.ts";
import { BUILTIN_PROFILE_ROUTES } from "./definitions.ts";
import {
  cloneProfileRoute,
  mapProfileIds,
  MAX_PROFILE_CANDIDATES,
  PROFILE_IDS,
  PROFILE_ROUTE_SOURCES,
  sameProfileRoute,
  type ProfileCandidate,
  type ProfileId,
  type ProfileRoute,
  type ProfileRouteSource,
} from "./model.ts";

export type SessionProfileOverrides = Partial<Readonly<Record<ProfileId, ProfileRoute>>>;

/** Revisions remain exact integers; a state at this value is immutable except for no-op requests. */
export const MAX_SESSION_PROFILE_REVISION = Number.MAX_SAFE_INTEGER;

export type SessionProfileOrigin = ResolvedProfileSetSelection;

export interface SessionProfileBaseline {
  readonly origin: SessionProfileOrigin;
  readonly profiles: Readonly<Record<ProfileId, ProfileRoute>>;
  readonly profileSources: Readonly<Record<ProfileId, ProfileRouteSource>>;
}

export interface SessionProfileOverrideSeed {
  readonly revision: number;
  readonly overrides: SessionProfileOverrides;
  readonly nesting?: SubagentNestingPolicy | undefined;
  /** Optional only for decoding handoffs published before complete baselines were introduced. */
  readonly baseline?: SessionProfileBaseline | undefined;
}

export interface SessionProfileSnapshot extends SessionProfileOverrideSeed {
  readonly baseline: SessionProfileBaseline;
  readonly baseConfig: ResolvedSubagentConfig;
  readonly effectiveConfig: ResolvedSubagentConfig;
}

export interface SessionProfilePatch {
  readonly profile: ProfileId;
  /** Undefined clears the temporary declaration and reveals the frozen session baseline route. */
  readonly route?: ProfileRoute | undefined;
  readonly expectedRevision: number;
}

export interface SessionProfileSetPatch extends SessionProfileBaseline {
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

const SessionRouteInputSchema = Schema.Struct({
  candidates: Schema.Array(Schema.Unknown),
});
const SessionOverridesInputSchema = Schema.Record(
  Schema.Literals(PROFILE_IDS),
  Schema.optional(SessionRouteInputSchema),
);
const SessionBaselineProfilesInputSchema = Schema.Record(
  Schema.Literals(PROFILE_IDS),
  SessionRouteInputSchema,
);
const SessionBaselineSourcesInputSchema = Schema.Record(
  Schema.Literals(PROFILE_IDS),
  Schema.Literals(PROFILE_ROUTE_SOURCES),
);
const SessionProfileOriginInputSchema = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("builtin") }),
  Schema.Struct({
    scope: Schema.Literals(["global", "project"]),
    name: Schema.optional(Schema.String),
    invalid: Schema.optional(Schema.Boolean),
  }),
]);
const SessionProfileBaselineInputSchema = Schema.Struct({
  origin: SessionProfileOriginInputSchema,
  profiles: SessionBaselineProfilesInputSchema,
  profileSources: SessionBaselineSourcesInputSchema,
});
const SessionProfileOverrideSeedInputSchema = Schema.Struct({
  revision: Schema.Finite.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(MAX_SESSION_PROFILE_REVISION),
  ),
  overrides: SessionOverridesInputSchema,
  nesting: Schema.optional(Schema.Unknown),
  baseline: Schema.optional(SessionProfileBaselineInputSchema),
});
const decodeSeedInput = Schema.decodeUnknownOption(SessionProfileOverrideSeedInputSchema, {
  onExcessProperty: "error",
});

const preflightRouteCandidateLengths = <ValueInput>(
  routesValue: ValueInput,
  requireEveryProfile: boolean,
): boolean => {
  for (const profile of PROFILE_IDS) {
    const route = ownDataProperty(routesValue, profile);
    if (!route.valid || (requireEveryProfile && !route.present)) return false;
    if (!route.present) continue;
    const candidates = ownDataProperty(route.value, "candidates");
    if (!candidates.valid || !candidates.present) return false;
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

/** Rejects known oversized candidate arrays before Schema can traverse any candidate element. */
const preflightSessionCandidateLengths = <ValueInput>(value: ValueInput): boolean => {
  const overrides = ownDataProperty(value, "overrides");
  if (!overrides.valid) return false;
  if (overrides.present && !preflightRouteCandidateLengths(overrides.value, false)) return false;
  const baseline = ownDataProperty(value, "baseline");
  if (!baseline.valid) return false;
  if (!baseline.present) return true;
  const profiles = ownDataProperty(baseline.value, "profiles");
  return profiles.valid && profiles.present
    ? preflightRouteCandidateLengths(profiles.value, true)
    : false;
};

const cloneOrigin = (origin: SessionProfileOrigin): SessionProfileOrigin => {
  if (origin.scope === "builtin") return { scope: "builtin" };
  return {
    scope: origin.scope,
    ...(origin.name !== undefined && { name: origin.name }),
    ...(origin.invalid === true && { invalid: true }),
  };
};

const cloneBaseline = (baseline: SessionProfileBaseline): SessionProfileBaseline =>
  freezeSnapshot({
    origin: cloneOrigin(baseline.origin),
    profiles: mapProfileIds((profile) => cloneProfileRoute(baseline.profiles[profile])),
    profileSources: mapProfileIds((profile) => baseline.profileSources[profile]),
  });

const baselineFromConfig = (config: ResolvedSubagentConfig): SessionProfileBaseline =>
  cloneBaseline({
    origin: config.currentProfileSet,
    profiles: config.profiles,
    profileSources: config.profileSources,
  });

const decodeRoute = (route: {
  readonly candidates: ReadonlyArray<unknown>;
}): ProfileRoute | undefined => {
  if (route.candidates.length > MAX_PROFILE_CANDIDATES) return undefined;
  const candidates: ProfileCandidate[] = [];
  for (const input of route.candidates) {
    const candidate = decodeProfileCandidate(input);
    if (!candidate) return undefined;
    candidates.push(candidate);
  }
  return { candidates };
};

/** A named origin needs a valid set name; an unnamed one survives only as an invalid default. */
const isValidOrigin = (origin: SessionProfileOrigin): boolean =>
  origin.scope === "builtin" ||
  (origin.name === undefined ? origin.invalid === true : isProfileSetName(origin.name));

/** Route sources a detached baseline may carry per valid origin scope; "session" is never one. */
const DETACHED_BASELINE_SOURCES = {
  builtin: ["builtin"],
  global: ["builtin", "global", "global-invalid"],
  project: ["builtin", "global", "project", "global-invalid", "project-invalid"],
} satisfies Readonly<Record<SessionProfileOrigin["scope"], ReadonlyArray<ProfileRouteSource>>>;

const allowedDetachedSources = (origin: SessionProfileOrigin): ReadonlyArray<ProfileRouteSource> =>
  origin.scope !== "builtin" && origin.invalid === true
    ? [origin.scope === "global" ? "global-invalid" : "project-invalid"]
    : DETACHED_BASELINE_SOURCES[origin.scope];

const isDetachedBaselineProvenanceValid = (baseline: SessionProfileBaseline): boolean => {
  const allowed = allowedDetachedSources(baseline.origin);
  return PROFILE_IDS.every((profile) => {
    const source = baseline.profileSources[profile];
    const route = baseline.profiles[profile];
    if (!allowed.includes(source)) return false;
    if (source === "global-invalid" || source === "project-invalid")
      return route.candidates.length === 0;
    if (source === "builtin") return sameProfileRoute(route, BUILTIN_PROFILE_ROUTES[profile]);
    return true;
  });
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
  const revision = Number.isFinite(seed.revision)
    ? Math.min(MAX_SESSION_PROFILE_REVISION, Math.max(0, Math.floor(seed.revision)))
    : 0;
  const base = {
    revision,
    overrides,
    ...(seed.nesting !== undefined && { nesting: { ...seed.nesting } }),
    ...(seed.baseline !== undefined && { baseline: cloneBaseline(seed.baseline) }),
  };
  return freezeSnapshot(base);
};

/** Strict unknown-boundary decoder for process-memory tree and reload handoffs. */
export const decodeSessionProfileOverrideSeed = <ValueInput>(
  value: ValueInput,
): SessionProfileOverrideSeed | undefined => {
  if (!preflightSessionCandidateLengths(value)) return undefined;
  let decoded: ReturnType<typeof decodeSeedInput>;
  try {
    decoded = decodeSeedInput(value);
  } catch {
    return undefined;
  }
  if (Option.isNone(decoded)) return undefined;
  const overrides: Partial<Record<ProfileId, ProfileRoute>> = {};
  for (const profile of PROFILE_IDS) {
    const route = decoded.value.overrides[profile];
    if (!route) continue;
    const normalized = decodeRoute(route);
    if (!normalized) return undefined;
    overrides[profile] = normalized;
  }
  const nesting =
    decoded.value.nesting === undefined ? undefined : decodeSubagentNesting(decoded.value.nesting);
  if (decoded.value.nesting !== undefined && nesting === undefined) return undefined;
  let baseline: SessionProfileBaseline | undefined;
  if (decoded.value.baseline) {
    const { origin, profileSources } = decoded.value.baseline;
    if (!isValidOrigin(origin)) return undefined;
    // SAFETY: The complete input schema and loop assign every fixed profile ID.
    const profiles = {} as Record<ProfileId, ProfileRoute>;
    for (const profile of PROFILE_IDS) {
      const normalized = decodeRoute(decoded.value.baseline.profiles[profile]);
      if (!normalized) return undefined;
      profiles[profile] = normalized;
    }
    baseline = { origin, profiles, profileSources };
    if (!isDetachedBaselineProvenanceValid(baseline)) return undefined;
  }
  return cloneSessionProfileOverrideSeed({
    revision: decoded.value.revision,
    overrides,
    ...(nesting !== undefined && { nesting }),
    ...(baseline !== undefined && { baseline }),
  });
};

export const applySessionProfileOverrides = (
  baseConfig: ResolvedSubagentConfig,
  overrides: SessionProfileOverrides,
  nesting?: SubagentNestingPolicy,
  baseline: SessionProfileBaseline = baselineFromConfig(baseConfig),
): ResolvedSubagentConfig => {
  return freezeSnapshot({
    ...baseConfig,
    currentProfileSet: baseline.origin,
    profiles: mapProfileIds((id) => cloneProfileRoute(overrides[id] ?? baseline.profiles[id])),
    profileSources: mapProfileIds((id) =>
      overrides[id] ? "session" : baseline.profileSources[id],
    ),
    nesting: nesting ? { ...nesting } : baseConfig.nesting,
  });
};

export const makeSessionProfileSnapshot = (
  baseConfig: ResolvedSubagentConfig,
  seed: SessionProfileOverrideSeed = emptySessionProfileOverrideSeed(),
): SessionProfileSnapshot => {
  const cloned = cloneSessionProfileOverrideSeed(seed);
  const baseline = cloned.baseline ?? baselineFromConfig(baseConfig);
  const base = {
    revision: cloned.revision,
    overrides: cloned.overrides,
    baseline,
    baseConfig,
    effectiveConfig: applySessionProfileOverrides(
      baseConfig,
      cloned.overrides,
      cloned.nesting,
      baseline,
    ),
  };
  return freezeSnapshot(cloned.nesting ? { ...base, nesting: cloned.nesting } : base);
};

/** Every published seed carries the complete detached baseline, even before the first edit. */
export const sessionProfileSeed = (snapshot: SessionProfileSnapshot): SessionProfileOverrideSeed =>
  cloneSessionProfileOverrideSeed(snapshot);

export const conflict = (
  snapshot: SessionProfileSnapshot,
  expectedRevision: number,
  message: string,
): Effect.Effect<never, SessionProfileConflictError> =>
  Effect.fail(
    new SessionProfileConflictError({
      expectedRevision,
      actualRevision: snapshot.revision,
      message,
    }),
  );

const revisionLimit = (
  snapshot: SessionProfileSnapshot,
): Effect.Effect<never, SessionProfileConflictError> =>
  conflict(
    snapshot,
    snapshot.revision,
    `Session profile revision reached the exact-integer limit ${MAX_SESSION_PROFILE_REVISION}; restart the Pi session before making another change.`,
  );

const incrementRevision = (snapshot: SessionProfileSnapshot): number | undefined =>
  Number.isSafeInteger(snapshot.revision) && snapshot.revision < MAX_SESSION_PROFILE_REVISION
    ? snapshot.revision + 1
    : undefined;

export const patchSessionProfileSnapshot = (
  snapshot: SessionProfileSnapshot,
  patch: SessionProfilePatch,
): Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError> => {
  if (patch.expectedRevision !== snapshot.revision)
    return conflict(
      snapshot,
      patch.expectedRevision,
      "Session profile settings changed while this page was open; refresh the profile workspace and try again.",
    );
  const current = snapshot.overrides[patch.profile];
  if (patch.route === undefined && current === undefined) return Effect.succeed(snapshot);
  if (patch.route !== undefined && current !== undefined && sameProfileRoute(current, patch.route))
    return Effect.succeed(snapshot);
  const revision = incrementRevision(snapshot);
  if (revision === undefined) return revisionLimit(snapshot);
  const overrides = { ...snapshot.overrides } satisfies Partial<Record<ProfileId, ProfileRoute>>;
  if (patch.route === undefined) delete overrides[patch.profile];
  else overrides[patch.profile] = cloneProfileRoute(patch.route);
  return Effect.succeed(
    makeSessionProfileSnapshot(snapshot.baseConfig, { ...snapshot, revision, overrides }),
  );
};

const sameSessionProfileBaseline = (
  left: SessionProfileBaseline,
  right: SessionProfileBaseline,
): boolean => {
  if (left.origin.scope !== right.origin.scope) return false;
  if (
    left.origin.scope !== "builtin" &&
    right.origin.scope !== "builtin" &&
    (left.origin.name !== right.origin.name ||
      (left.origin.invalid ?? false) !== (right.origin.invalid ?? false))
  )
    return false;
  return PROFILE_IDS.every(
    (profile) =>
      left.profileSources[profile] === right.profileSources[profile] &&
      sameProfileRoute(left.profiles[profile], right.profiles[profile]),
  );
};

export const replaceSessionProfileSnapshot = (
  snapshot: SessionProfileSnapshot,
  patch: SessionProfileSetPatch,
): Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError> => {
  if (patch.expectedRevision !== snapshot.revision)
    return conflict(
      snapshot,
      patch.expectedRevision,
      "Session profile settings changed while this page was open; refresh the profile workspace and try again.",
    );
  let baseline: SessionProfileBaseline | undefined;
  try {
    baseline = decodeSessionProfileOverrideSeed({
      revision: 0,
      overrides: {},
      baseline: {
        origin: patch.origin,
        profiles: patch.profiles,
        profileSources: patch.profileSources,
      },
    })?.baseline;
  } catch {
    baseline = undefined;
  }
  if (!baseline)
    return conflict(
      snapshot,
      patch.expectedRevision,
      "The replacement profile baseline has invalid routes or provenance and was not applied.",
    );
  if (
    Object.keys(snapshot.overrides).length === 0 &&
    sameSessionProfileBaseline(snapshot.baseline, baseline)
  )
    return Effect.succeed(snapshot);
  const revision = incrementRevision(snapshot);
  if (revision === undefined) return revisionLimit(snapshot);
  return Effect.succeed(
    makeSessionProfileSnapshot(snapshot.baseConfig, {
      ...snapshot,
      revision,
      overrides: {},
      baseline,
    }),
  );
};

export const patchSessionNestingSnapshot = (
  snapshot: SessionProfileSnapshot,
  patch: SessionNestingPatch,
): Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError> => {
  if (patch.expectedRevision !== snapshot.revision)
    return conflict(
      snapshot,
      patch.expectedRevision,
      "Session subagent settings changed while this page was open; refresh and try again.",
    );
  const same =
    snapshot.nesting?.maxDirectChildren === patch.nesting?.maxDirectChildren &&
    snapshot.nesting?.maxDepth === patch.nesting?.maxDepth;
  if (same) return Effect.succeed(snapshot);
  const revision = incrementRevision(snapshot);
  if (revision === undefined) return revisionLimit(snapshot);
  return Effect.succeed(
    makeSessionProfileSnapshot(snapshot.baseConfig, {
      ...snapshot,
      revision,
      nesting: patch.nesting,
    }),
  );
};
