import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { JsonDocumentStore, configDocumentErrorFactory, type JsonObject } from "pi-cosmic-core";
import {
  isProfileId,
  PROFILE_IDS,
  type DeclaredProfileRoute,
  type ProfileId,
  type ProfileRoute,
} from "../profiles/model.ts";
import { resolveSubagentConfig, type ResolvedSubagentConfig } from "./options.ts";
import {
  candidateJson,
  captureProfilePatchRoute,
  captureRestoreDeclaration,
  isRecord,
  routeJson,
  stableJson,
} from "./profile-restore.ts";
import {
  decodeProfileRoute,
  decodeSubagentNestingOverrides,
  isProfileSetName,
  isSupportedConfigVersion,
  subagentConfigDecoder,
  type DecodedSubagentConfig,
  MAX_PROFILE_SETS,
  SUBAGENT_CONFIG_BASENAME,
  SUBAGENT_CONFIG_VERSION,
  type DelegationMode,
  isDelegationMode,
  type SubagentNestingOverrides,
  type WriterWorkspaceMode,
  isWriterWorkspaceMode,
} from "./schema.ts";

export class SubagentConfigStoreError extends Schema.TaggedError<
  SubagentConfigStoreError,
  { readonly brand: unique symbol }
>()("SubagentConfigStoreError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}

/** The document changed after the caller inspected it; the caller may refresh and retry. */
export class SubagentConfigConflictError extends Schema.TaggedError<
  SubagentConfigConflictError,
  { readonly brand: unique symbol }
>()("SubagentConfigConflictError", { path: Schema.String, message: Schema.String }) {}

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
  readonly projectTrusted: boolean;
}

export interface SubagentProfilePatch extends SubagentConfigPatchBase {
  readonly profileSet: string;
  readonly profile: ProfileId;
  readonly route?: DeclaredProfileRoute | undefined;
}

export interface SubagentProfileRestorePatch extends SubagentConfigPatchBase {
  readonly profileSet: string;
  readonly profile: ProfileId;
  readonly declaration?: JsonObject[string] | undefined;
}

export interface SubagentDefaultProfileSetPatch extends SubagentConfigPatchBase {
  readonly defaultProfileSet?: string | undefined;
}

export interface SubagentCreateProfileSetFromSnapshotPatch extends SubagentConfigPatchBase {
  readonly profileSet: string;
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
  readonly nesting?: SubagentNestingOverrides | undefined;
}

interface SubagentWriterWorkspacePatch extends SubagentConfigPatchBase {
  readonly writerWorkspaceMode?: WriterWorkspaceMode | undefined;
}

export interface SubagentDelegationPatch extends SubagentConfigPatchBase {
  readonly delegation?: DelegationMode | undefined;
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
) => Effect.Effect<A, SubagentConfigStoreError | SubagentConfigConflictError>;

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
  readonly patchDelegation: ConfigPatch<SubagentDelegationPatch>;
}

export class SubagentConfigStore extends Context.Service<
  SubagentConfigStore,
  SubagentConfigStoreContract
>()("pi-subagents/config/store/SubagentConfigStore") {}

const storeError = configDocumentErrorFactory(SubagentConfigStoreError, "Subagents");

const configError = (operation: string, path: string, message: string) =>
  SubagentConfigStoreError.make({ operation, path, message });

const unsupportedVersionError = (path: string) =>
  configError(
    "activate",
    path,
    `Subagents configuration must declare version ${SUBAGENT_CONFIG_VERSION} and use that version's route contract.`,
  );

const mutationError = (path: string, message: string) => configError("update", path, message);

const conflictError = (path: string) =>
  SubagentConfigConflictError.make({
    path,
    message: "Subagents settings changed on disk; reopen /subagents profiles and try again.",
  });

const trustError = (path: string) =>
  mutationError(path, "Project subagent settings require a trusted project.");

