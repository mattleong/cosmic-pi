import { hasObjectRuntimeType } from "pi-cosmic-core";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { JsonDocumentStore, makeConfigDocumentErrorFactory, type JsonObject } from "pi-cosmic-core";
import type {
  DeclaredProfileCandidate,
  DeclaredProfileRoute,
  ProfileId,
} from "../profiles/model.ts";
import { resolveSubagentConfig, type ResolvedSubagentConfig } from "./options.ts";
import {
  decodeSubagentConfig,
  type DecodedSubagentConfig,
  LEGACY_SUBAGENT_CONFIG_VERSION,
  SUBAGENT_CONFIG_BASENAME,
  SUBAGENT_CONFIG_VERSION,
  type SubagentNestingPolicy,
} from "./schema.ts";

export class SubagentConfigStoreError extends Schema.TaggedError<SubagentConfigStoreError>()(
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

export interface SubagentNestingPatch {
  readonly scope: SubagentConfigScope;
  /** Undefined removes the declaration and reveals the lower-precedence policy. */
  readonly nesting?: SubagentNestingPolicy | undefined;
  readonly expectedExists: boolean;
  readonly expectedDocument?: JsonObject | undefined;
  readonly projectTrusted: boolean;
}

export interface SubagentConfigStoreContract {
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
  readonly patchNesting: (
    cwd: string,
    agentDirectory: string,
    patch: SubagentNestingPatch,
  ) => Effect.Effect<void, SubagentConfigStoreError>;
}

export class SubagentConfigStore extends Context.Service<
  SubagentConfigStore,
  SubagentConfigStoreContract
>()("pi-subagents/config/store/SubagentConfigStore") {}

const storeError = makeConfigDocumentErrorFactory(SubagentConfigStoreError, "Subagents");

const unsupportedVersionError = (path: string) =>
  new SubagentConfigStoreError({
    operation: "activate",
    path,
    message: `Subagents configuration must declare version ${LEGACY_SUBAGENT_CONFIG_VERSION} or ${SUBAGENT_CONFIG_VERSION} and use the current route contract.`,
  });

const unsupportedFieldsError = (path: string) =>
  new SubagentConfigStoreError({
    operation: "activate",
    path,
    message: "Subagents configuration contains fields that are not part of its declared version.",
  });

const conflictError = (path: string) =>
  new SubagentConfigStoreError({
    operation: "update",
    path,
    message: "Subagents settings changed on disk; reopen /subagents settings and try again.",
  });

const trustError = (path: string) =>
  new SubagentConfigStoreError({
    operation: "update",
    path,
    message: "Project subagent settings require a trusted project.",
  });

const stableJson = <ValueInput>(value: ValueInput): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (hasObjectRuntimeType(value) && value !== null) {
    // SAFETY: Configuration decoding validates the persisted value before this typed access.
    const record = value as Readonly<JsonObject>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const routeJson = (route: DeclaredProfileRoute): JsonObject[string] => {
  if (route === "disabled") return route;
  const candidate = (value: DeclaredProfileCandidate): JsonObject =>
    (() => {
      const baseResult = {
        host: value.host,
        runtime: value.runtime,
        model: value.model,
        effort: value.effort,
        context: value.context,
        writeIntent: value.writeIntent,
      };
      const withFastMode =
        value.fastMode === undefined ? baseResult : { ...baseResult, fastMode: value.fastMode };
      const withCloseOnReport =
        value.closeOnReport === undefined
          ? withFastMode
          : { ...withFastMode, closeOnReport: value.closeOnReport };
      return withCloseOnReport;
    })();
  // SAFETY: Configuration decoding validates the persisted value before this typed access.
  return Array.isArray(route)
    ? (route as ReadonlyArray<DeclaredProfileCandidate>).map(candidate)
    : candidate(route as DeclaredProfileCandidate);
};

const upgradeDocument = (current: JsonObject): JsonObject => ({
  ...current,
  version: SUBAGENT_CONFIG_VERSION,
});

const applyProfilePatch = (
  current: JsonObject,
  patch: Pick<SubagentProfilePatch, "profile" | "route">,
): JsonObject => {
  // SAFETY: Configuration decoding validates the persisted value before this typed access.
  const currentProfiles =
    hasObjectRuntimeType(current.profiles) &&
    current.profiles !== null &&
    !Array.isArray(current.profiles)
      ? (current.profiles as JsonObject)
      : {};
  const profiles: JsonObject = { ...currentProfiles };
  if (patch.route === undefined) delete profiles[patch.profile];
  else profiles[patch.profile] = routeJson(patch.route);
  const next: JsonObject = upgradeDocument(current);
  if (Object.keys(profiles).length === 0) delete next.profiles;
  else next.profiles = profiles;
  return next;
};

const applyNestingPatch = (
  current: JsonObject,
  nesting: SubagentNestingPolicy | undefined,
): JsonObject => {
  const next = upgradeDocument(current);
  if (nesting === undefined) delete next.nesting;
  else
    next.nesting = {
      maxDirectChildren: nesting.maxDirectChildren,
      maxDepth: nesting.maxDepth,
    };
  return next;
};

const isAcceptedVersion = (version: JsonObject[string] | undefined): boolean =>
  version === LEGACY_SUBAGENT_CONFIG_VERSION || version === SUBAGENT_CONFIG_VERSION;

export const subagentConfigStoreLayer = Layer.effect(
  SubagentConfigStore,
  Effect.gen(function* () {
    const documents = yield* JsonDocumentStore;
    const path = yield* Path.Path;
    const paths: SubagentConfigStoreContract["paths"] = (cwd, agentDirectory) =>
      Effect.succeed({
        global: path.join(agentDirectory, SUBAGENT_CONFIG_BASENAME),
        project: path.join(cwd, CONFIG_DIR_NAME, SUBAGENT_CONFIG_BASENAME),
      });

    const inspect: SubagentConfigStoreContract["inspect"] = (cwd, agentDirectory, projectTrusted) =>
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
        if (globalRaw !== undefined && global.unsupportedVersion)
          return yield* unsupportedVersionError(locations.global);
        if (
          global.diagnostics.some(
            (diagnostic) => diagnostic.endsWith(".<unknown>") || diagnostic === "global.nesting",
          )
        )
          return yield* unsupportedFieldsError(locations.global);
        const project =
          projectRaw === undefined ? undefined : decodeSubagentConfig(projectRaw, "project");
        if (projectRaw !== undefined && project?.unsupportedVersion)
          return yield* unsupportedVersionError(locations.project);
        if (
          project?.diagnostics.some(
            (diagnostic) => diagnostic.endsWith(".<unknown>") || diagnostic === "project.nesting",
          )
        )
          return yield* unsupportedFieldsError(locations.project);
        const config = resolveSubagentConfig(
          (() => {
            const baseResult = {
              globalConfigPath: locations.global,
              projectConfigPath: locations.project,
              projectTrusted,
              globalConfigExists: globalRaw !== undefined,
              projectConfigExists: projectRaw !== undefined,
              global,
            };
            const withProject = project === undefined ? baseResult : { ...baseResult, project };
            return withProject;
          })(),
        );
        return (() => {
          const baseResult = { config };
          const withGlobalDocument =
            globalRaw === undefined ? baseResult : { ...baseResult, globalDocument: globalRaw };
          const withProjectDocument =
            projectRaw === undefined
              ? withGlobalDocument
              : { ...withGlobalDocument, projectDocument: projectRaw };
          const withGlobal = { ...withProjectDocument, global };
          const withProject = project === undefined ? withGlobal : { ...withGlobal, project };
          return withProject;
        })();
      });

    const load: SubagentConfigStoreContract["load"] = (cwd, agentDirectory, projectTrusted) =>
      inspect(cwd, agentDirectory, projectTrusted).pipe(Effect.map((result) => result.config));

    const patchProfile: SubagentConfigStoreContract["patchProfile"] = (
      cwd,
      agentDirectory,
      patch,
    ) =>
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
            if (!currentIsEmpty && !isAcceptedVersion(current.version))
              return yield* unsupportedVersionError(target);
            return { value: undefined, document: applyProfilePatch(current, patch) };
          }),
        ).pipe(
          Effect.mapError((error) =>
            error instanceof SubagentConfigStoreError ? error : storeError("update", target)(),
          ),
        );
      });

    const patchNesting: SubagentConfigStoreContract["patchNesting"] = (
      cwd,
      agentDirectory,
      patch,
    ) =>
      Effect.gen(function* () {
        const locations = yield* paths(cwd, agentDirectory);
        const target = patch.scope === "global" ? locations.global : locations.project;
        if (patch.scope === "project" && !patch.projectTrusted) return yield* trustError(target);
        if (!patch.expectedExists && patch.nesting === undefined) return;
        if (patch.expectedExists) {
          const expected = patch.expectedDocument ?? {};
          if (stableJson(applyNestingPatch(expected, patch.nesting)) === stableJson(expected))
            return;
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
            if (!currentIsEmpty && !isAcceptedVersion(current.version))
              return yield* unsupportedVersionError(target);
            return { value: undefined, document: applyNestingPatch(current, patch.nesting) };
          }),
        ).pipe(
          Effect.mapError((error) =>
            error instanceof SubagentConfigStoreError ? error : storeError("update", target)(),
          ),
        );
      });

    return SubagentConfigStore.of({ paths, load, inspect, patchProfile, patchNesting });
  }),
);
