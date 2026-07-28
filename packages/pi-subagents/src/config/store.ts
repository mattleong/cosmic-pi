import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { JsonDocumentStore, type JsonObject } from "pi-cosmic-core";
import type { DeclaredProfileRoute, ProfileId } from "../profiles/model.ts";
import { resolveSubagentConfig, type ResolvedSubagentConfig } from "./options.ts";
import {
  decodeSubagentConfig,
  type DecodedSubagentConfig,
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

export interface SubagentConfigInspection {
  readonly config: ResolvedSubagentConfig;
  readonly globalDocument?: JsonObject | undefined;
  readonly projectDocument?: JsonObject | undefined;
  readonly global: DecodedSubagentConfig;
  readonly project?: DecodedSubagentConfig | undefined;
}

export type SubagentConfigScope = "global" | "project";

export interface SubagentProfilePatch {
  readonly scope: SubagentConfigScope;
  readonly profile: ProfileId;
  /** Undefined removes the declaration (project inherit or the global built-in route). */
  readonly route?: DeclaredProfileRoute | undefined;
  readonly expectedExists: boolean;
  readonly expectedDocument?: JsonObject | undefined;
  /** Trust is captured again from the command context immediately before the write. */
  readonly projectTrusted: boolean;
}

export interface SubagentConfigStoreShape {
  readonly paths: (cwd: string, agentDirectory: string) => Effect.Effect<SubagentConfigPaths>;
  readonly load: (
    cwd: string,
    agentDirectory: string,
    projectTrusted: boolean,
  ) => Effect.Effect<ResolvedSubagentConfig, SubagentConfigStoreError>;
  readonly inspect: (
    cwd: string,
    agentDirectory: string,
    projectTrusted: boolean,
  ) => Effect.Effect<SubagentConfigInspection, SubagentConfigStoreError>;
  readonly patchProfile: (
    cwd: string,
    agentDirectory: string,
    patch: SubagentProfilePatch,
  ) => Effect.Effect<void, SubagentConfigStoreError>;
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

const unsupportedVersionError = (path: string) =>
  new SubagentConfigStoreError({
    operation: "activate",
    path,
    message: `Subagents configuration must declare version ${SUBAGENT_CONFIG_VERSION}.`,
  });

const conflictError = (path: string) =>
  new SubagentConfigStoreError({
    operation: "update",
    path,
    message: "Subagents settings changed on disk; reopen /subagents profiles and try again.",
  });

const trustError = (path: string) =>
  new SubagentConfigStoreError({
    operation: "update",
    path,
    message: "Project profile settings require a trusted project.",
  });

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const routeJson = (route: DeclaredProfileRoute): JsonObject[string] => {
  if (route === "disabled") return route;
  const candidate = (value: { readonly model: string; readonly effort: string }): JsonObject => ({
    model: value.model,
    effort: value.effort,
  });
  return Array.isArray(route)
    ? route.map(candidate)
    : candidate(route as { readonly model: string; readonly effort: string });
};

const applyProfilePatch = (
  current: JsonObject,
  patch: Pick<SubagentProfilePatch, "profile" | "route">,
): JsonObject => {
  const currentProfiles =
    typeof current.profiles === "object" &&
    current.profiles !== null &&
    !Array.isArray(current.profiles)
      ? (current.profiles as JsonObject)
      : {};
  const profiles: JsonObject = { ...currentProfiles };
  if (patch.route === undefined) delete profiles[patch.profile];
  else profiles[patch.profile] = routeJson(patch.route);
  const next: JsonObject = { ...current, version: SUBAGENT_CONFIG_VERSION };
  if (Object.keys(profiles).length === 0) delete next.profiles;
  else next.profiles = profiles;
  return next;
};

export const subagentConfigStoreLayer = Layer.effect(
  SubagentConfigStore,
  Effect.gen(function* () {
    const documents = yield* JsonDocumentStore;
    const path = yield* Path.Path;
    const paths: SubagentConfigStoreShape["paths"] = (cwd, agentDirectory) =>
      Effect.succeed({
        global: path.join(agentDirectory, SUBAGENT_CONFIG_BASENAME),
        project: path.join(cwd, CONFIG_DIR_NAME, SUBAGENT_CONFIG_BASENAME),
      });

    const inspect: SubagentConfigStoreShape["inspect"] = (cwd, agentDirectory, projectTrusted) =>
      Effect.gen(function* () {
        const locations = yield* paths(cwd, agentDirectory);
        const globalRaw = yield* documents
          .readObject(locations.global)
          .pipe(Effect.mapError(storeError("read", locations.global)));
        const projectRaw = projectTrusted
          ? yield* documents
              .readObject(locations.project)
              .pipe(Effect.mapError(storeError("read", locations.project)))
          : undefined;
        const global = decodeSubagentConfig(
          globalRaw ?? { version: SUBAGENT_CONFIG_VERSION },
          "global",
        );
        if (
          globalRaw !== undefined &&
          (global.unsupportedVersion || global.file.version !== SUBAGENT_CONFIG_VERSION)
        )
          return yield* unsupportedVersionError(locations.global);
        const project =
          projectRaw === undefined ? undefined : decodeSubagentConfig(projectRaw, "project");
        if (
          projectRaw !== undefined &&
          (project?.unsupportedVersion || project?.file.version !== SUBAGENT_CONFIG_VERSION)
        )
          return yield* unsupportedVersionError(locations.project);
        const config = resolveSubagentConfig({
          globalConfigPath: locations.global,
          projectConfigPath: locations.project,
          projectTrusted,
          globalConfigExists: globalRaw !== undefined,
          projectConfigExists: projectRaw !== undefined,
          global,
          ...(project === undefined ? {} : { project }),
        });
        return {
          config,
          ...(globalRaw === undefined ? {} : { globalDocument: globalRaw }),
          ...(projectRaw === undefined ? {} : { projectDocument: projectRaw }),
          global,
          ...(project === undefined ? {} : { project }),
        };
      });

    const load: SubagentConfigStoreShape["load"] = (cwd, agentDirectory, projectTrusted) =>
      inspect(cwd, agentDirectory, projectTrusted).pipe(Effect.map((result) => result.config));

    const patchProfile: SubagentConfigStoreShape["patchProfile"] = (cwd, agentDirectory, patch) =>
      Effect.gen(function* () {
        const locations = yield* paths(cwd, agentDirectory);
        const target = patch.scope === "global" ? locations.global : locations.project;
        if (patch.scope === "project" && !patch.projectTrusted) return yield* trustError(target);
        // A patch that leaves the expected document unchanged (or removes a key from a
        // nonexistent file) must not create or rewrite a version-only file.
        if (!patch.expectedExists) {
          if (patch.route === undefined) return;
        } else {
          const expected = patch.expectedDocument ?? {};
          if (stableJson(applyProfilePatch(expected, patch)) === stableJson(expected)) return;
        }
        const modifyObject = documents.modifyObject;
        if (!modifyObject) return yield* storeError("update", target)();
        yield* modifyObject(target, (current) =>
          Effect.gen(function* () {
            const currentIsEmpty = Object.keys(current).length === 0;
            if (
              (!patch.expectedExists && !currentIsEmpty) ||
              (patch.expectedExists &&
                stableJson(current) !== stableJson(patch.expectedDocument ?? {}))
            )
              return yield* conflictError(target);
            if (!currentIsEmpty && current.version !== SUBAGENT_CONFIG_VERSION)
              return yield* unsupportedVersionError(target);
            return { value: undefined, document: applyProfilePatch(current, patch) };
          }),
        ).pipe(
          Effect.mapError((error) =>
            error instanceof SubagentConfigStoreError ? error : storeError("update", target)(),
          ),
        );
      });

    return SubagentConfigStore.of({ paths, load, inspect, patchProfile });
  }),
);
