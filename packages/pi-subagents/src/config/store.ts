import { hasObjectRuntimeType } from "pi-cosmic-core";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { JsonDocumentStore, makeConfigDocumentErrorFactory, type JsonObject } from "pi-cosmic-core";
import {
  MAX_PROFILE_CANDIDATES,
  PROFILE_IDS,
  type DeclaredProfileCandidate,
  type DeclaredProfileRoute,
  type ProfileId,
  type ProfileRoute,
} from "../profiles/model.ts";
import { resolveSubagentConfig, type ResolvedSubagentConfig } from "./options.ts";
import {
  captureProfilePatchDeclaration,
  captureRestoreDeclaration,
  isRecord,
  migrateLegacyRouteJson,
  stableJson,
} from "./profile-restore.ts";
import {
  decodeProfileCandidate,
  decodeSubagentConfig,
  isLegacyConfigVersion,
  isProfileSetName,
  isSubagentFeatureToggle,
  isSupportedConfigVersion,
  ownDataProperty,
  SUBAGENT_FEATURE_TOGGLES,
  type DecodedSubagentConfig,
  type SubagentFeatureToggle,
  LEGACY_SUBAGENT_CONFIG_VERSION,
  MAX_PROFILE_SETS,
  MIGRATED_PROFILE_SET_NAME,
  PREVIOUS_SUBAGENT_CONFIG_VERSION,
  SUBAGENT_CONFIG_BASENAME,
  SUBAGENT_CONFIG_VERSION,
  type SubagentNestingPolicy,
  type WriterWorkspaceMode,
  WriterWorkspaceModeSchema,
} from "./schema.ts";

