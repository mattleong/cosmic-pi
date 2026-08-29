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
  isProfileSetName,
  type DecodedSubagentConfig,
  LEGACY_SUBAGENT_CONFIG_VERSION,
  MAX_PROFILE_SETS,
  MIGRATED_PROFILE_SET_NAME,
  PREVIOUS_SUBAGENT_CONFIG_VERSION,
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

interface SubagentConfigPatchBase {
  readonly scope: SubagentConfigScope;
  readonly expectedExists: boolean;
  readonly expectedDocument?: JsonObject | undefined;
  /** Trust is captured again from the command context immediately before the write. */
  readonly projectTrusted: boolean;
}

export interface SubagentProfilePatch extends SubagentConfigPatchBase {
  readonly profileSet: string;
  readonly profile: ProfileId;
  /** Undefined removes the declaration and reveals the lower-precedence route. */
  readonly route?: DeclaredProfileRoute | undefined;
}

export interface SubagentDefaultProfileSetPatch extends SubagentConfigPatchBase {
  /** Undefined makes Project inherit Global or Global inherit built-ins. */
  readonly defaultProfileSet?: string | undefined;
}

export interface SubagentCreateProfileSetPatch extends SubagentConfigPatchBase {
  readonly profileSet: string;
}

export interface SubagentCopyProfileSetPatch extends SubagentConfigPatchBase {
  readonly sourceProfileSet: string;
  readonly profileSet: string;
}

export interface SubagentRenameProfileSetPatch extends SubagentConfigPatchBase {
  readonly profileSet: string;
  readonly nextProfileSet: string;
}

export interface SubagentDeleteProfileSetPatch extends SubagentConfigPatchBase {
  readonly profileSet: string;
}

export interface SubagentNestingPatch extends SubagentConfigPatchBase {
  /** Undefined removes the declaration and reveals the lower-precedence policy. */
  readonly nesting?: SubagentNestingPolicy | undefined;
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
  readonly patchDefaultProfileSet: (
    cwd: string,
    agentDirectory: string,
    patch: SubagentDefaultProfileSetPatch,
  ) => Effect.Effect<void, SubagentConfigStoreError>;
  readonly createProfileSet: (
    cwd: string,
    agentDirectory: string,
    patch: SubagentCreateProfileSetPatch,
  ) => Effect.Effect<void, SubagentConfigStoreError>;
  readonly copyProfileSet: (
    cwd: string,
    agentDirectory: string,
    patch: SubagentCopyProfileSetPatch,
  ) => Effect.Effect<void, SubagentConfigStoreError>;
  readonly renameProfileSet: (
    cwd: string,
    agentDirectory: string,
    patch: SubagentRenameProfileSetPatch,
  ) => Effect.Effect<void, SubagentConfigStoreError>;
  readonly deleteProfileSet: (
    cwd: string,
    agentDirectory: string,
    patch: SubagentDeleteProfileSetPatch,
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
    message: `Subagents configuration must declare version ${LEGACY_SUBAGENT_CONFIG_VERSION}, ${PREVIOUS_SUBAGENT_CONFIG_VERSION}, or ${SUBAGENT_CONFIG_VERSION} and use that version's route contract.`,
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
    message: "Subagents settings changed on disk; reopen /subagents profiles and try again.",
  });

const trustError = (path: string) =>
  new SubagentConfigStoreError({
    operation: "update",
    path,
    message: "Project subagent settings require a trusted project.",
  });

const mutationError = (path: string, message: string) =>
  new SubagentConfigStoreError({ operation: "update", path, message });

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

const candidateJson = (
  value: DeclaredProfileCandidate,
  version: "legacy" | "current",
): JsonObject => ({
  host: value.host,
  runtime: value.runtime,
  model: value.model,
  effort: value.effort,
  context: value.context,
  writeIntent: value.writeIntent,
  ...(value.openaiFastMode === true &&
    (version === "legacy" ? { fastMode: true } : { openaiFastMode: true })),
  ...(value.closeOnReport !== undefined && { closeOnReport: value.closeOnReport }),
});