/** Only an unsupported version fails activation; invalid fields degrade with diagnostics. */
const decodeDocument = (
  raw: JsonObject,
  scope: SubagentConfigScope,
  path: string,
): Effect.Effect<DecodedSubagentConfig, SubagentConfigStoreError> => {
  const decoded = subagentConfigDecoder(scope)(raw);
  return decoded.unsupportedVersion
    ? Effect.fail(unsupportedVersionError(path))
    : Effect.succeed(decoded);
};

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
    const captured = captureProfilePatchRoute(patch.route);
    if (!captured) return yield* mutationError(path, "Invalid profile route.");
    const { route } = captured;
    const sets = { ...currentProfileSets(current) };
    const setValue = sets[patch.profileSet];
    if (!isRecord(setValue)) {
      if (route === undefined) return current;
      return yield* mutationError(path, "The selected profile set does not exist.");
    }
    sets[patch.profileSet] = {
      profiles: withEntry(setValue.profiles, patch.profile, route && routeJson(route)),
    };
    return { ...current, profileSets: sets };
  },
);

const applyProfileRestore: ApplyPatch<SubagentProfileRestorePatch> = Effect.fnUntraced(
  function* (current, patch, path) {
    if (!isProfileSetName(patch.profileSet) || !isProfileId(patch.profile))
      return yield* mutationError(path, "Invalid profile restore target.");
    const captured = captureRestoreDeclaration(patch.declaration);
    if (!captured)
      return yield* mutationError(
        path,
        "The opening profile declaration cannot be restored safely.",
      );
    const sets = { ...currentProfileSets(current) };
    const selected = sets[patch.profileSet];
    if (!Object.hasOwn(sets, patch.profileSet) || !isRecord(selected))
      return yield* mutationError(path, "The selected profile set does not exist.");
    if (Object.hasOwn(selected, "profiles") && !isRecord(selected.profiles))
      return yield* mutationError(path, "The selected profiles container is invalid.");
    sets[patch.profileSet] = {
      ...selected,
      profiles: withEntry(selected.profiles, patch.profile, captured.declaration),
    };
    return { ...current, profileSets: sets };
  },
);

const applyDefaultProfileSetPatch: ApplyPatch<SubagentDefaultProfileSetPatch> = Effect.fnUntraced(
  function* (current, patch, path) {
    const name = patch.defaultProfileSet;
    if (name === undefined) return withEntry(current, "defaultProfileSet", undefined);
    if (!isProfileSetName(name)) return yield* mutationError(path, "Invalid profile-set name.");
    const sets = currentProfileSets(current);
    if (!Object.hasOwn(sets, name) || !isRecord(sets[name]))
      return yield* mutationError(path, "The selected profile set does not exist.");
    const decoded = subagentConfigDecoder("update")(current);
    if (!decoded.file.profileSets?.[name])
      return yield* mutationError(path, "The selected profile set is structurally invalid.");
    if (decoded.invalidProfileSetRoutes[name])
      return yield* mutationError(
        path,
        "The selected profile set contains an invalid profile route.",
      );
    return withEntry(current, "defaultProfileSet", name);
  },
);

const snapshotProfilesJson = (
  routes: Readonly<Record<ProfileId, ProfileRoute>>,
  path: string,
): Effect.Effect<JsonObject, SubagentConfigStoreError> => {
  const invalidRoute = mutationError(
    path,
    "The session snapshot contains an invalid profile route.",
  );
  const keys = Object.keys(routes);
  if (keys.length !== PROFILE_IDS.length || !keys.every(isProfileId))
    return Effect.fail(
      mutationError(path, "A session snapshot must contain exactly all seven profiles."),
    );
  const profiles: JsonObject = {};
  for (const profile of PROFILE_IDS) {
    const route = decodeProfileRoute(routes[profile]);
    if (!route) return Effect.fail(invalidRoute);
    profiles[profile] =
      route.candidates.length === 0
        ? "disabled"
        : route.candidates.map((candidate) => candidateJson(candidate));
  }
  return Effect.succeed(profiles);
};

const insertProfileSet = Effect.fnUntraced(function* (
  current: JsonObject,
  name: string,
  path: string,
  set: Effect.Effect<JsonObject, SubagentConfigStoreError>,
) {
  const sets = { ...currentProfileSets(current) };
  if (Object.hasOwn(sets, name))
    return yield* mutationError(path, "A profile set with that name exists.");
  const value = yield* set;
  if (Object.keys(sets).length >= MAX_PROFILE_SETS)
    return yield* mutationError(
      path,
      `A document may contain at most ${MAX_PROFILE_SETS} profile sets.`,
    );
  sets[name] = value;
  return { ...current, profileSets: sets };
});

