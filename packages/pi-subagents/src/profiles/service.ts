import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ResolvedSubagentConfig } from "../config/options.ts";
import { SubagentConfigStore } from "../config/store.ts";
import { profileDefinition } from "./definitions.ts";
import { isProfileId, type ProfileDefinition } from "./model.ts";
import {
  resolveProfilePlan,
  type ProfileResolution,
  type ProfileResolutionEnvironment,
} from "./resolve.ts";

export interface SubagentProfileServiceShape {
  readonly config: ResolvedSubagentConfig;
  readonly definition: (profile: string) => ProfileDefinition | undefined;
  readonly resolve: (
    profile: string,
    environment: ProfileResolutionEnvironment,
  ) => ProfileResolution;
}

export class SubagentProfileService extends Context.Service<
  SubagentProfileService,
  SubagentProfileServiceShape
>()("pi-subagents/profiles/service/SubagentProfileService") {
  static override readonly use = <A, E>(
    f: (service: SubagentProfileServiceShape) => Effect.Effect<A, E>,
  ) => Effect.flatMap(this, f);
}

export interface SubagentProfileLayerOptions {
  readonly cwd: string;
  readonly agentDirectory: string;
  readonly projectTrusted: boolean;
}

export const makeSubagentProfileService = (
  config: ResolvedSubagentConfig,
): SubagentProfileServiceShape => ({
  config,
  definition: (profile) => (isProfileId(profile) ? profileDefinition(profile) : undefined),
  resolve: (profile, environment) => resolveProfilePlan(profile, config, environment),
});

export const subagentProfileServiceLayer = (options: SubagentProfileLayerOptions) =>
  Layer.effect(
    SubagentProfileService,
    Effect.gen(function* () {
      const store = yield* SubagentConfigStore;
      const config = yield* store.load(options.cwd, options.agentDirectory, options.projectTrusted);
      if (config.diagnostics.length > 0)
        yield* Effect.logWarning(
          `Invalid Subagents configuration fields were ignored or failed closed: ${config.diagnostics.join(", ")}.`,
        );
      return makeSubagentProfileService(config);
    }),
  );
