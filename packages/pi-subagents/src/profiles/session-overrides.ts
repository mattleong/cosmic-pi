import * as Effect from "effect/Effect";
import { flow } from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, freezeSnapshot } from "pi-cosmic-core";
import type { ResolvedProfileSetSelection, ResolvedSubagentConfig } from "../config/options.ts";
import {
  decodeProfileRoute,
  decodeSubagentNestingOverrides,
  DelegationModeSchema,
  isProfileSetName,
  mergeSubagentNesting,
  ProfileRouteSchema,
  SubagentNestingOverridesSchema,
  type DelegationMode,
  type SubagentNestingOverrides,
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

type SessionProfileOverrides = Partial<Readonly<Record<ProfileId, ProfileRoute>>>;
const MAX_SESSION_PROFILE_REVISION = Number.MAX_SAFE_INTEGER;

export interface SessionProfileBaseline {
  readonly origin: ResolvedProfileSetSelection;
  readonly profiles: Readonly<Record<ProfileId, ProfileRoute>>;
  readonly profileSources: Readonly<Record<ProfileId, ProfileRouteSource>>;
}

export interface SessionProfileOverrideSeed {
  readonly revision: number;
  readonly overrides: SessionProfileOverrides;
  /** Merged field by field over the activation-time policy. */
  readonly nesting?: SubagentNestingOverrides | undefined;
  readonly delegation?: DelegationMode | undefined;
  readonly baseline?: SessionProfileBaseline | undefined;
}

export interface SessionProfileSnapshot extends SessionProfileOverrideSeed {
  readonly baseline: SessionProfileBaseline;
  readonly baseConfig: ResolvedSubagentConfig;
  readonly effectiveConfig: ResolvedSubagentConfig;
}

export interface SessionProfilePatch {
  readonly profile: ProfileId;
  readonly route?: ProfileRoute | undefined;
  readonly expectedRevision: number;
}

export interface SessionProfileSetPatch extends SessionProfileBaseline {
  readonly expectedRevision: number;
}

export interface SessionNestingPatch {
  readonly nesting?: SubagentNestingOverrides | undefined;
  readonly expectedRevision: number;
}

export interface SessionDelegationPatch {
  readonly delegation?: DelegationMode | undefined;
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

/** The edit itself cannot be applied; refreshing and retrying the same edit won't help. */
export class SessionProfileInvalidError extends Schema.TaggedError<SessionProfileInvalidError>()(
  "SessionProfileInvalidError",
  { message: Schema.String },
) {}

export type SessionProfileEditError = SessionProfileConflictError | SessionProfileInvalidError;

const SessionProfileOverrideSeedInputSchema = Schema.Struct({
  revision: Schema.Finite.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(MAX_SESSION_PROFILE_REVISION),
  ),
  overrides: Schema.Struct(mapProfileIds(() => Schema.optionalKey(ProfileRouteSchema))),
  nesting: Schema.optional(SubagentNestingOverridesSchema),
  delegation: Schema.optional(DelegationModeSchema),
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
      profiles: Schema.Struct(mapProfileIds(() => ProfileRouteSchema)),
      profileSources: Schema.Record(
        Schema.Literals(PROFILE_IDS),
        Schema.Literals(PROFILE_ROUTE_SOURCES),
      ),
    }),
  ),
});

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

const isValidOrigin = (origin: ResolvedProfileSetSelection): boolean =>
  origin.scope === "builtin" ||
  (origin.name === undefined ? origin.invalid === true : isProfileSetName(origin.name));

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
  return freezeSnapshot({
    revision,
    overrides,
    ...(seed.nesting !== undefined && { nesting: { ...seed.nesting } }),
    ...(seed.delegation !== undefined && { delegation: seed.delegation }),
    ...(seed.baseline !== undefined && { baseline: cloneBaseline(seed.baseline) }),
  });
};

const decodeSeedInput = decodeUnknownOrUndefined(SessionProfileOverrideSeedInputSchema, {
  onExcessProperty: "error",
});

export const decodeSessionProfileOverrideSeed = flow(
  decodeSeedInput,
  (decoded): SessionProfileOverrideSeed | undefined => {
    const baseline = decoded?.baseline;
    if (
      !decoded ||
      (baseline && !(isValidOrigin(baseline.origin) && isDetachedBaselineProvenanceValid(baseline)))
    )
      return undefined;
    return cloneSessionProfileOverrideSeed(decoded);
  },
);