export class SubagentConfigStoreError extends Schema.TaggedError<SubagentConfigStoreError>()(
  "SubagentConfigStoreError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

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

export interface SubagentProfileRestorePatch extends SubagentConfigPatchBase {
  readonly profileSet: string;
  readonly profile: ProfileId;
  readonly declaration?: JsonObject[string] | undefined;
  readonly sourceVersion: number;
}

export interface SubagentDefaultProfileSetPatch extends SubagentConfigPatchBase {
  /** Undefined makes Project inherit Global or Global inherit built-ins. */
  readonly defaultProfileSet?: string | undefined;
}

export interface SubagentCreateProfileSetFromSnapshotPatch extends SubagentConfigPatchBase {
  readonly profileSet: string;
  /** One coherent, complete session snapshot. Every route is persisted explicitly. */
  readonly profiles: Readonly<Record<ProfileId, ProfileRoute>>;
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

export interface SubagentWriterWorkspacePatch extends SubagentConfigPatchBase {
  /** Undefined removes the saved preference and restores inheritance. */
  readonly writerWorkspaceMode?: WriterWorkspaceMode | undefined;
}

export interface SubagentFeatureTogglePatch extends SubagentConfigPatchBase {
  readonly toggle: SubagentFeatureToggle;
  /** Undefined removes the scope's declaration and restores inheritance. */
  readonly enabled?: boolean | undefined;
}

type ConfigPatch<Patch, A = void> = (
  cwd: string,
  agentDirectory: string,
  patch: Patch,
) => Effect.Effect<A, SubagentConfigStoreError>;

export interface SubagentConfigStoreContract {
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
  readonly patchProfile: ConfigPatch<SubagentProfilePatch, JsonObject>;
  readonly restoreProfileDeclaration: ConfigPatch<SubagentProfileRestorePatch, JsonObject>;
  readonly patchDefaultProfileSet: ConfigPatch<SubagentDefaultProfileSetPatch>;
  readonly createProfileSetFromSnapshot: ConfigPatch<SubagentCreateProfileSetFromSnapshotPatch>;
  readonly copyProfileSet: ConfigPatch<SubagentCopyProfileSetPatch>;
  readonly renameProfileSet: ConfigPatch<SubagentRenameProfileSetPatch>;
  readonly deleteProfileSet: ConfigPatch<SubagentDeleteProfileSetPatch>;
  readonly patchWriterWorkspace: ConfigPatch<SubagentWriterWorkspacePatch>;
  readonly patchNesting: ConfigPatch<SubagentNestingPatch>;
  readonly patchFeatureToggle: ConfigPatch<SubagentFeatureTogglePatch>;
}

export class SubagentConfigStore extends Context.Service<
  SubagentConfigStore,
  SubagentConfigStoreContract
>()("pi-subagents/config/store/SubagentConfigStore") {}

const storeError = makeConfigDocumentErrorFactory(SubagentConfigStoreError, "Subagents");

const configError = (operation: string, path: string, message: string) =>
  new SubagentConfigStoreError({ operation, path, message });

const unsupportedVersionError = (path: string) =>
  configError(
    "activate",
    path,
    `Subagents configuration must declare version ${LEGACY_SUBAGENT_CONFIG_VERSION}, ${PREVIOUS_SUBAGENT_CONFIG_VERSION}, or ${SUBAGENT_CONFIG_VERSION} and use that version's route contract.`,
  );

const mutationError = (path: string, message: string) => configError("update", path, message);

const conflictError = (path: string) =>
  mutationError(
    path,
    "Subagents settings changed on disk; reopen /subagents profiles and try again.",
  );

const trustError = (path: string) =>
  mutationError(path, "Project subagent settings require a trusted project.");

/** Activation fails closed on an unsupported version or fields outside the declared version. */
const decodeDocument = (
  raw: JsonObject,
  scope: SubagentConfigScope,
  path: string,
): Effect.Effect<DecodedSubagentConfig, SubagentConfigStoreError> => {
  const decoded = decodeSubagentConfig(raw, scope);
  if (decoded.unsupportedVersion) return Effect.fail(unsupportedVersionError(path));
  const fatal = [
    `${scope}.<unknown>`,
    `${scope}.nesting`,
    `${scope}.writerWorkspaceMode`,
    ...SUBAGENT_FEATURE_TOGGLES.map((toggle) => `${scope}.${toggle}`),
  ];
  return decoded.diagnostics.some((diagnostic) => fatal.includes(diagnostic))
    ? Effect.fail(
        configError(
          "activate",
          path,
          "Subagents configuration contains fields that are not part of its declared version.",
        ),
      )
    : Effect.succeed(decoded);
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

const own = (record: Readonly<JsonObject>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

/** Migrates only fully valid legacy data: every legacy decode diagnostic is fatal. */
const upgradeDocument = (
  current: JsonObject,
  path: string,
): JsonObject | SubagentConfigStoreError => {
  if (current.version === SUBAGENT_CONFIG_VERSION)
    return { ...current, version: SUBAGENT_CONFIG_VERSION };
  if (decodeSubagentConfig(current, "migration").diagnostics.length > 0)
    return mutationError(
      path,
      "Repair or remove every invalid legacy profile route before upgrading this document to version 6.",
    );
  const next: JsonObject = { version: SUBAGENT_CONFIG_VERSION };
  if (current.version === PREVIOUS_SUBAGENT_CONFIG_VERSION && current.nesting !== undefined)
    next.nesting = current.nesting;
  if (isRecord(current.profiles)) {
    next.defaultProfileSet = MIGRATED_PROFILE_SET_NAME;
    const profiles = Object.entries(current.profiles).map(
      ([profile, route]) => [profile, migrateLegacyRouteJson(route)] as const,
    );
    next.profileSets = { [MIGRATED_PROFILE_SET_NAME]: { profiles: Object.fromEntries(profiles) } };
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
  if (!isProfileSetName(patch.profileSet) || !PROFILE_IDS.includes(patch.profile))
    return mutationError(path, "Invalid profile target.");
  const routeProperty = ownDataProperty(patch, "route");
  if (!routeProperty.valid) return mutationError(path, "Invalid profile route.");
  const captured = captureProfilePatchDeclaration(
    routeProperty.present ? routeProperty.value : undefined,
  );
  if (!captured) return mutationError(path, "Invalid profile route.");
  // SAFETY: The patch capture snapshots and canonically validates every candidate.
  patch = { ...patch, route: captured.declaration as DeclaredProfileRoute | undefined };
  const legacy = isLegacyConfigVersion(current.version);
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

const applyProfileRestore = (
  current: JsonObject,
  patch: SubagentProfileRestorePatch,
  path: string,
): JsonObject | SubagentConfigStoreError => {
  if (!isProfileSetName(patch.profileSet) || !PROFILE_IDS.includes(patch.profile))
    return mutationError(path, "Invalid profile restore target.");
  const captured = captureRestoreDeclaration(patch.declaration, patch.sourceVersion);
  if (!captured)
    return mutationError(path, "The opening profile declaration cannot be restored safely.");
  const upgraded = upgradeDocument(current, path);
  if (upgraded instanceof SubagentConfigStoreError) return upgraded;
  const sets = { ...currentProfileSets(upgraded) };
  const selected = sets[patch.profileSet];
  if (!own(sets, patch.profileSet) || !isRecord(selected))
    return mutationError(path, "The selected profile set does not exist.");
  if (own(selected, "profiles") && !isRecord(selected.profiles))
    return mutationError(path, "The selected profiles container is invalid.");
  const profiles = isRecord(selected.profiles) ? { ...selected.profiles } : {};
  if (captured.declaration === undefined) delete profiles[patch.profile];
  else
    profiles[patch.profile] =
      patch.sourceVersion === SUBAGENT_CONFIG_VERSION
        ? captured.declaration
        : migrateLegacyRouteJson(captured.declaration);
  sets[patch.profileSet] = { ...selected, profiles };
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
  if ((decoded.invalidProfileSetRoutes[patch.defaultProfileSet]?.length ?? 0) > 0)
    return mutationError(path, "The selected profile set contains an invalid profile route.");
  next.defaultProfileSet = patch.defaultProfileSet;
  return next;
};

/** Captures one ordinary dense array without consulting an input iterator or invoking accessors. */
const snapshotCandidateArray = <ValueInput>(
  value: ValueInput,
): ReadonlyArray<unknown> | undefined => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  if (Object.getOwnPropertyDescriptor(value, Symbol.iterator) !== undefined) return undefined;
  const lengthProperty = ownDataProperty(value, "length");
  const length = lengthProperty.valid && lengthProperty.present ? lengthProperty.value : undefined;
  if (
    !Predicate.isNumber(length) ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_PROFILE_CANDIDATES
  )
    return undefined;
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const element = ownDataProperty(value, String(index));
    if (!element.valid || !element.present) return undefined;
    snapshot.push(element.value);
  }
  return snapshot;
};

const snapshotProfilesJson = (
  routes: Readonly<Record<ProfileId, ProfileRoute>>,
  path: string,
): JsonObject | SubagentConfigStoreError => {
  try {
    const keys = Reflect.ownKeys(routes);
    if (
      keys.length !== PROFILE_IDS.length ||
      keys.some(
        (key) => !Predicate.isString(key) || !PROFILE_IDS.some((profile) => profile === key),
      )
    )
      return mutationError(path, "A session snapshot must contain exactly all seven profiles.");
    const profiles: JsonObject = {};
    for (const profile of PROFILE_IDS) {
      const routeProperty = ownDataProperty(routes, profile);
      const route = routeProperty.valid && routeProperty.present ? routeProperty.value : undefined;
      if (!hasObjectRuntimeType(route) || route === null)
        return mutationError(path, "The session snapshot contains an invalid profile route.");
      const routeKeys = Reflect.ownKeys(route);
      if (routeKeys.length !== 1 || routeKeys[0] !== "candidates")
        return mutationError(path, "The session snapshot contains an invalid profile route.");
      const candidatesProperty = ownDataProperty(route, "candidates");
      const candidateInputs =
        candidatesProperty.valid && candidatesProperty.present
          ? snapshotCandidateArray(candidatesProperty.value)
          : undefined;
      if (!candidateInputs)
        return mutationError(path, "The session snapshot contains an invalid profile route.");
      if (candidateInputs.length === 0) {
        profiles[profile] = "disabled";
        continue;
      }
      const candidates: JsonObject[] = [];
      for (let index = 0; index < candidateInputs.length; index += 1) {
        const decoded = decodeProfileCandidate(candidateInputs[index]);
        if (!decoded)
          return mutationError(path, "The session snapshot contains an invalid profile route.");
        candidates.push(candidateJson(decoded, "current"));
      }
      profiles[profile] = candidates;
    }
    return profiles;
  } catch {
    return mutationError(path, "The session snapshot contains an invalid profile route.");
  }
};

const applyCreateProfileSetFromSnapshot = (
  current: JsonObject,
  patch: SubagentCreateProfileSetFromSnapshotPatch,
  path: string,
): JsonObject | SubagentConfigStoreError => {
  if (!isProfileSetName(patch.profileSet)) return mutationError(path, "Invalid profile-set name.");
  const profiles = snapshotProfilesJson(patch.profiles, path);
  if (profiles instanceof SubagentConfigStoreError) return profiles;
  const upgraded = upgradeDocument(current, path);
  if (upgraded instanceof SubagentConfigStoreError) return upgraded;
  const sets = { ...currentProfileSets(upgraded) };
  if (own(sets, patch.profileSet))
    return mutationError(path, "A profile set with that name exists.");
  if (Object.keys(sets).length >= MAX_PROFILE_SETS)
    return mutationError(path, `A document may contain at most ${MAX_PROFILE_SETS} profile sets.`);
  sets[patch.profileSet] = { profiles };
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

const applyWriterWorkspacePatch = (
  current: JsonObject,
  patch: SubagentWriterWorkspacePatch,
  path: string,
): JsonObject | SubagentConfigStoreError => {
  const upgraded = upgradeDocument(current, path);
  if (upgraded instanceof SubagentConfigStoreError) return upgraded;
  const next = { ...upgraded };
  if (patch.writerWorkspaceMode === undefined) delete next.writerWorkspaceMode;
  else if (!Schema.is(WriterWorkspaceModeSchema)(patch.writerWorkspaceMode))
    return mutationError(path, "Invalid writer workspace mode.");
  else next.writerWorkspaceMode = patch.writerWorkspaceMode;
  return next;
};

const applyFeatureTogglePatch = (
  current: JsonObject,
  patch: SubagentFeatureTogglePatch,
  path: string,
): JsonObject | SubagentConfigStoreError => {
  const toggle = ownDataProperty(patch, "toggle");
  if (!toggle.valid || !toggle.present || !isSubagentFeatureToggle(toggle.value))
    return mutationError(path, "Invalid feature setting.");
  const enabledProperty = ownDataProperty(patch, "enabled");
  const enabled =
    enabledProperty.valid && enabledProperty.present ? enabledProperty.value : undefined;
  if (!enabledProperty.valid || (enabled !== undefined && !Predicate.isBoolean(enabled)))
    return mutationError(path, "A feature setting must be true, false, or inherited.");
  const upgraded = upgradeDocument(current, path);
  if (upgraded instanceof SubagentConfigStoreError) return upgraded;
  const next = { ...upgraded };
  if (Predicate.isBoolean(enabled)) next[toggle.value] = enabled;
  else delete next[toggle.value];
  return next;
};

export const subagentConfigStoreLayer = Layer.effect(
  SubagentConfigStore,
  Effect.gen(function* () {
    const documents = yield* JsonDocumentStore;
    const path = yield* Path.Path;
    const paths = (cwd: string, agentDirectory: string) => ({
      global: path.join(agentDirectory, SUBAGENT_CONFIG_BASENAME),
      project: path.join(cwd, CONFIG_DIR_NAME, SUBAGENT_CONFIG_BASENAME),
    });

    const inspect: SubagentConfigStoreContract["inspect"] = (cwd, agentDirectory, projectTrusted) =>
      Effect.gen(function* () {
        const locations = paths(cwd, agentDirectory);
        const read = (target: string) =>
          documents.readObject(target).pipe(Effect.mapError(storeError("read", target)));
        const globalRaw = yield* read(locations.global);
        const projectRaw = projectTrusted ? yield* read(locations.project) : undefined;
        const global = yield* decodeDocument(
          globalRaw ?? { version: SUBAGENT_CONFIG_VERSION },
          "global",
          locations.global,
        );
        const project =
          projectRaw === undefined
            ? undefined
            : yield* decodeDocument(projectRaw, "project", locations.project);
        const config = resolveSubagentConfig({
          globalConfigPath: locations.global,
          projectConfigPath: locations.project,
          projectTrusted,
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

    const patchWithReceipt =
      <Patch extends SubagentConfigPatchBase>(
        apply: (
          current: JsonObject,
          patch: Patch,
          path: string,
        ) => JsonObject | SubagentConfigStoreError,
        missingIsNoop: (patch: Patch) => boolean = () => false,
      ): ConfigPatch<Patch, JsonObject> =>
      (cwd, agentDirectory, patch) =>
        Effect.gen(function* () {
          const locations = paths(cwd, agentDirectory);
          const target = patch.scope === "global" ? locations.global : locations.project;
          if (patch.scope === "project" && !patch.projectTrusted) return yield* trustError(target);
          return yield* documents
            .modifyObject(target, (current) =>
              Effect.gen(function* () {
                const currentExists = yield* documents.exists(target);
                const currentIsEmpty = Object.keys(current).length === 0;
                if (
                  currentExists !== patch.expectedExists ||
                  (patch.expectedExists &&
                    stableJson(current) !== stableJson(patch.expectedDocument ?? {}))
                )
                  return yield* conflictError(target);
                if (!currentIsEmpty && !isSupportedConfigVersion(current.version))
                  return yield* unsupportedVersionError(target);
                if (!currentExists && missingIsNoop(patch))
                  return { value: structuredClone(current), document: current, write: false };
                const base = currentIsEmpty ? { version: SUBAGENT_CONFIG_VERSION } : current;
                const next = apply(base, patch, target);
                if (next instanceof SubagentConfigStoreError) return yield* next;
                return stableJson(next) === stableJson(current)
                  ? { value: structuredClone(current), document: current, write: false }
                  : { value: structuredClone(next), document: next };
              }),
            )
            .pipe(
              Effect.mapError((error) =>
                error instanceof SubagentConfigStoreError ? error : storeError("update", target)(),
              ),
            );
        });

    const patchVoid = <Patch extends SubagentConfigPatchBase>(
      ...args: Parameters<typeof patchWithReceipt<Patch>>
    ): ConfigPatch<Patch> => {
      const patchDocument = patchWithReceipt(...args);
      return (cwd, agentDirectory, patch) =>
        patchDocument(cwd, agentDirectory, patch).pipe(Effect.asVoid);
    };

    return SubagentConfigStore.of({
      load,
      inspect,
      patchProfile: patchWithReceipt(applyProfilePatch, (patch) => {
        const route = ownDataProperty(patch, "route");
        return route.valid && (!route.present || route.value === undefined);
      }),
      restoreProfileDeclaration: patchWithReceipt(applyProfileRestore),
      patchDefaultProfileSet: patchVoid(
        applyDefaultProfileSetPatch,
        (patch) => patch.defaultProfileSet === undefined,
      ),
      createProfileSetFromSnapshot: patchVoid(applyCreateProfileSetFromSnapshot),
      copyProfileSet: patchVoid(applyCopyProfileSet),
      renameProfileSet: patchVoid(applyRenameProfileSet),
      deleteProfileSet: patchVoid(applyDeleteProfileSet, () => true),
      patchWriterWorkspace: patchVoid(
        applyWriterWorkspacePatch,
        (patch) => patch.writerWorkspaceMode === undefined,
      ),
      patchNesting: patchVoid(applyNestingPatch, (patch) => patch.nesting === undefined),
      patchFeatureToggle: patchVoid(applyFeatureTogglePatch, (patch) => {
        const toggle = ownDataProperty(patch, "toggle");
        const enabled = ownDataProperty(patch, "enabled");
        return (
          toggle.valid &&
          toggle.present &&
          isSubagentFeatureToggle(toggle.value) &&
          enabled.valid &&
          (!enabled.present || enabled.value === undefined)
        );
      }),
    });
  }),
);
