import * as Effect from "effect/Effect";
import { flow } from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, freezeSnapshot, invokeHostCallback } from "pi-cosmic-core";
import type { ResolvedProfileSetSelection, ResolvedSubagentConfig } from "../config/options.ts";
import {
  ownDataProperty,
  ownTypedProperty,
  probeFields,
  type ProbedFields,
} from "../config/probe.ts";
import {
  decodeProfileRoute,
  decodeSubagentNesting,
  isProfileSetName,
  SubagentNestingSchema,
  type SubagentNestingPolicy,
} from "../config/schema.ts";
import { BUILTIN_PROFILE_ROUTES } from "./definitions.ts";
import {
  cloneProfileRoute,
  completeProfileRecord,
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

const SessionProfileOverrideSeedInputSchema = Schema.Struct({
  revision: Schema.Finite.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(MAX_SESSION_PROFILE_REVISION),
  ),
  overrides: Schema.Unknown,
  nesting: Schema.optional(SubagentNestingSchema),
  // Discard the previous runtime's preference until version-2 reload envelopes retire.
  features: Schema.optional(Schema.Struct({ ultracode: Schema.Boolean })),
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

const decodeRouteRecord = (
  holder: ProbedFields,
  key: string,
): Partial<Record<ProfileId, ProfileRoute>> | undefined => {
  const field = ownDataProperty(holder, key);
  const record = field.valid && field.present ? probeFields(field.value) : undefined;
  if (
    !record ||
    !Reflect.ownKeys(record).every((profile) => Predicate.isString(profile) && isProfileId(profile))
  )
    return undefined;
  const routes: Partial<Record<ProfileId, ProfileRoute>> = {};
  for (const profile of PROFILE_IDS) {
    const routeField = ownDataProperty(record, profile);
    if (!routeField.valid) return undefined;
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
    ...(seed.baseline !== undefined && { baseline: cloneBaseline(seed.baseline) }),
  });
};

const decodeSeedInput = decodeUnknownOrUndefined(SessionProfileOverrideSeedInputSchema, {
  onExcessProperty: "error",
});

const decodeBaselineRoutes = (value: ProbedFields) => {
  const baselineField = ownDataProperty(value, "baseline");
  if (!baselineField.valid) return { valid: false };
  if (!baselineField.present) return { valid: true };
  const baselineFields = probeFields(baselineField.value);
  const baselineRecord = baselineFields && decodeRouteRecord(baselineFields, "profiles");
  const routes = baselineRecord && completeProfileRecord(baselineRecord);
  return routes ? { valid: true, routes } : { valid: false };
};

const seedFromFields = (value: ProbedFields): SessionProfileOverrideSeed | undefined =>
  invokeHostCallback(() => {
    const overrides = decodeRouteRecord(value, "overrides");
    const baselineRoutes = decodeBaselineRoutes(value);
    if (!overrides || !baselineRoutes.valid) return undefined;
    const decoded = decodeSeedInput(value);
    const baseline = decoded?.baseline &&
      baselineRoutes.routes && { ...decoded.baseline, profiles: baselineRoutes.routes };
    if (
      !decoded ||
      (baseline && !(isValidOrigin(baseline.origin) && isDetachedBaselineProvenanceValid(baseline)))
    )
      return undefined;
    return cloneSessionProfileOverrideSeed({ ...decoded, overrides, baseline });
  }, undefined);

export const decodeSessionProfileOverrideSeed = flow(
  probeFields,
  (value) => value && seedFromFields(value),
);

export const makeSessionProfileSnapshot = (
  baseConfig: ResolvedSubagentConfig,
  seed: SessionProfileOverrideSeed = emptySessionProfileOverrideSeed(),
): SessionProfileSnapshot => {
  const {
    revision,
    overrides,
    nesting,
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
      nesting: nesting ?? baseConfig.nesting,
    },
    ...(nesting && { nesting }),
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
): Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError> => {
  if (expectedRevision !== snapshot.revision)
    return conflict(snapshot, expectedRevision, staleMessage);
  const changes = edit();
  if (Predicate.isString(changes)) return conflict(snapshot, expectedRevision, changes);
  if (changes === undefined) return Effect.succeed(snapshot);
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
    const routeProperty = ownTypedProperty(patch, "route");
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
