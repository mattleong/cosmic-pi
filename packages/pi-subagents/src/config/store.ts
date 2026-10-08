import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { flow } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  invokeHostCallback,
  JsonDocumentStore,
  makeConfigDocumentErrorFactory,
  type JsonObject,
} from "pi-cosmic-core";
import {
  isProfileId,
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
  decodeProfileRoute,
  decodeSubagentConfig,
  decodeSubagentNesting,
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

type ConfigRead<A> = (
  cwd: string,
  agentDirectory: string,
  projectTrusted: boolean,
) => Effect.Effect<A, SubagentConfigStoreError>;

type ConfigPatch<Patch, A = void> = (
  cwd: string,
  agentDirectory: string,
  patch: Patch,
) => Effect.Effect<A, SubagentConfigStoreError>;

export interface SubagentConfigStoreContract {
  readonly load: ConfigRead<ResolvedSubagentConfig>;
  readonly inspect: ConfigRead<SubagentConfigInspection>;
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

/** A copy of `container` with `key` set, or removed when `value` is undefined. */
const withEntry = (
  container: JsonObject[string] | undefined,
  key: string,
  value: JsonObject[string] | undefined,
): JsonObject => {
  const next = isRecord(container) ? { ...container } : {};
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
};

/** Migrates only fully valid legacy data: every legacy decode diagnostic is fatal. */
const upgradeDocument = (
  current: JsonObject,
  path: string,
): Effect.Effect<JsonObject, SubagentConfigStoreError> => {
  if (current.version === SUBAGENT_CONFIG_VERSION) return Effect.succeed(current);
  if (decodeSubagentConfig(current, "migration").diagnostics.length > 0)
    return Effect.fail(
      mutationError(
        path,
        "Repair or remove every invalid legacy profile route before upgrading this document to version 6.",
      ),
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
  return Effect.succeed(next);
};

const currentProfileSets = (document: JsonObject): JsonObject =>
  isRecord(document.profileSets) ? document.profileSets : {};

type ApplyPatch<Patch> = (
  current: JsonObject,
  patch: Patch,
  path: string,
) => Effect.Effect<JsonObject, SubagentConfigStoreError>;

const applyProfilePatch: ApplyPatch<SubagentProfilePatch> = Effect.fnUntraced(
  function* (current, patch, path) {
    if (!isProfileSetName(patch.profileSet) || !isProfileId(patch.profile))
      return yield* mutationError(path, "Invalid profile target.");
    const routeProperty = ownDataProperty(patch, "route");
    const captured = routeProperty.valid
      ? captureProfilePatchDeclaration(routeProperty.present ? routeProperty.value : undefined)
      : undefined;
    if (!captured) return yield* mutationError(path, "Invalid profile route.");
    // SAFETY: The patch capture snapshots and canonically validates every candidate.
    const route = captured.declaration as DeclaredProfileRoute | undefined;
    const legacy = isLegacyConfigVersion(current.version);
    if (legacy && patch.profileSet !== MIGRATED_PROFILE_SET_NAME)
      return yield* mutationError(
        path,
        "Legacy configuration can edit only its migrated default set.",
      );
    if (legacy && Object.hasOwn(current, "profiles") && !isRecord(current.profiles))
      return yield* mutationError(
        path,
        "Repair the invalid legacy profiles container before upgrading this document.",
      );
    // A legacy route is patched before migration, so the patch can repair an invalid route. An
    // existing root `profiles` container is the migrated default set and is never dropped.
    const prepared =
      legacy && (route !== undefined || Object.hasOwn(current, "profiles"))
        ? {
            ...current,
            profiles: withEntry(
              current.profiles,
              patch.profile,
              route && routeJson(route, "legacy"),
            ),
          }
        : current;
    const upgraded = yield* upgradeDocument(prepared, path);
    const sets = { ...currentProfileSets(upgraded) };
    const setValue = sets[patch.profileSet];
    if (!isRecord(setValue)) {
      if (route === undefined) return upgraded;
      return yield* mutationError(path, "The selected profile set does not exist.");
    }
    sets[patch.profileSet] = {
      profiles: withEntry(setValue.profiles, patch.profile, route && routeJson(route)),
    };
    return { ...upgraded, profileSets: sets };
  },
);

const applyProfileRestore: ApplyPatch<SubagentProfileRestorePatch> = Effect.fnUntraced(
  function* (current, patch, path) {
    if (!isProfileSetName(patch.profileSet) || !isProfileId(patch.profile))
      return yield* mutationError(path, "Invalid profile restore target.");
    const captured = captureRestoreDeclaration(patch.declaration, patch.sourceVersion);
    if (!captured)
      return yield* mutationError(
        path,
        "The opening profile declaration cannot be restored safely.",
      );
    const upgraded = yield* upgradeDocument(current, path);
    const sets = { ...currentProfileSets(upgraded) };
    const selected = sets[patch.profileSet];
    if (!Object.hasOwn(sets, patch.profileSet) || !isRecord(selected))
      return yield* mutationError(path, "The selected profile set does not exist.");
    if (Object.hasOwn(selected, "profiles") && !isRecord(selected.profiles))
      return yield* mutationError(path, "The selected profiles container is invalid.");
    const declaration =
      captured.declaration === undefined || patch.sourceVersion === SUBAGENT_CONFIG_VERSION
        ? captured.declaration
        : migrateLegacyRouteJson(captured.declaration);
    sets[patch.profileSet] = {
      ...selected,
      profiles: withEntry(selected.profiles, patch.profile, declaration),
    };
    return { ...upgraded, profileSets: sets };
  },
);

const applyDefaultProfileSetPatch: ApplyPatch<SubagentDefaultProfileSetPatch> = Effect.fnUntraced(
  function* (current, patch, path) {
    const upgraded = yield* upgradeDocument(current, path);
    const name = patch.defaultProfileSet;
    if (name === undefined) return withEntry(upgraded, "defaultProfileSet", undefined);
    if (!isProfileSetName(name)) return yield* mutationError(path, "Invalid profile-set name.");
    const sets = currentProfileSets(upgraded);
    if (!Object.hasOwn(sets, name) || !isRecord(sets[name]))
      return yield* mutationError(path, "The selected profile set does not exist.");
    const decoded = decodeSubagentConfig(upgraded, "update");
    // Structurally invalid sets are never decoded into `file.profileSets`.
    if (!decoded.file.profileSets?.[name])
      return yield* mutationError(path, "The selected profile set is structurally invalid.");
    if (decoded.invalidProfileSetRoutes[name])
      return yield* mutationError(
        path,
        "The selected profile set contains an invalid profile route.",
      );
    return withEntry(upgraded, "defaultProfileSet", name);
  },
);

/** Copies a complete session snapshot without invoking accessors or iterators on its routes. */
const snapshotProfilesJson = (
  routes: Readonly<Record<ProfileId, ProfileRoute>>,
  path: string,
): Effect.Effect<JsonObject, SubagentConfigStoreError> => {
  const invalidRoute = mutationError(
    path,
    "The session snapshot contains an invalid profile route.",
  );
  const keys = invokeHostCallback(() => Reflect.ownKeys(routes), undefined);
  if (!keys) return Effect.fail(invalidRoute);
  if (
    keys.length !== PROFILE_IDS.length ||
    !keys.every((key) => Predicate.isString(key) && isProfileId(key))
  )
    return Effect.fail(
      mutationError(path, "A session snapshot must contain exactly all seven profiles."),
    );
  const profiles: JsonObject = {};
  for (const profile of PROFILE_IDS) {
    const field = ownDataProperty(routes, profile);
    const route = field.valid && field.present ? decodeProfileRoute(field.value) : undefined;
    if (!route) return Effect.fail(invalidRoute);
    profiles[profile] =
      route.candidates.length === 0
        ? "disabled"
        : route.candidates.map((candidate) => candidateJson(candidate, "current"));
  }
  return Effect.succeed(profiles);
};

/** Adds one new set after the duplicate-name and set-count checks create and copy share. */
const insertProfileSet = Effect.fnUntraced(function* (
  upgraded: JsonObject,
  name: string,
  path: string,
  set: Effect.Effect<JsonObject, SubagentConfigStoreError>,
) {
  const sets = { ...currentProfileSets(upgraded) };
  if (Object.hasOwn(sets, name))
    return yield* mutationError(path, "A profile set with that name exists.");
  const value = yield* set;
  if (Object.keys(sets).length >= MAX_PROFILE_SETS)
    return yield* mutationError(
      path,
      `A document may contain at most ${MAX_PROFILE_SETS} profile sets.`,
    );
  sets[name] = value;
  return { ...upgraded, profileSets: sets };
});

const applyCreateProfileSetFromSnapshot: ApplyPatch<SubagentCreateProfileSetFromSnapshotPatch> =
  Effect.fnUntraced(function* (current, patch, path) {
    if (!isProfileSetName(patch.profileSet))
      return yield* mutationError(path, "Invalid profile-set name.");
    const profiles = yield* snapshotProfilesJson(patch.profiles, path);
    const upgraded = yield* upgradeDocument(current, path);
    return yield* insertProfileSet(upgraded, patch.profileSet, path, Effect.succeed({ profiles }));
  });

const applyCopyProfileSet: ApplyPatch<SubagentCopyProfileSetPatch> = Effect.fnUntraced(
  function* (current, patch, path) {
    if (!isProfileSetName(patch.sourceProfileSet) || !isProfileSetName(patch.profileSet))
      return yield* mutationError(path, "Invalid profile-set name.");
    const upgraded = yield* upgradeDocument(current, path);
    const source = currentProfileSets(upgraded)[patch.sourceProfileSet];
    return yield* insertProfileSet(
      upgraded,
      patch.profileSet,
      path,
      isRecord(source)
        ? Effect.succeed(structuredClone(source))
        : Effect.fail(mutationError(path, "The source profile set does not exist.")),
    );
  },
);

const applyRenameProfileSet: ApplyPatch<SubagentRenameProfileSetPatch> = Effect.fnUntraced(
  function* (current, patch, path) {
    if (!isProfileSetName(patch.profileSet) || !isProfileSetName(patch.nextProfileSet))
      return yield* mutationError(path, "Invalid profile-set name.");
    const upgraded = yield* upgradeDocument(current, path);
    const sets = { ...currentProfileSets(upgraded) };
    const source = sets[patch.profileSet];
    if (!isRecord(source))
      return yield* mutationError(path, "The selected profile set does not exist.");
    if (patch.profileSet === patch.nextProfileSet) return upgraded;
    if (Object.hasOwn(sets, patch.nextProfileSet))
      return yield* mutationError(path, "A profile set with that name exists.");
    delete sets[patch.profileSet];
    sets[patch.nextProfileSet] = source;
    return {
      ...upgraded,
      profileSets: sets,
      ...(upgraded.defaultProfileSet === patch.profileSet && {
        defaultProfileSet: patch.nextProfileSet,
      }),
    };
  },
);

const applyDeleteProfileSet: ApplyPatch<SubagentDeleteProfileSetPatch> = Effect.fnUntraced(
  function* (current, patch, path) {
    if (!isProfileSetName(patch.profileSet))
      return yield* mutationError(path, "Invalid profile-set name.");
    const upgraded = yield* upgradeDocument(current, path);
    if (upgraded.defaultProfileSet === patch.profileSet)
      return yield* mutationError(
        path,
        "Choose another default profile set or inherit before deleting it.",
      );
    const sets = currentProfileSets(upgraded);
    if (!Object.hasOwn(sets, patch.profileSet)) return upgraded;
    const remaining = withEntry(sets, patch.profileSet, undefined);
    return withEntry(
      upgraded,
      "profileSets",
      Object.keys(remaining).length === 0 ? undefined : remaining,
    );
  },
);

const applyNestingPatch: ApplyPatch<SubagentNestingPatch> = Effect.fnUntraced(
  function* (current, patch, path) {
    const nesting = patch.nesting === undefined ? undefined : decodeSubagentNesting(patch.nesting);
    if (patch.nesting !== undefined && !nesting)
      return yield* mutationError(path, "Invalid nesting policy.");
    return withEntry(yield* upgradeDocument(current, path), "nesting", nesting && { ...nesting });
  },
);

const applyWriterWorkspacePatch: ApplyPatch<SubagentWriterWorkspacePatch> = Effect.fnUntraced(
  function* (current, patch, path) {
    const upgraded = yield* upgradeDocument(current, path);
    const mode = patch.writerWorkspaceMode;
    if (mode !== undefined && !Schema.is(WriterWorkspaceModeSchema)(mode))
      return yield* mutationError(path, "Invalid writer workspace mode.");
    return withEntry(upgraded, "writerWorkspaceMode", mode);
  },
);

const applyFeatureTogglePatch: ApplyPatch<SubagentFeatureTogglePatch> = Effect.fnUntraced(
  function* (current, patch, path) {
    const toggle = ownDataProperty(patch, "toggle");
    if (!toggle.valid || !toggle.present || !isSubagentFeatureToggle(toggle.value))
      return yield* mutationError(path, "Invalid feature setting.");
    const enabled = ownDataProperty(patch, "enabled");
    const value = enabled.valid && enabled.present ? enabled.value : undefined;
    if (!enabled.valid || (value !== undefined && !Predicate.isBoolean(value)))
      return yield* mutationError(path, "A feature setting must be true, false, or inherited.");
    const upgraded = yield* upgradeDocument(current, path);
    return withEntry(upgraded, toggle.value, Predicate.isBoolean(value) ? value : undefined);
  },
);

export const subagentConfigStoreLayer = Layer.effect(
  SubagentConfigStore,
  Effect.gen(function* () {
    const documents = yield* JsonDocumentStore;
    const path = yield* Path.Path;
    const paths = (cwd: string, agentDirectory: string) => ({
      global: path.join(agentDirectory, SUBAGENT_CONFIG_BASENAME),
      project: path.join(cwd, CONFIG_DIR_NAME, SUBAGENT_CONFIG_BASENAME),
    });

    const inspect = Effect.fn("SubagentConfigStore.inspect")(function* (
      cwd: string,
      agentDirectory: string,
      projectTrusted: boolean,
    ) {
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
      return {
        config: resolveSubagentConfig({
          globalConfigPath: locations.global,
          projectConfigPath: locations.project,
          projectTrusted,
          global,
          project,
        }),
        ...(globalRaw !== undefined && { globalDocument: globalRaw }),
        ...(projectRaw !== undefined && { projectDocument: projectRaw }),
        global,
        ...(project !== undefined && { project }),
      };
    });

    const patchWithReceipt = <Patch extends SubagentConfigPatchBase>(
      apply: ApplyPatch<Patch>,
    ): ConfigPatch<Patch, JsonObject> =>
      Effect.fn("SubagentConfigStore.patch")(function* (
        cwd: string,
        agentDirectory: string,
        patch: Patch,
      ) {
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
              const base = currentIsEmpty ? { version: SUBAGENT_CONFIG_VERSION } : current;
              const next = yield* apply(base, patch, target);
              // A missing document is created only when the patch changes its version-6 default.
              return stableJson(next) === stableJson(currentExists ? current : base)
                ? { value: structuredClone(current), document: current, write: false }
                : { value: structuredClone(next), document: next };
            }),
          )
          .pipe(
            Effect.catchTag("JsonDocumentError", () => Effect.fail(storeError("update", target)())),
          );
      });

    const patchVoid = <Patch extends SubagentConfigPatchBase>(
      apply: ApplyPatch<Patch>,
    ): ConfigPatch<Patch> => flow(patchWithReceipt(apply), (receipt) => Effect.asVoid(receipt));

    return SubagentConfigStore.of({
      load: (cwd, agentDirectory, projectTrusted) =>
        inspect(cwd, agentDirectory, projectTrusted).pipe(Effect.map((result) => result.config)),
      inspect,
      patchProfile: patchWithReceipt(applyProfilePatch),
      restoreProfileDeclaration: patchWithReceipt(applyProfileRestore),
      patchDefaultProfileSet: patchVoid(applyDefaultProfileSetPatch),
      createProfileSetFromSnapshot: patchVoid(applyCreateProfileSetFromSnapshot),
      copyProfileSet: patchVoid(applyCopyProfileSet),
      renameProfileSet: patchVoid(applyRenameProfileSet),
      deleteProfileSet: patchVoid(applyDeleteProfileSet),
      patchWriterWorkspace: patchVoid(applyWriterWorkspacePatch),
      patchNesting: patchVoid(applyNestingPatch),
      patchFeatureToggle: patchVoid(applyFeatureTogglePatch),
    });
  }),
);