const routeJson = (
  route: DeclaredProfileRoute,
  version: "legacy" | "current" = "current",
): JsonObject[string] => {
  if (route === "disabled") return route;
  // SAFETY: Configuration decoding validates the persisted value before this typed access.
  return Array.isArray(route)
    ? (route as ReadonlyArray<DeclaredProfileCandidate>).map((candidate) =>
        candidateJson(candidate, version),
      )
    : candidateJson(route as DeclaredProfileCandidate, version);
};

const isRecord = (value: JsonObject[string] | undefined): value is JsonObject =>
  hasObjectRuntimeType(value) && value !== null && !Array.isArray(value);

const own = (record: Readonly<JsonObject>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const legacyCandidateJson = (value: JsonObject): JsonObject => {
  const next: JsonObject = {};
  for (const [key, field] of Object.entries(value)) {
    if (key !== "fastMode") next[key] = field;
  }
  if (value.fastMode === true) next.openaiFastMode = true;
  return next;
};

const migrateLegacyRouteJson = (value: JsonObject[string]): JsonObject[string] => {
  if (value === "disabled") return value;
  if (Array.isArray(value))
    return value.map((candidate) =>
      isRecord(candidate) ? legacyCandidateJson(candidate) : candidate,
    );
  return isRecord(value) ? legacyCandidateJson(value) : value;
};

const migrateLegacyProfiles = (value: JsonObject): JsonObject => {
  const profiles: JsonObject = {};
  for (const [profile, route] of Object.entries(value))
    profiles[profile] = migrateLegacyRouteJson(route);
  return profiles;
};

const isAcceptedVersion = (version: JsonObject[string] | undefined): boolean =>
  version === LEGACY_SUBAGENT_CONFIG_VERSION ||
  version === PREVIOUS_SUBAGENT_CONFIG_VERSION ||
  version === SUBAGENT_CONFIG_VERSION;

const ensureMigratableLegacy = (
  document: JsonObject,
  path: string,
): SubagentConfigStoreError | undefined => {
  if (document.version === SUBAGENT_CONFIG_VERSION) return undefined;
  const decoded = decodeSubagentConfig(document, "migration");
  if (
    decoded.unsupportedVersion ||
    decoded.invalidDefaultProfileSet ||
    decoded.invalidProfileRoutes.length > 0 ||
    decoded.diagnostics.some(
      (diagnostic) =>
        diagnostic === "migration.<unknown>" ||
        diagnostic === "migration.profiles" ||
        diagnostic === "migration.profiles.<unknown>" ||
        diagnostic === "migration.nesting" ||
        /^migration\.profiles\.(?:scout|researcher|planner|worker|reviewer|oracle|generalist)/u.test(
          diagnostic,
        ),
    )
  )
    return mutationError(
      path,
      "Repair or remove every invalid legacy profile route before upgrading this document to version 6.",
    );
  return undefined;
};

const upgradeDocument = (
  current: JsonObject,
  path: string,
): JsonObject | SubagentConfigStoreError => {
  if (current.version === SUBAGENT_CONFIG_VERSION)
    return { ...current, version: SUBAGENT_CONFIG_VERSION };
  const migrationFailure = ensureMigratableLegacy(current, path);
  if (migrationFailure) return migrationFailure;
  const next: JsonObject = { version: SUBAGENT_CONFIG_VERSION };
  if (current.version === PREVIOUS_SUBAGENT_CONFIG_VERSION && current.nesting !== undefined)
    next.nesting = current.nesting;
  if (isRecord(current.profiles)) {
    next.defaultProfileSet = MIGRATED_PROFILE_SET_NAME;
    next.profileSets = {
      [MIGRATED_PROFILE_SET_NAME]: { profiles: migrateLegacyProfiles(current.profiles) },
    };
  }
  return next;
};

const currentProfileSets = (document: JsonObject): JsonObject =>
  isRecord(document.profileSets) ? document.profileSets : {};

const applyLegacyProfilePatch = (current: JsonObject, patch: SubagentProfilePatch): JsonObject => {
  const profiles = isRecord(current.profiles) ? { ...current.profiles } : {};
  if (patch.route === undefined) delete profiles[patch.profile];
  else profiles[patch.profile] = routeJson(patch.route, "legacy");
  const next = { ...current };
  if (Object.keys(profiles).length === 0) delete next.profiles;
  else next.profiles = profiles;
  return next;
};

const applyProfilePatch = (
  current: JsonObject,
  patch: SubagentProfilePatch,
  path: string,
): JsonObject | SubagentConfigStoreError => {
  if (!isProfileSetName(patch.profileSet)) return mutationError(path, "Invalid profile-set name.");
  const legacy =
    current.version === LEGACY_SUBAGENT_CONFIG_VERSION ||
    current.version === PREVIOUS_SUBAGENT_CONFIG_VERSION;
  if (legacy && patch.profileSet !== MIGRATED_PROFILE_SET_NAME)
    return mutationError(path, "Legacy configuration can edit only its migrated default set.");
  if (legacy && own(current, "profiles") && !isRecord(current.profiles))
    return mutationError(
      path,
      "Repair the invalid legacy profiles container before upgrading this document.",
    );
  const prepared = legacy ? applyLegacyProfilePatch(current, patch) : current;
  const upgraded = upgradeDocument(prepared, path);
  if (upgraded instanceof SubagentConfigStoreError) return upgraded;
  const sets = { ...currentProfileSets(upgraded) };
  const setValue = sets[patch.profileSet];
  if (!isRecord(setValue)) {
    if (patch.route === undefined) return upgraded;
    return mutationError(path, "The selected profile set does not exist.");
  }
  const profiles = isRecord(setValue.profiles) ? { ...setValue.profiles } : {};
  if (patch.route === undefined) delete profiles[patch.profile];
  else profiles[patch.profile] = routeJson(patch.route);
  sets[patch.profileSet] = { profiles };
  return { ...upgraded, profileSets: sets };
};

const applyDefaultProfileSetPatch = (
  current: JsonObject,
  patch: SubagentDefaultProfileSetPatch,
  path: string,
): JsonObject | SubagentConfigStoreError => {
  const upgraded = upgradeDocument(current, path);
  if (upgraded instanceof SubagentConfigStoreError) return upgraded;
  const next = { ...upgraded };
  if (patch.defaultProfileSet === undefined) {
    delete next.defaultProfileSet;
    return next;
  }
  if (!isProfileSetName(patch.defaultProfileSet))
    return mutationError(path, "Invalid profile-set name.");
  const sets = currentProfileSets(upgraded);
  if (!own(sets, patch.defaultProfileSet) || !isRecord(sets[patch.defaultProfileSet]))
    return mutationError(path, "The selected profile set does not exist.");
  const decoded = decodeSubagentConfig(upgraded, "update");
  if (
    decoded.invalidProfileSets.includes(patch.defaultProfileSet) ||
    !decoded.file.profileSets?.[patch.defaultProfileSet]
  )
    return mutationError(path, "The selected profile set is structurally invalid.");
  next.defaultProfileSet = patch.defaultProfileSet;
  return next;
};

const applyCreateProfileSet = (
  current: JsonObject,
  patch: SubagentCreateProfileSetPatch,
  path: string,
): JsonObject | SubagentConfigStoreError => {
  if (!isProfileSetName(patch.profileSet)) return mutationError(path, "Invalid profile-set name.");
  const upgraded = upgradeDocument(current, path);
  if (upgraded instanceof SubagentConfigStoreError) return upgraded;
  const sets = { ...currentProfileSets(upgraded) };
  if (own(sets, patch.profileSet))
    return mutationError(path, "A profile set with that name exists.");
  if (Object.keys(sets).length >= MAX_PROFILE_SETS)
    return mutationError(path, `A document may contain at most ${MAX_PROFILE_SETS} profile sets.`);
  sets[patch.profileSet] = { profiles: {} };
  return { ...upgraded, profileSets: sets };
};

const applyCopyProfileSet = (
  current: JsonObject,
  patch: SubagentCopyProfileSetPatch,
  path: string,
): JsonObject | SubagentConfigStoreError => {
  if (!isProfileSetName(patch.sourceProfileSet) || !isProfileSetName(patch.profileSet))
    return mutationError(path, "Invalid profile-set name.");
  const upgraded = upgradeDocument(current, path);
  if (upgraded instanceof SubagentConfigStoreError) return upgraded;
  const sets = { ...currentProfileSets(upgraded) };
  if (own(sets, patch.profileSet))
    return mutationError(path, "A profile set with that name exists.");
  const source = sets[patch.sourceProfileSet];
  if (!isRecord(source)) return mutationError(path, "The source profile set does not exist.");
  if (Object.keys(sets).length >= MAX_PROFILE_SETS)
    return mutationError(path, `A document may contain at most ${MAX_PROFILE_SETS} profile sets.`);
  sets[patch.profileSet] = structuredClone(source);
  return { ...upgraded, profileSets: sets };
};

const applyRenameProfileSet = (
  current: JsonObject,
  patch: SubagentRenameProfileSetPatch,
  path: string,
): JsonObject | SubagentConfigStoreError => {
  if (!isProfileSetName(patch.profileSet) || !isProfileSetName(patch.nextProfileSet))
    return mutationError(path, "Invalid profile-set name.");
  const upgraded = upgradeDocument(current, path);
  if (upgraded instanceof SubagentConfigStoreError) return upgraded;
  const sets = { ...currentProfileSets(upgraded) };
  const source = sets[patch.profileSet];
  if (!isRecord(source)) return mutationError(path, "The selected profile set does not exist.");
  if (patch.profileSet !== patch.nextProfileSet && own(sets, patch.nextProfileSet))
    return mutationError(path, "A profile set with that name exists.");
  if (patch.profileSet === patch.nextProfileSet) return upgraded;
  delete sets[patch.profileSet];
  sets[patch.nextProfileSet] = source;
  return {
    ...upgraded,
    profileSets: sets,
    ...(upgraded.defaultProfileSet === patch.profileSet && {
      defaultProfileSet: patch.nextProfileSet,
    }),
  };
};

const applyDeleteProfileSet = (
  current: JsonObject,
  patch: SubagentDeleteProfileSetPatch,
  path: string,
): JsonObject | SubagentConfigStoreError => {
  if (!isProfileSetName(patch.profileSet)) return mutationError(path, "Invalid profile-set name.");
  const upgraded = upgradeDocument(current, path);
  if (upgraded instanceof SubagentConfigStoreError) return upgraded;
  if (upgraded.defaultProfileSet === patch.profileSet)
    return mutationError(path, "Choose another default profile set or inherit before deleting it.");
  const sets = { ...currentProfileSets(upgraded) };
  if (!own(sets, patch.profileSet)) return upgraded;
  delete sets[patch.profileSet];
  const next = { ...upgraded };
  if (Object.keys(sets).length === 0) delete next.profileSets;
  else next.profileSets = sets;
  return next;
};

const applyNestingPatch = (
  current: JsonObject,
  patch: SubagentNestingPatch,
  path: string,
): JsonObject | SubagentConfigStoreError => {
  const upgraded = upgradeDocument(current, path);
  if (upgraded instanceof SubagentConfigStoreError) return upgraded;
  const next = { ...upgraded };
  if (patch.nesting === undefined) delete next.nesting;
  else
    next.nesting = {
      maxDirectChildren: patch.nesting.maxDirectChildren,
      maxDepth: patch.nesting.maxDepth,
    };
  return next;
};

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
            (diagnostic) => diagnostic === "global.<unknown>" || diagnostic === "global.nesting",
          )
        )
          return yield* unsupportedFieldsError(locations.global);
        const project =
          projectRaw === undefined ? undefined : decodeSubagentConfig(projectRaw, "project");
        if (projectRaw !== undefined && project?.unsupportedVersion)
          return yield* unsupportedVersionError(locations.project);
        if (
          project?.diagnostics.some(
            (diagnostic) => diagnostic === "project.<unknown>" || diagnostic === "project.nesting",
          )
        )
          return yield* unsupportedFieldsError(locations.project);
        const config = resolveSubagentConfig({
          globalConfigPath: locations.global,
          projectConfigPath: locations.project,
          projectTrusted,
          globalConfigExists: globalRaw !== undefined,
          projectConfigExists: projectRaw !== undefined,
          global,
          ...(project !== undefined && { project }),
        });
        return {
          config,
          ...(globalRaw !== undefined && { globalDocument: globalRaw }),
          ...(projectRaw !== undefined && { projectDocument: projectRaw }),
          global,
          ...(project !== undefined && { project }),
        };
      });

    const load: SubagentConfigStoreContract["load"] = (cwd, agentDirectory, projectTrusted) =>
      inspect(cwd, agentDirectory, projectTrusted).pipe(Effect.map((result) => result.config));

    const patchDocument = <Patch extends SubagentConfigPatchBase>(
      cwd: string,
      agentDirectory: string,
      patch: Patch,
      apply: (
        current: JsonObject,
        patch: Patch,
        path: string,
      ) => JsonObject | SubagentConfigStoreError,
      missingIsNoop = false,
    ): Effect.Effect<void, SubagentConfigStoreError> =>
      Effect.gen(function* () {
        const locations = yield* paths(cwd, agentDirectory);
        const target = patch.scope === "global" ? locations.global : locations.project;
        if (patch.scope === "project" && !patch.projectTrusted) return yield* trustError(target);
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
            if (currentIsEmpty && !patch.expectedExists && missingIsNoop)
              return { value: undefined, document: current, write: false };
            const base = currentIsEmpty ? { version: SUBAGENT_CONFIG_VERSION } : current;
            const next = apply(base, patch, target);
            if (next instanceof SubagentConfigStoreError) return yield* next;
            return stableJson(next) === stableJson(current)
              ? { value: undefined, document: current, write: false }
              : { value: undefined, document: next };
          }),
        ).pipe(
          Effect.mapError((error) =>
            error instanceof SubagentConfigStoreError ? error : storeError("update", target)(),
          ),
        );
      });

    const patchProfile: SubagentConfigStoreContract["patchProfile"] = (
      cwd,
      agentDirectory,
      patch,
    ) => patchDocument(cwd, agentDirectory, patch, applyProfilePatch, patch.route === undefined);
    const patchDefaultProfileSet: SubagentConfigStoreContract["patchDefaultProfileSet"] = (
      cwd,
      agentDirectory,
      patch,
    ) =>
      patchDocument(
        cwd,
        agentDirectory,
        patch,
        applyDefaultProfileSetPatch,
        patch.defaultProfileSet === undefined,
      );
    const createProfileSet: SubagentConfigStoreContract["createProfileSet"] = (
      cwd,
      agentDirectory,
      patch,
    ) => patchDocument(cwd, agentDirectory, patch, applyCreateProfileSet);
    const copyProfileSet: SubagentConfigStoreContract["copyProfileSet"] = (
      cwd,
      agentDirectory,
      patch,
    ) => patchDocument(cwd, agentDirectory, patch, applyCopyProfileSet);
    const renameProfileSet: SubagentConfigStoreContract["renameProfileSet"] = (
      cwd,
      agentDirectory,
      patch,
    ) => patchDocument(cwd, agentDirectory, patch, applyRenameProfileSet);
    const deleteProfileSet: SubagentConfigStoreContract["deleteProfileSet"] = (
      cwd,
      agentDirectory,
      patch,
    ) => patchDocument(cwd, agentDirectory, patch, applyDeleteProfileSet, true);
    const patchNesting: SubagentConfigStoreContract["patchNesting"] = (
      cwd,
      agentDirectory,
      patch,
    ) => patchDocument(cwd, agentDirectory, patch, applyNestingPatch, patch.nesting === undefined);

    return SubagentConfigStore.of({
      paths,
      load,
      inspect,
      patchProfile,
      patchDefaultProfileSet,
      createProfileSet,
      copyProfileSet,
      renameProfileSet,
      deleteProfileSet,
      patchNesting,
    });
  }),
);
