import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, freezeSnapshot, invokeHostCallback } from "pi-cosmic-core";
import type { ResolvedProfileSetSelection, ResolvedSubagentConfig } from "../config/options.ts";
import {
  decodeProfileRoute,
  decodeSubagentNesting,
  isProfileSetName,
  ownDataProperty,
  SUBAGENT_FEATURE_TOGGLES,
  SubagentNestingSchema,
  type SubagentFeatureToggle,
  type SubagentNestingPolicy,
} from "../config/schema.ts";
import { BUILTIN_PROFILE_ROUTES } from "./definitions.ts";
import {
  cloneProfileRoute,
  isProfileId,
  mapProfileIds,
  PROFILE_IDS,
  PROFILE_ROUTE_SOURCES,
  sameProfileRoute,
  type ProfileId,
  type ProfileRoute,
  type ProfileRouteSource,
} from "./model.ts";

export type SessionProfileOverrides = Partial<Readonly<Record<ProfileId, ProfileRoute>>>;
/** Feature switches this session sets itself, over the persistent configuration. */
export type SessionFeatureOverrides = Partial<
  Readonly<Record<SubagentFeatureToggle, boolean | undefined>>
>;

/** Revisions remain exact integers; a state at this value is immutable except for no-op requests. */
export const MAX_SESSION_PROFILE_REVISION = Number.MAX_SAFE_INTEGER;

export interface SessionProfileBaseline {
  readonly origin: ResolvedProfileSetSelection;
  readonly profiles: Readonly<Record<ProfileId, ProfileRoute>>;
  readonly profileSources: Readonly<Record<ProfileId, ProfileRouteSource>>;
}