export const sessionProfileSnapshot = (
  baseConfig: ResolvedSubagentConfig,
  seed: SessionProfileOverrideSeed = emptySessionProfileOverrideSeed(),
): SessionProfileSnapshot => {
  const {
    revision,
    overrides,
    nesting,
    delegation,
    baseline = baselineFromConfig(baseConfig),
  } = cloneSessionProfileOverrideSeed(seed);
  return freezeSnapshot({
    revision,
    overrides,
    baseline,
    baseConfig,
    effectiveConfig: {
      ...baseConfig,
      currentProfileSet: baseline.origin,
      profiles: mapProfileIds((id) => overrides[id] ?? baseline.profiles[id]),
      profileSources: mapProfileIds((id) =>
        overrides[id] ? "session" : baseline.profileSources[id],
      ),
      nesting: mergeSubagentNesting(baseConfig.nesting, nesting),
      delegation: delegation ?? baseConfig.delegation,
    },
    ...(nesting && { nesting }),
    ...(delegation && { delegation }),
  });
};

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

const editSnapshot = (
  snapshot: SessionProfileSnapshot,
  expectedRevision: number,
  staleMessage: string,
  edit: () => Partial<SessionProfileOverrideSeed> | string | undefined,
): Effect.Effect<SessionProfileSnapshot, SessionProfileEditError> => {
  if (expectedRevision !== snapshot.revision)
    return conflict(snapshot, expectedRevision, staleMessage);
  const changes = edit();
  if (Predicate.isString(changes))
    return Effect.fail(new SessionProfileInvalidError({ message: changes }));
  if (changes === undefined) return Effect.succeed(snapshot);
  if (snapshot.revision >= MAX_SESSION_PROFILE_REVISION)
    return Effect.fail(
      new SessionProfileInvalidError({
        message: `Session profile revision reached the exact-integer limit ${MAX_SESSION_PROFILE_REVISION}; restart the Pi session before making another change.`,
      }),
    );
  return Effect.succeed(
    sessionProfileSnapshot(snapshot.baseConfig, {
      ...snapshot,
      ...changes,
      revision: snapshot.revision + 1,
    }),
  );
};

export const patchSessionProfileSnapshot = (
  snapshot: SessionProfileSnapshot,
  patch: SessionProfilePatch,
): Effect.Effect<SessionProfileSnapshot, SessionProfileEditError> =>
  editSnapshot(snapshot, patch.expectedRevision, STALE_PROFILES, () => {
    const route = patch.route === undefined ? undefined : decodeProfileRoute(patch.route);
    if (!isProfileId(patch.profile) || (patch.route !== undefined && !route))
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
): Effect.Effect<SessionProfileSnapshot, SessionProfileEditError> =>
  editSnapshot(snapshot, patch.expectedRevision, STALE_PROFILES, () => {
    const baseline = decodeSessionProfileOverrideSeed({
      revision: 0,
      overrides: {},
      baseline: {
        origin: patch.origin,
        profiles: patch.profiles,
        profileSources: patch.profileSources,
      },
    })?.baseline;
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
): Effect.Effect<SessionProfileSnapshot, SessionProfileEditError> =>
  editSnapshot(snapshot, patch.expectedRevision, STALE_SETTINGS, () => {
    const decoded =
      patch.nesting === undefined ? undefined : decodeSubagentNestingOverrides(patch.nesting);
    // An override without fields inherits the whole policy.
    const nesting = decoded && Object.keys(decoded).length > 0 ? decoded : undefined;
    if (patch.nesting !== undefined && !decoded)
      return "The nesting policy is invalid and was not applied.";
    return snapshot.nesting?.maxDirectChildren === nesting?.maxDirectChildren &&
      snapshot.nesting?.maxDepth === nesting?.maxDepth &&
      snapshot.nesting?.maxActiveRuns === nesting?.maxActiveRuns
      ? undefined
      : { nesting };
  });

export const patchSessionDelegationSnapshot = (
  snapshot: SessionProfileSnapshot,
  patch: SessionDelegationPatch,
): Effect.Effect<SessionProfileSnapshot, SessionProfileEditError> =>
  editSnapshot(snapshot, patch.expectedRevision, STALE_SETTINGS, () => {
    if (patch.delegation !== undefined && !Schema.is(DelegationModeSchema)(patch.delegation))
      return "The delegation mode is invalid and was not applied.";
    return snapshot.delegation === patch.delegation ? undefined : { delegation: patch.delegation };
  });
