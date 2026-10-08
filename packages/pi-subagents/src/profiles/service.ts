import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type { ResolvedSubagentConfig } from "../config/options.ts";
import { SubagentConfigStore } from "../config/store.ts";
import { PROFILE_DEFINITIONS } from "./definitions.ts";
import { isProfileId, type ProfileDefinition } from "./model.ts";
import {
  resolveProfilePlan,
  type ProfileResolution,
  type ProfileResolutionEnvironment,
} from "./resolve.ts";
import {
  conflict,
  makeSessionProfileSnapshot,
  patchSessionFeatureSnapshot,
  patchSessionNestingSnapshot,
  patchSessionProfileSnapshot,
  replaceSessionProfileSnapshot,
  sessionProfileSeed,
  type SessionFeaturePatch,
  type SessionProfileConflictError,
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
  ) => ProfileResolution;
  readonly withSnapshotAtRevision: <A, E, R>(
    expectedRevision: number,
    operation: (snapshot: SessionProfileSnapshot) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SessionProfileConflictError, R>;
  readonly patchSessionProfile: (
    patch: SessionProfilePatch,
  ) => Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError>;
  readonly replaceSessionProfiles: (
    patch: SessionProfileSetPatch,
  ) => Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError>;
  readonly patchSessionNesting: (
    patch: SessionNestingPatch,
  ) => Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError>;
  readonly patchSessionFeature: (
    patch: SessionFeaturePatch,
  ) => Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError>;
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
  readonly publishSessionOverrides?: ((seed: SessionProfileOverrideSeed) => void) | undefined;
}

export const makeSubagentProfileService = (
  config: ResolvedSubagentConfig,
  options: Pick<
    SubagentProfileLayerOptions,
    "initialSessionOverrides" | "publishSessionOverrides"
  > = {},
): Effect.Effect<SubagentProfileServiceContract> =>
  Effect.gen(function* () {
    const publishSeed = (snapshot: SessionProfileSnapshot): Effect.Effect<void> => {
      const publish = options.publishSessionOverrides;
      return publish
        ? Effect.try(() => publish(sessionProfileSeed(snapshot))).pipe(Effect.ignore)
        : Effect.void;
    };
    const initial = makeSessionProfileSnapshot(config, options.initialSessionOverrides);
    // A plain Ref behind a lock, rather than a SynchronizedRef, lets the state assignment and
    // the handoff publication commit together while lock waiting stays interruptible.
    const state = yield* Ref.make(initial);
    const lock = yield* Semaphore.make(1);
    yield* publishSeed(initial);
    const commit = <E>(
      transition: (current: SessionProfileSnapshot) => Effect.Effect<SessionProfileSnapshot, E>,
    ): Effect.Effect<SessionProfileSnapshot, E> =>
      lock.withPermit(
        Ref.get(state).pipe(
          Effect.flatMap(transition),
          Effect.tap((next) =>
            Effect.uninterruptible(Ref.set(state, next).pipe(Effect.andThen(publishSeed(next)))),
          ),
        ),
      );
    return SubagentProfileService.of({
      capture: Ref.get(state),
      definition: (profile) => (isProfileId(profile) ? PROFILE_DEFINITIONS[profile] : undefined),
      resolve: (snapshot, profile, environment) =>
        resolveProfilePlan(profile, snapshot.effectiveConfig, environment),
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
      patchSessionFeature: (patch) =>
        commit((current) => patchSessionFeatureSnapshot(current, patch)),
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