const applyCreateProfileSetFromSnapshot: ApplyPatch<SubagentCreateProfileSetFromSnapshotPatch> =
  Effect.fnUntraced(function* (current, patch, path) {
    if (!isProfileSetName(patch.profileSet))
      return yield* mutationError(path, "Invalid profile-set name.");
    const profiles = yield* snapshotProfilesJson(patch.profiles, path);
    return yield* insertProfileSet(current, patch.profileSet, path, Effect.succeed({ profiles }));
  });

const applyCopyProfileSet: ApplyPatch<SubagentCopyProfileSetPatch> = Effect.fnUntraced(
  function* (current, patch, path) {
    if (!isProfileSetName(patch.sourceProfileSet) || !isProfileSetName(patch.profileSet))
      return yield* mutationError(path, "Invalid profile-set name.");
    const source = currentProfileSets(current)[patch.sourceProfileSet];
    return yield* insertProfileSet(
      current,
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
    const sets = { ...currentProfileSets(current) };
    const source = sets[patch.profileSet];
    if (!isRecord(source))
      return yield* mutationError(path, "The selected profile set does not exist.");
    if (patch.profileSet === patch.nextProfileSet) return current;
    if (Object.hasOwn(sets, patch.nextProfileSet))
      return yield* mutationError(path, "A profile set with that name exists.");
    delete sets[patch.profileSet];
    sets[patch.nextProfileSet] = source;
    return {
      ...current,
      profileSets: sets,
      ...(current.defaultProfileSet === patch.profileSet && {
        defaultProfileSet: patch.nextProfileSet,
      }),
    };
  },
);

const applyDeleteProfileSet: ApplyPatch<SubagentDeleteProfileSetPatch> = Effect.fnUntraced(
  function* (current, patch, path) {
    if (!isProfileSetName(patch.profileSet))
      return yield* mutationError(path, "Invalid profile-set name.");
    if (current.defaultProfileSet === patch.profileSet)
      return yield* mutationError(
        path,
        "Choose another default profile set or inherit before deleting it.",
      );
    const sets = currentProfileSets(current);
    if (!Object.hasOwn(sets, patch.profileSet)) return current;
    const remaining = withEntry(sets, patch.profileSet, undefined);
    return withEntry(
      current,
      "profileSets",
      Object.keys(remaining).length === 0 ? undefined : remaining,
    );
  },
);

const applyNestingPatch: ApplyPatch<SubagentNestingPatch> = Effect.fnUntraced(
  function* (current, patch, path) {
    const nesting =
      patch.nesting === undefined ? undefined : decodeSubagentNestingOverrides(patch.nesting);
    if (patch.nesting !== undefined && !nesting)
      return yield* mutationError(path, "Invalid nesting policy.");
    return withEntry(
      current,
      "nesting",
      nesting && Object.keys(nesting).length > 0 ? { ...nesting } : undefined,
    );
  },
);

const applyWriterWorkspacePatch: ApplyPatch<SubagentWriterWorkspacePatch> = Effect.fnUntraced(
  function* (current, patch, path) {
    const mode = patch.writerWorkspaceMode;
    if (mode !== undefined && !isWriterWorkspaceMode(mode))
      return yield* mutationError(path, "Invalid writer workspace mode.");
    return withEntry(current, "writerWorkspaceMode", mode);
  },
);

const applyDelegationPatch: ApplyPatch<SubagentDelegationPatch> = Effect.fnUntraced(
  function* (current, patch, path) {
    const mode = patch.delegation;
    if (mode !== undefined && !isDelegationMode(mode))
      return yield* mutationError(path, "Invalid delegation mode.");
    return withEntry(current, "delegation", mode);
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
    ): ConfigPatch<Patch> => Fn.flow(patchWithReceipt(apply), (receipt) => Effect.asVoid(receipt));

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
      patchDelegation: patchVoid(applyDelegationPatch),
    });
  }),
);