export interface SessionProfileOverrideSeed {
  readonly revision: number;
  readonly overrides: SessionProfileOverrides;
  readonly nesting?: SubagentNestingPolicy | undefined;
  readonly features?: SessionFeatureOverrides | undefined;
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

export interface SessionFeaturePatch {
  readonly toggle: SubagentFeatureToggle;
  /** Undefined clears the session value and reveals persistent configuration. */
  readonly enabled?: boolean | undefined;
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

/** Route records stay `Unknown` here: they are decoded descriptor-safely, never by Schema. */
const SessionProfileOverrideSeedInputSchema = Schema.Struct({
  revision: Schema.Finite.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(MAX_SESSION_PROFILE_REVISION),
  ),
  overrides: Schema.Unknown,
  nesting: Schema.optional(SubagentNestingSchema),
  features: Schema.optional(
    Schema.Record(Schema.Literals(SUBAGENT_FEATURE_TOGGLES), Schema.optional(Schema.Boolean)),
  ),
  baseline: Schema.optional(
    Schema.Struct({
      origin: Schema.Union([
        Schema.Struct({ scope: Schema.Literal("builtin") }),
        Schema.Struct({
          scope: Schema.Literals(["global", "project"]),
          name: Schema.optional(Schema.String),
          invalid: Schema.optional(Schema.Boolean),
        }),
      ]),
      profiles: Schema.Unknown,
      profileSources: Schema.Record(
        Schema.Literals(PROFILE_IDS),
        Schema.Literals(PROFILE_ROUTE_SOURCES),
      ),
    }),
  ),
});

/**
 * Snapshots the profile-keyed route record held in the own data property `key` without invoking
 * accessors or iterators; `complete` requires a route for every profile. Each candidate array is
 * bounded before any element is read.
 */
const decodeRouteRecord = <ValueInput>(
  value: ValueInput,
  key: string,
  complete: boolean,
): Partial<Record<ProfileId, ProfileRoute>> | undefined => {
  const field = ownDataProperty(value, key);
  const record = field.valid && field.present ? field.value : undefined;
  if (
    !Predicate.isObject(record) ||
    !Reflect.ownKeys(record).every((profile) => Predicate.isString(profile) && isProfileId(profile))
  )
    return undefined;
  const routes: Partial<Record<ProfileId, ProfileRoute>> = {};
  for (const profile of PROFILE_IDS) {
    const routeField = ownDataProperty(record, profile);
    if (!routeField.valid || (complete && !routeField.present)) return undefined;
    if (!routeField.present) continue;
    const route = decodeProfileRoute(routeField.value);
    if (!route) return undefined;
    routes[profile] = route;
  }
  return routes;
};

const cloneOrigin = (origin: ResolvedProfileSetSelection): ResolvedProfileSetSelection => {
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

/** A named origin needs a valid set name; an unnamed one survives only as an invalid default. */
const isValidOrigin = (origin: ResolvedProfileSetSelection): boolean =>
  origin.scope === "builtin" ||
  (origin.name === undefined ? origin.invalid === true : isProfileSetName(origin.name));

/** Route sources a detached baseline may carry per valid origin scope; "session" is never one. */
const DETACHED_BASELINE_SOURCES = {
  builtin: ["builtin"],
  global: ["builtin", "global", "global-invalid"],
  project: ["builtin", "global", "project", "global-invalid", "project-invalid"],
} satisfies Readonly<
  Record<ResolvedProfileSetSelection["scope"], ReadonlyArray<ProfileRouteSource>>
>;

const isDetachedBaselineProvenanceValid = (baseline: SessionProfileBaseline): boolean => {
  const { origin } = baseline;
  const allowed: ReadonlyArray<ProfileRouteSource> =
    origin.scope !== "builtin" && origin.invalid === true
      ? [origin.scope === "global" ? "global-invalid" : "project-invalid"]
      : DETACHED_BASELINE_SOURCES[origin.scope];
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

/** The switches a session sets, or undefined when it sets none. */
const cloneFeatures = (
  features: SessionFeatureOverrides | undefined,
): SessionFeatureOverrides | undefined => {
  const cloned: Partial<Record<SubagentFeatureToggle, boolean>> = {};
  for (const toggle of SUBAGENT_FEATURE_TOGGLES) {
    const value = features?.[toggle];
    if (value !== undefined) cloned[toggle] = value;
  }
  return Object.keys(cloned).length > 0 ? cloned : undefined;
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
  const features = cloneFeatures(seed.features);
  return freezeSnapshot({
    revision,
    overrides,
    ...(seed.nesting !== undefined && { nesting: { ...seed.nesting } }),
    ...(features !== undefined && { features }),
    ...(seed.baseline !== undefined && { baseline: cloneBaseline(seed.baseline) }),
  });
};

/** Strict unknown-boundary decoder for process-memory tree and reload handoffs. */
export const decodeSessionProfileOverrideSeed = <ValueInput>(
  value: ValueInput,
): SessionProfileOverrideSeed | undefined =>
  invokeHostCallback(() => {
    const overrides = decodeRouteRecord(value, "overrides", false);
    const baselineField = ownDataProperty(value, "baseline");
    const baselineRoutes =
      baselineField.valid && baselineField.present
        ? decodeRouteRecord(baselineField.value, "profiles", true)
        : undefined;
    if (!overrides || !baselineField.valid || (baselineField.present && !baselineRoutes))
      return undefined;
    const decoded = decodeUnknownOrUndefined(SessionProfileOverrideSeedInputSchema, value, {
      onExcessProperty: "error",
    });
    const baseline = decoded?.baseline && {
      ...decoded.baseline,
      // SAFETY: A complete route record holds a decoded route for every fixed profile ID.
      profiles: baselineRoutes as Record<ProfileId, ProfileRoute>,
    };
    if (
      !decoded ||
      (baseline && !(isValidOrigin(baseline.origin) && isDetachedBaselineProvenanceValid(baseline)))
    )
      return undefined;
    return cloneSessionProfileOverrideSeed({ ...decoded, overrides, baseline });
  }, undefined);

export const makeSessionProfileSnapshot = (
  baseConfig: ResolvedSubagentConfig,
  seed: SessionProfileOverrideSeed = emptySessionProfileOverrideSeed(),
): SessionProfileSnapshot => {
  const {
    revision,
    overrides,
    nesting,
    features,
    baseline = baselineFromConfig(baseConfig),
  } = cloneSessionProfileOverrideSeed(seed);
  return freezeSnapshot({
    revision,
    overrides,
    baseline,
    baseConfig,
    effectiveConfig: {
      ...baseConfig,
      ultracode: features?.ultracode ?? baseConfig.ultracode,
      featureSources: {
        ultracode:
          features?.ultracode === undefined ? baseConfig.featureSources.ultracode : "session",
      },
      currentProfileSet: baseline.origin,
      profiles: mapProfileIds((id) => overrides[id] ?? baseline.profiles[id]),
      profileSources: mapProfileIds((id) =>
        overrides[id] ? "session" : baseline.profileSources[id],
      ),
      nesting: nesting ?? baseConfig.nesting,
    },
    ...(features && { features }),
    ...(nesting && { nesting }),
  });
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

const STALE_PROFILES =
  "Session profile settings changed while this page was open; refresh the profile workspace and try again.";
const STALE_SETTINGS =
  "Session subagent settings changed while this page was open; refresh and try again.";

/**
 * One revision-checked Current Session edit. After the stale check, `edit` returns the changed
 * seed fields, undefined for a no-op that keeps the snapshot, or a rejection message.
 */
const editSnapshot = (
  snapshot: SessionProfileSnapshot,
  expectedRevision: number,
  staleMessage: string,
  edit: () => Partial<SessionProfileOverrideSeed> | string | undefined,
): Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError> => {
  if (expectedRevision !== snapshot.revision)
    return conflict(snapshot, expectedRevision, staleMessage);
  const changes = edit();
  if (Predicate.isString(changes)) return conflict(snapshot, expectedRevision, changes);
  if (changes === undefined) return Effect.succeed(snapshot);
  // Snapshot revisions are always clamped exact integers.
  if (snapshot.revision >= MAX_SESSION_PROFILE_REVISION)
    return conflict(
      snapshot,
      snapshot.revision,
      `Session profile revision reached the exact-integer limit ${MAX_SESSION_PROFILE_REVISION}; restart the Pi session before making another change.`,
    );
  return Effect.succeed(
    makeSessionProfileSnapshot(snapshot.baseConfig, {
      ...snapshot,
      ...changes,
      revision: snapshot.revision + 1,
    }),
  );
};

export const patchSessionProfileSnapshot = (
  snapshot: SessionProfileSnapshot,
  patch: SessionProfilePatch,
): Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError> =>
  editSnapshot(snapshot, patch.expectedRevision, STALE_PROFILES, () => {
    const routeProperty = ownDataProperty(patch, "route");
    const declared = routeProperty.valid && routeProperty.present ? routeProperty.value : undefined;
    const route = declared === undefined ? undefined : decodeProfileRoute(declared);
    if (!isProfileId(patch.profile) || !routeProperty.valid || (declared !== undefined && !route))
      return "The profile route is invalid and was not applied.";
    const current = snapshot.overrides[patch.profile];
    if (route === undefined ? current === undefined : current && sameProfileRoute(current, route))
      return undefined;
    const overrides = { ...snapshot.overrides };
    if (route === undefined) delete overrides[patch.profile];
    else overrides[patch.profile] = route;
    return { overrides };
  });

const sameOrigin = (left: ResolvedProfileSetSelection, right: ResolvedProfileSetSelection) =>
  left.scope === right.scope &&
  (left.scope === "builtin" ||
    right.scope === "builtin" ||
    (left.name === right.name && (left.invalid ?? false) === (right.invalid ?? false)));

export const replaceSessionProfileSnapshot = (
  snapshot: SessionProfileSnapshot,
  patch: SessionProfileSetPatch,
): Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError> =>
  editSnapshot(snapshot, patch.expectedRevision, STALE_PROFILES, () => {
    const baseline = invokeHostCallback(
      () =>
        decodeSessionProfileOverrideSeed({
          revision: 0,
          overrides: {},
          baseline: {
            origin: patch.origin,
            profiles: patch.profiles,
            profileSources: patch.profileSources,
          },
        })?.baseline,
      undefined,
    );
    if (!baseline)
      return "The replacement profile baseline has invalid routes or provenance and was not applied.";
    const unchanged =
      Object.keys(snapshot.overrides).length === 0 &&
      sameOrigin(snapshot.baseline.origin, baseline.origin) &&
      PROFILE_IDS.every(
        (profile) =>
          snapshot.baseline.profileSources[profile] === baseline.profileSources[profile] &&
          sameProfileRoute(snapshot.baseline.profiles[profile], baseline.profiles[profile]),
      );
    return unchanged ? undefined : { overrides: {}, baseline };
  });

export const patchSessionNestingSnapshot = (
  snapshot: SessionProfileSnapshot,
  patch: SessionNestingPatch,
): Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError> =>
  editSnapshot(snapshot, patch.expectedRevision, STALE_SETTINGS, () => {
    const nesting = patch.nesting === undefined ? undefined : decodeSubagentNesting(patch.nesting);
    if (patch.nesting !== undefined && !nesting)
      return "The nesting policy is invalid and was not applied.";
    return snapshot.nesting?.maxDirectChildren === nesting?.maxDirectChildren &&
      snapshot.nesting?.maxDepth === nesting?.maxDepth
      ? undefined
      : { nesting };
  });

export const patchSessionFeatureSnapshot = (
  snapshot: SessionProfileSnapshot,
  patch: SessionFeaturePatch,
): Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError> =>
  editSnapshot(snapshot, patch.expectedRevision, STALE_SETTINGS, () =>
    snapshot.features?.[patch.toggle] === patch.enabled
      ? undefined
      : { features: { ...snapshot.features, [patch.toggle]: patch.enabled } },
  );
