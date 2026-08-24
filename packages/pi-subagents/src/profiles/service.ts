import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { ResolvedSubagentConfig } from "../config/options.ts";
import { SubagentConfigStore } from "../config/store.ts";
import { profileDefinition } from "./definitions.ts";
import { normalizeProfileId, type ProfileDefinition } from "./model.ts";
import {
  resolveProfilePlan,
  type ProfileResolution,
  type ProfileResolutionEnvironment,
} from "./resolve.ts";
import {
  clearSessionProfileSnapshot,
  makeSessionProfileSnapshot,
  patchSessionProfileSnapshot,
  sessionProfileSeed,
  type SessionProfileConflictError,
  type SessionProfileOverrideSeed,
  type SessionProfilePatch,
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
  readonly patchSessionProfile: (
    patch: SessionProfilePatch,
  ) => Effect.Effect<SessionProfileSnapshot, SessionProfileConflictError>;
  readonly clearSessionProfiles: (
    expectedRevision: number,
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
  readonly baseConfig?: ResolvedSubagentConfig | undefined;
  readonly publishBaseConfig?: ((config: ResolvedSubagentConfig) => void) | undefined;
  readonly initialSessionOverrides?: SessionProfileOverrideSeed | undefined;
  readonly publishSessionOverrides?: ((seed: SessionProfileOverrideSeed) => void) | undefined;
}

const publishSeed = (
  publish: ((seed: SessionProfileOverrideSeed) => void) | undefined,
  snapshot: SessionProfileSnapshot,
): Effect.Effect<void> =>
  publish
    ? Effect.try(() => publish(sessionProfileSeed(snapshot))).pipe(Effect.ignore)
    : Effect.void;

export const makeSubagentProfileService = (
  config: ResolvedSubagentConfig,
  options: Pick<
    SubagentProfileLayerOptions,
    "initialSessionOverrides" | "publishSessionOverrides"
  > = {},
): Effect.Effect<SubagentProfileServiceContract> =>
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make(
      makeSessionProfileSnapshot(config, options.initialSessionOverrides),
    );
    const commit = <E>(
      transition: (current: SessionProfileSnapshot) => Effect.Effect<SessionProfileSnapshot, E>,
    ): Effect.Effect<SessionProfileSnapshot, E> =>
      SynchronizedRef.updateAndGetEffect(state, (current) =>
        transition(current).pipe(
          Effect.tap((next) => publishSeed(options.publishSessionOverrides, next)),
        ),
      );
    return SubagentProfileService.of({
      capture: SynchronizedRef.get(state),
      definition: (profile) => {
        const normalized = normalizeProfileId(profile);
        return normalized ? profileDefinition(normalized) : undefined;
      },
      resolve: (snapshot, profile, environment) =>
        resolveProfilePlan(profile, snapshot.effectiveConfig, environment),
      patchSessionProfile: (patch) =>
        commit((current) => patchSessionProfileSnapshot(current, patch)),
      clearSessionProfiles: (expectedRevision) =>
        commit((current) => clearSessionProfileSnapshot(current, expectedRevision)),
    });
  });

export const subagentProfileServiceLayer = (options: SubagentProfileLayerOptions) =>
  Layer.effect(
    SubagentProfileService,
    Effect.gen(function* () {
      const store = yield* SubagentConfigStore;
      const config =
        options.baseConfig ??
        (yield* store.load(options.cwd, options.agentDirectory, options.projectTrusted));
      if (options.publishBaseConfig)
        yield* Effect.try(() => options.publishBaseConfig?.(config)).pipe(Effect.ignore);
      if (config.diagnostics.length > 0)
        yield* Effect.logWarning(
          `Invalid Subagents configuration fields were ignored or failed closed: ${config.diagnostics.join(", ")}.`,
        );
      return yield* makeSubagentProfileService(config, options);
    }),
  );
