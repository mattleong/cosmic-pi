import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { JsonDocumentStore } from "pi-cosmic-core";
import { resolveSubagentConfig, type ResolvedSubagentConfig } from "./options.ts";
import {
  decodeSubagentConfig,
  SUBAGENT_CONFIG_BASENAME,
  SUBAGENT_CONFIG_VERSION,
} from "./schema.ts";

export class SubagentConfigStoreError extends Schema.TaggedErrorClass<SubagentConfigStoreError>()(
  "SubagentConfigStoreError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

export interface SubagentConfigPaths {
  readonly global: string;
  readonly project: string;
}

export interface SubagentConfigStoreShape {
  readonly paths: (cwd: string, agentDirectory: string) => Effect.Effect<SubagentConfigPaths>;
  readonly load: (
    cwd: string,
    agentDirectory: string,
    projectTrusted: boolean,
  ) => Effect.Effect<ResolvedSubagentConfig, SubagentConfigStoreError>;
}

export class SubagentConfigStore extends Context.Service<
  SubagentConfigStore,
  SubagentConfigStoreShape
>()("pi-subagents/config/store/SubagentConfigStore") {}

const storeError = (operation: string, path: string) => () =>
  new SubagentConfigStoreError({
    operation,
    path,
    message: `Unable to ${operation} Subagents configuration.`,
  });

// Diagnostics stay path-safe: the declared version value is never echoed back.
const unsupportedVersionError = (path: string) =>
  new SubagentConfigStoreError({
    operation: "activate",
    path,
    message: `Subagents configuration declares an unsupported version; this build supports version ${SUBAGENT_CONFIG_VERSION}.`,
  });

export const subagentConfigStoreLayer = Layer.effect(
  SubagentConfigStore,
  Effect.gen(function* () {
    const documents = yield* JsonDocumentStore;
    const path = yield* Path.Path;
    const paths: SubagentConfigStoreShape["paths"] = (cwd, agentDirectory) =>
      Effect.succeed({
        // These paths are product compatibility surfaces and deliberately do not use extensions/.
        global: path.join(agentDirectory, SUBAGENT_CONFIG_BASENAME),
        project: path.join(cwd, CONFIG_DIR_NAME, SUBAGENT_CONFIG_BASENAME),
      });
    const load: SubagentConfigStoreShape["load"] = (cwd, agentDirectory, projectTrusted) =>
      Effect.gen(function* () {
        const locations = yield* paths(cwd, agentDirectory);
        const globalRaw = yield* documents
          .readObject(locations.global)
          .pipe(Effect.mapError(storeError("read", locations.global)));
        // Untrusted project configuration is never inspected, not merely ignored after reading.
        const projectRaw = projectTrusted
          ? yield* documents
              .readObject(locations.project)
              .pipe(Effect.mapError(storeError("read", locations.project)))
          : undefined;
        const global = decodeSubagentConfig(globalRaw ?? {}, "global");
        if (global.unsupportedVersion) return yield* unsupportedVersionError(locations.global);
        const project =
          projectRaw === undefined ? undefined : decodeSubagentConfig(projectRaw, "project");
        if (project?.unsupportedVersion) return yield* unsupportedVersionError(locations.project);
        return resolveSubagentConfig({
          globalConfigPath: locations.global,
          projectConfigPath: locations.project,
          projectTrusted,
          globalConfigExists: globalRaw !== undefined,
          projectConfigExists: projectRaw !== undefined,
          global,
          ...(project === undefined ? {} : { project }),
        });
      });
    return SubagentConfigStore.of({ paths, load });
  }),
);
