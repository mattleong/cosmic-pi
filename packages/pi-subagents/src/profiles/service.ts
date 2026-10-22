import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type { ResolvedSubagentConfig } from "../config/options.ts";
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
  ) => Effect.Effect<SessionProfileSnapshot, SessionProfileEditError>;
  readonly replaceSessionProfiles: (
    patch: SessionProfileSetPatch,
  ) => Effect.Effect<SessionProfileSnapshot, SessionProfileEditError>;
  readonly patchSessionNesting: (
    patch: SessionNestingPatch,
  ) => Effect.Effect<SessionProfileSnapshot, SessionProfileEditError>;
  readonly patchSessionDelegation: (
    patch: SessionDelegationPatch,
  ) => Effect.Effect<SessionProfileSnapshot, SessionProfileEditError>;
}

export class SubagentProfileService extends Context.Service<
  SubagentProfileService,
  SubagentProfileServiceContract
>()("pi-subagents/profiles/service/SubagentProfileService") {}

export interface SubagentProfileLayerOptions {
  readonly cwd: string;
  readonly agentDirectory: string;
  readonly projectTrusted: boolean;
  readonly sessionBaseConfig?: ResolvedSubagentConfig | undefined;
  readonly publishSessionBaseConfig?: ((config: ResolvedSubagentConfig) => void) | undefined;
  readonly initialSessionOverrides?: SessionProfileOverrideSeed | undefined;
  /** Receives the initial snapshot and every committed session change. */
  readonly publishSession?: ((snapshot: SessionProfileSnapshot) => void) | undefined;
}

export const makeSubagentProfileService = (
  config: ResolvedSubagentConfig,
  options: Pick<SubagentProfileLayerOptions, "initialSessionOverrides" | "publishSession"> = {},
): Effect.Effect<SubagentProfileServiceContract> =>
  Effect.gen(function* () {
    const publishSnapshot = (snapshot: SessionProfileSnapshot): Effect.Effect<void> => {
      const publish = options.publishSession;
      return publish ? Effect.try(() => publish(snapshot)).pipe(Effect.ignore) : Effect.void;
    };
    const initial = sessionProfileSnapshot(config, options.initialSessionOverrides);
    const state = yield* Ref.make(initial);
    const lock = yield* Semaphore.make(1);
    yield* publishSnapshot(initial);
    const commit = <E>(
      transition: (current: SessionProfileSnapshot) => Effect.Effect<SessionProfileSnapshot, E>,
    ): Effect.Effect<SessionProfileSnapshot, E> =>
      lock.withPermit(
        Ref.get(state).pipe(
          Effect.flatMap(transition),
          Effect.tap((next) =>
            Effect.uninterruptible(
              Ref.set(state, next).pipe(Effect.andThen(publishSnapshot(next))),
            ),
          ),
        ),
      );
    return SubagentProfileService.of({
      capture: Ref.get(state),
      definition: (profile) => (isProfileId(profile) ? PROFILE_DEFINITIONS[profile] : undefined),
      resolve: (snapshot, profile, environment, agent) =>
        resolveProfilePlan(profile, snapshot.effectiveConfig, environment, agent),
      withSnapshotAtRevision: <A, E, R>(
        expectedRevision: number,
        operation: (snapshot: SessionProfileSnapshot) => Effect.Effect<A, E, R>,
      ) =>
        lock.withPermit(
          Effect.flatMap(
            Ref.get(state),
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
      yield* Effect.try(() => options.publishSessionBaseConfig?.(config)).pipe(Effect.ignore);
      if (config.diagnostics.length > 0)
        yield* Effect.logWarning(
          `Invalid Subagents configuration fields were ignored or failed closed: ${config.diagnostics.join(", ")}.`,
        );
      return yield* makeSubagentProfileService(config, options);
    }),
  );

/** Builds the profile service from an already resolved configuration. */
export const subagentProfileServiceLayerFor = (
  config: ResolvedSubagentConfig,
  options: Pick<SubagentProfileLayerOptions, "initialSessionOverrides" | "publishSession"> = {},
) => Layer.effect(SubagentProfileService, makeSubagentProfileService(config, options));
