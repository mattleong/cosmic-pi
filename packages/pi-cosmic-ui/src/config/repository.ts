import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { AgentDirectory, JsonDocumentStore } from "pi-cosmic-core";
import type { ResolvedCosmicUiConfig } from "./schema.ts";
import {
  resolveConfig,
  setFooterVisibility,
  updateFooterConfig,
  type CosmicUiConfigAfterCommit,
  type CosmicUiConfigError,
} from "./store.ts";

export interface CosmicUiConfigRepositoryShape {
  readonly resolve: (
    cwd: string,
    projectTrusted?: boolean,
  ) => Effect.Effect<ResolvedCosmicUiConfig, CosmicUiConfigError>;
  readonly updateFooter: (
    cwd: string,
    patch: Partial<ResolvedCosmicUiConfig["footer"]>,
    projectTrusted?: boolean,
    afterCommit?: CosmicUiConfigAfterCommit,
  ) => Effect.Effect<ResolvedCosmicUiConfig, CosmicUiConfigError>;
  readonly setVisibility: (
    cwd: string,
    id: string,
    visible: boolean,
    projectTrusted?: boolean,
    afterCommit?: CosmicUiConfigAfterCommit,
  ) => Effect.Effect<ResolvedCosmicUiConfig, CosmicUiConfigError>;
}

export class CosmicUiConfigRepository extends Context.Service<
  CosmicUiConfigRepository,
  CosmicUiConfigRepositoryShape
>()("pi-cosmic-ui/config/repository/CosmicUiConfigRepository") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const agentDir = yield* AgentDirectory;
      const dependencies = yield* Effect.context<JsonDocumentStore | Path.Path>();
      const provide = <A, E>(effect: Effect.Effect<A, E, JsonDocumentStore | Path.Path>) =>
        effect.pipe(Effect.provideContext(dependencies));
      return CosmicUiConfigRepository.of({
        resolve: (cwd, projectTrusted) => provide(resolveConfig(cwd, agentDir, projectTrusted)),
        updateFooter: (cwd, patch, projectTrusted, afterCommit) =>
          provide(updateFooterConfig(cwd, agentDir, patch, projectTrusted, afterCommit)),
        setVisibility: (cwd, id, visible, projectTrusted, afterCommit) =>
          provide(setFooterVisibility(cwd, agentDir, id, visible, projectTrusted, afterCommit)),
      });
    }),
  );
}
