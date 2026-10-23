import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { frozenProjection, type ProjectionError } from "pi-cosmic-core";
import type { ResolvedSubagentConfig } from "../config/options.ts";
import type { WriterWorkspaceMode } from "../config/schema.ts";
import { SubagentConfigStore } from "../config/store.ts";
import type { CustomAgent } from "./agents.ts";
import { PROFILE_DEFINITIONS } from "./definitions.ts";
import { isProfileId, type ProfileDefinition } from "./model.ts";
import {
  resolveProfilePlan,
  type ProfileResolution,
  type ProfileResolutionEnvironment,
} from "./resolve.ts";
import {
  conflict,
  sessionProfileSeed,
  sessionProfileSnapshot,
  patchSessionDelegationSnapshot,
  patchSessionNestingSnapshot,
  patchSessionProfileSnapshot,
  replaceSessionProfileSnapshot,
  type SessionDelegationPatch,
  type SessionProfileConflictError,
  type SessionProfileEditError,
  type SessionNestingPatch,
  type SessionProfileOverrideSeed,
  type SessionProfilePatch,
  type SessionProfileSetPatch,
  type SessionProfileSnapshot,
} from "./session-overrides.ts";

export interface SubagentProfileServiceContract {
  readonly capture: Effect.Effect<SessionProfileSnapshot>;
  readonly definition: (profile: string) => ProfileDefinition | undefined;
  readonly resolve: (
    snapshot: SessionProfileSnapshot,
    profile: string,
    environment: ProfileResolutionEnvironment,
    /** An agent routed to `profile`, whose overrides apply to every candidate. */
    agent?: CustomAgent,
  ) => ProfileResolution;
  readonly withSnapshotAtRevision: <A, E, R>(
    expectedRevision: number,
    operation: (snapshot: SessionProfileSnapshot) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SessionProfileConflictError, R>;
  readonly patchSessionProfile: (
    patch: SessionProfilePatch,
  ) => Effect.Effect<SessionProfileSnapshot, SessionProfileEditError | ProjectionError>;
  readonly replaceSessionProfiles: (
    patch: SessionProfileSetPatch,
  ) => Effect.Effect<SessionProfileSnapshot, SessionProfileEditError | ProjectionError>;
  readonly patchSessionNesting: (
    patch: SessionNestingPatch,
  ) => Effect.Effect<SessionProfileSnapshot, SessionProfileEditError | ProjectionError>;
  readonly patchSessionDelegation: (
    patch: SessionDelegationPatch,
  ) => Effect.Effect<SessionProfileSnapshot, SessionProfileEditError | ProjectionError>;
  /**
   * Records a saved writer workspace default in the session's base configuration, which /tree
   * keeps, without changing Current Session's revision.
   */
  readonly recordWriterWorkspaceMode: (
    mode: WriterWorkspaceMode,
  ) => Effect.Effect<void, ProjectionError>;
}

export class SubagentProfileService extends Context.Service<
  SubagentProfileService,
  SubagentProfileServiceContract
>()("pi-subagents/profiles/service/SubagentProfileService") {}

export interface SubagentProfileLayerOptions {
  readonly cwd: string;
  readonly agentDirectory: string;
  readonly projectTrusted: boolean;
  /** The base configuration a replaced runtime published, which /tree keeps. */
  readonly sessionBaseConfig?: ResolvedSubagentConfig | undefined;
  readonly initialSessionOverrides?: SessionProfileOverrideSeed | undefined;
  /**
   * Receives the initial snapshot and every committed change, including its base configuration.
   * A throw fails that change and leaves the committed snapshot unchanged.
   */
  readonly publishSession?: ((snapshot: SessionProfileSnapshot) => void) | undefined;
}

type SubagentProfileServiceOptions = Pick<
  SubagentProfileLayerOptions,
  "initialSessionOverrides" | "publishSession"
>;

const subagentProfileService = Effect.fn("SubagentProfileService.make")(function* (
  config: ResolvedSubagentConfig,
  options: SubagentProfileServiceOptions,
): Effect.fn.Return<SubagentProfileServiceContract, ProjectionError> {
  // A failed publication leaves the committed snapshot unchanged, so the handoff that /reload
  // and /tree restore from never disagrees with this service.
  const projection = yield* frozenProjection<SessionProfileSnapshot, SessionProfileSnapshot>(
    sessionProfileSnapshot(config, options.initialSessionOverrides),
    Fn.identity,
    (snapshot) => options.publishSession?.(snapshot),
  );
  // Serializes edits with saved-set writes, which read the snapshot without republishing it, so
  // a failed publication cannot report a saved-set write that already committed as failed.
  const lock = yield* Semaphore.make(1);
  const commit = <E>(
    transition: (current: SessionProfileSnapshot) => Effect.Effect<SessionProfileSnapshot, E>,
  ): Effect.Effect<SessionProfileSnapshot, E | ProjectionError> =>
    lock.withPermit(
      projection.transition((current) =>
        transition(current).pipe(Effect.map((next) => [next, next] as const)),
      ),
    );
  return SubagentProfileService.of({
    capture: projection.getState,
    definition: (profile) => (isProfileId(profile) ? PROFILE_DEFINITIONS[profile] : undefined),
    resolve: (snapshot, profile, environment, agent) =>
      resolveProfilePlan(profile, snapshot.effectiveConfig, environment, agent),
    withSnapshotAtRevision: <A, E, R>(
      expectedRevision: number,
      operation: (snapshot: SessionProfileSnapshot) => Effect.Effect<A, E, R>,
    ) =>
      lock.withPermit(
        Effect.flatMap(
          projection.getState,
          (current): Effect.Effect<A, E | SessionProfileConflictError, R> =>
            current.revision === expectedRevision
              ? operation(current)
              : conflict(
                  current,
                  expectedRevision,
                  "Current Session changed while the saved-set write was pending; review it and try again.",
                ),
        ),
      ),
    patchSessionProfile: (patch) =>
      commit((current) => patchSessionProfileSnapshot(current, patch)),
    replaceSessionProfiles: (patch) =>
      commit((current) => replaceSessionProfileSnapshot(current, patch)),
    patchSessionNesting: (patch) =>
      commit((current) => patchSessionNestingSnapshot(current, patch)),
    patchSessionDelegation: (patch) =>
      commit((current) => patchSessionDelegationSnapshot(current, patch)),
    recordWriterWorkspaceMode: (mode) =>
      commit((current) =>
        Effect.succeed(
          sessionProfileSnapshot(
            { ...current.baseConfig, writerWorkspaceMode: mode },
            sessionProfileSeed(current),
          ),
        ),
      ).pipe(Effect.asVoid),
  });
});

export const subagentProfileServiceLayer = (options: SubagentProfileLayerOptions) =>
  Layer.effect(
    SubagentProfileService,
    Effect.gen(function* () {
      const store = yield* SubagentConfigStore;
      const config =
        options.sessionBaseConfig ??
        (yield* store.load(options.cwd, options.agentDirectory, options.projectTrusted));
      if (config.diagnostics.length > 0)
        yield* Effect.logWarning(
          `Invalid Subagents configuration fields were ignored, clamped, or failed closed: ${config.diagnostics.join(", ")}.`,
        );
      return yield* subagentProfileService(config, options);
    }),
  );

/** Builds the profile service from an already resolved configuration. */
export const subagentProfileServiceLayerFor = (
  config: ResolvedSubagentConfig,
  options: SubagentProfileServiceOptions = {},
) => Layer.effect(SubagentProfileService, subagentProfileService(config, options));
