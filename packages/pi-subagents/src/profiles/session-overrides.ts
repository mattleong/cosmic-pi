import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { freezeSnapshot } from "pi-cosmic-core";
import type { ResolvedSubagentConfig } from "../config/options.ts";
import { decodeProfileCandidate, MAX_PROFILE_CANDIDATES } from "../config/schema.ts";
import { PROFILE_IDS, type ProfileCandidate, type ProfileId, type ProfileRoute } from "./model.ts";

export type SessionProfileOverrides = Partial<Readonly<Record<ProfileId, ProfileRoute>>>;

export interface SessionProfileOverrideSeed {
  readonly revision: number;
  readonly overrides: SessionProfileOverrides;
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
});
const exactDecodeOptions = { onExcessProperty: "error" as const };

const cloneRoute = (route: ProfileRoute): ProfileRoute => ({
  candidates: route.candidates.map((candidate) => ({ ...candidate })),
});

const sameRoute = (left: ProfileRoute, right: ProfileRoute): boolean =>
  left.candidates.length === right.candidates.length &&
  left.candidates.every((candidate, index) => {
    const other = right.candidates[index];
    return (
      other !== undefined &&
      candidate.host === other.host &&
      candidate.runtime === other.runtime &&
      candidate.model === other.model &&
      candidate.effort === other.effort &&
      candidate.context === other.context &&
      candidate.writeIntent === other.writeIntent &&
      candidate.fastMode === other.fastMode &&
      candidate.closeOnReport === other.closeOnReport
    );
  });

export const emptySessionProfileOverrideSeed = (): SessionProfileOverrideSeed =>
  freezeSnapshot({ revision: 0, overrides: {} });

export const cloneSessionProfileOverrideSeed = (
  seed: SessionProfileOverrideSeed,
): SessionProfileOverrideSeed => {
  const overrides: Partial<Record<ProfileId, ProfileRoute>> = {};
  for (const profile of PROFILE_IDS) {
    const route = seed.overrides[profile];
    if (route) overrides[profile] = cloneRoute(route);
  }
  return freezeSnapshot({ revision: Math.max(0, Math.floor(seed.revision)), overrides });
};

/** Strict unknown-boundary decoder for process-memory reload handoffs. */
export const decodeSessionProfileOverrideSeed = <ValueInput>(
  value: ValueInput,
): SessionProfileOverrideSeed | undefined => {
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
  return cloneSessionProfileOverrideSeed({ revision: decoded.value.revision, overrides });
};

export const applySessionProfileOverrides = (
  baseConfig: ResolvedSubagentConfig,
  overrides: SessionProfileOverrides,
): ResolvedSubagentConfig => {
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  const profiles = {} as Record<ProfileId, ProfileRoute>;
  const profileSources = { ...baseConfig.profileSources };
  for (const profile of PROFILE_IDS) {
    const route = overrides[profile];
    profiles[profile] = cloneRoute(route ?? baseConfig.profiles[profile]);
    if (route) profileSources[profile] = "session";
  }
  return freezeSnapshot({ ...baseConfig, profiles, profileSources });
};

export const makeSessionProfileSnapshot = (
  baseConfig: ResolvedSubagentConfig,
  seed: SessionProfileOverrideSeed = emptySessionProfileOverrideSeed(),
): SessionProfileSnapshot => {
  const cloned = cloneSessionProfileOverrideSeed(seed);
  return freezeSnapshot({
    revision: cloned.revision,
    overrides: cloned.overrides,
    baseConfig,
    effectiveConfig: applySessionProfileOverrides(baseConfig, cloned.overrides),
  });
};

export const sessionProfileSeed = (snapshot: SessionProfileSnapshot): SessionProfileOverrideSeed =>
  freezeSnapshot({ revision: snapshot.revision, overrides: snapshot.overrides });

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
  if (patch.route !== undefined && current !== undefined && sameRoute(current, patch.route))
    return Effect.succeed(snapshot);
  const overrides = { ...snapshot.overrides } satisfies Partial<Record<ProfileId, ProfileRoute>>;
  if (patch.route === undefined) delete overrides[patch.profile];
  else overrides[patch.profile] = cloneRoute(patch.route);
  return Effect.succeed(
    makeSessionProfileSnapshot(snapshot.baseConfig, {
      revision: snapshot.revision + 1,
      overrides,
    }),
  );
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
  return Effect.succeed(
    makeSessionProfileSnapshot(snapshot.baseConfig, {
      revision: snapshot.revision + 1,
      overrides: {},
    }),
  );
};
