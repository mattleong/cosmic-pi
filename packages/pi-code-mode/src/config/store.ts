/** The single Code Mode configuration persistence door: scoped reads, writes, and resolution. */
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  decodeTolerantFields,
  makeConfigDocumentErrorFactory,
  makeFrozenProjection,
  makeScopedConfigStore,
  AgentDirectory,
  JsonDocumentStore,
  type JsonObject,
  type ProjectionError,
  type ScopedConfigMetadata,
  type TolerantFieldDiagnostic,
} from "pi-cosmic-core";
import {
  findCodeModeSettingDescriptor,
  resolveCodeModeConfig,
  type CodeModeProvenance,
  type CodeModeSettingScope,
  type InvalidCodeModeSettingError,
} from "./options.ts";
import {
  CODE_MODE_CONFIG_BASENAME,
  CODE_MODE_FIELD_SCHEMAS,
  type CodeModeConfig,
} from "./schema.ts";

export class CodeModeConfigError extends Schema.TaggedError<CodeModeConfigError>()(
  "CodeModeConfigError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

/** Project-scope reads and writes are refused entirely while the project is untrusted. */
export class CodeModeUntrustedScopeError extends Schema.TaggedError<CodeModeUntrustedScopeError>()(
  "CodeModeUntrustedScopeError",
  { message: Schema.String },
) {}

export type CodeModeSettingsError =
  | CodeModeConfigError
  | CodeModeUntrustedScopeError
  | InvalidCodeModeSettingError;

const mapDocumentError = makeConfigDocumentErrorFactory(CodeModeConfigError, "Code Mode");

const MAX_DIAGNOSTICS = 32;

interface CodeModeConfigFile {
  readonly values: Partial<CodeModeConfig>;
  readonly diagnostics: readonly TolerantFieldDiagnostic[];
}

function decodeConfigFile(value: JsonObject): CodeModeConfigFile {
  const decoded = decodeTolerantFields(value, CODE_MODE_FIELD_SCHEMAS, { path: "config" });
  return { values: decoded.value, diagnostics: decoded.diagnostics };
}

interface ResolvedCodeModeDocuments extends ScopedConfigMetadata {
  readonly config: CodeModeConfig;
  readonly provenance: CodeModeProvenance;
  readonly globalValues: Partial<CodeModeConfig>;
  readonly projectValues: Partial<CodeModeConfig>;
  readonly diagnostics: readonly TolerantFieldDiagnostic[];
}

const scopeDiagnostics = (
  scope: CodeModeSettingScope,
  file: CodeModeConfigFile | undefined,
): readonly TolerantFieldDiagnostic[] =>
  (file?.diagnostics ?? []).map((diagnostic) => ({
    ...diagnostic,
    path: `${scope}.${diagnostic.path}`,
  }));

const store = makeScopedConfigStore({
  errorFactory: mapDocumentError,
  label: "Code Mode",
  spanPrefix: "CodeModeConfig",
  projectConfigDirectory: CONFIG_DIR_NAME,
  basename: CODE_MODE_CONFIG_BASENAME,
  decode: decodeConfigFile,
  defaultDocument: (): JsonObject => ({}),
  resolve: (
    metadata: ScopedConfigMetadata,
    project: CodeModeConfigFile | undefined,
    global: CodeModeConfigFile | undefined,
  ): ResolvedCodeModeDocuments => {
    const resolution = resolveCodeModeConfig(global?.values, project?.values);
    return {
      ...metadata,
      config: resolution.config,
      provenance: resolution.provenance,
      globalValues: global?.values ?? {},
      projectValues: project?.values ?? {},
      diagnostics: [
        ...scopeDiagnostics("global", global),
        ...scopeDiagnostics("project", project),
      ].slice(0, MAX_DIAGNOSTICS),
    };
  },
});

/** Immutable, plain-data resolved configuration published after every persisted change. */
export interface CodeModeState {
  readonly projectTrusted: boolean;
  /** Availability for the future `code_mode` tool: trusted project AND `enabled`. */
  readonly available: boolean;
  readonly config: CodeModeConfig;
  readonly provenance: CodeModeProvenance;
  readonly globalValues: Partial<CodeModeConfig>;
  readonly projectValues: Partial<CodeModeConfig>;
  /** Bounded, path-only decode diagnostics (never raw values). */
  readonly diagnostics: readonly TolerantFieldDiagnostic[];
  readonly globalConfigPath: string;
  readonly projectConfigPath: string;
}

export interface CodeModeConfigStoreOptions {
  readonly cwd: string;
  readonly projectTrusted: boolean;
  /** Boundary snapshot publication; receives deeply frozen plain data. */
  readonly publish?: (state: CodeModeState) => void;
}

export interface CodeModeConfigStoreContract {
  readonly state: Effect.Effect<CodeModeState>;
  readonly snapshot: () => CodeModeState;
  readonly setSetting: (
    scope: CodeModeSettingScope,
    id: string,
    rawValue: string,
  ) => Effect.Effect<CodeModeState, CodeModeSettingsError>;
  readonly clearSetting: (
    scope: CodeModeSettingScope,
    id: string,
  ) => Effect.Effect<CodeModeState, CodeModeSettingsError>;
}

const toState = (resolved: ResolvedCodeModeDocuments, projectTrusted: boolean): CodeModeState => ({
  projectTrusted,
  available: projectTrusted && resolved.config.enabled,
  config: resolved.config,
  provenance: resolved.provenance,
  globalValues: resolved.globalValues,
  projectValues: resolved.projectValues,
  diagnostics: resolved.diagnostics,
  globalConfigPath: resolved.globalConfigPath,
  projectConfigPath: resolved.projectConfigPath,
});

const requireDescriptor = (id: string) => {
  const descriptor = findCodeModeSettingDescriptor(id);
  return descriptor === undefined
    ? Effect.fail(
        new CodeModeConfigError({
          operation: "setting",
          path: id,
          message: `Unknown Code Mode setting: ${id}.`,
        }),
      )
    : Effect.succeed(descriptor);
};

/** Pre-commit snapshot of the scope that is not being committed. */
interface OtherScopeDocument {
  readonly exists: boolean;
  readonly raw: JsonObject | undefined;
}

const ABSENT_OTHER_SCOPE: OtherScopeDocument = { exists: false, raw: undefined };

export class CodeModeConfigStore extends Context.Service<
  CodeModeConfigStore,
  CodeModeConfigStoreContract
>()("pi-code-mode/config/store/CodeModeConfigStore") {
  static readonly layer = (options: CodeModeConfigStoreOptions) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const agentDirectory = yield* AgentDirectory;
        const documents = yield* JsonDocumentStore;
        const path = yield* Path.Path;
        const provideDependencies = <A, E>(
          effect: Effect.Effect<A, E, JsonDocumentStore | Path.Path>,
        ) =>
          effect.pipe(
            Effect.provideService(JsonDocumentStore, documents),
            Effect.provideService(Path.Path, path),
          );

        const initial = yield* provideDependencies(
          store.resolveConfig(options.cwd, agentDirectory, options.projectTrusted),
        );
        const projection = yield* makeFrozenProjection(
          initial,
          (resolved: ResolvedCodeModeDocuments) => toState(resolved, options.projectTrusted),
          options.publish,
        );
        const settingUpdates = yield* Semaphore.make(1);

        const guardScope = (scope: CodeModeSettingScope) =>
          scope === "project" && !options.projectTrusted
            ? Effect.fail(
                new CodeModeUntrustedScopeError({
                  message:
                    "Project settings are unavailable until this project is trusted; Code Mode stays unavailable here.",
                }),
              )
            : Effect.void;

        /**
         * Best-effort pre-commit read of the other scope's raw document. An unreadable
         * document degrades to its previously known existence with no values, matching the
         * tolerant read policy of `resolveConfig`; it never blocks a settings write.
         */
        const readOtherScope = (
          otherPath: string,
          existedBefore: boolean,
        ): Effect.Effect<OtherScopeDocument> =>
          documents.readObject(otherPath).pipe(
            Effect.map(
              (raw): OtherScopeDocument =>
                raw === undefined ? ABSENT_OTHER_SCOPE : { exists: true, raw },
            ),
            Effect.catch(() =>
              Effect.logWarning("Unable to read a Code Mode configuration document.").pipe(
                Effect.map((): OtherScopeDocument => ({ exists: existedBefore, raw: undefined })),
              ),
            ),
          );

        /**
         * Deterministically resolves the exact committed document plus the pre-commit
         * other-scope snapshot into the next authoritative state — no post-commit I/O.
         * Committing a scope makes its document exist; existence decides the preferred path.
         */
        const resolveCommittedDocuments = (
          current: ResolvedCodeModeDocuments,
          scope: CodeModeSettingScope,
          committed: JsonObject,
          other: OtherScopeDocument,
        ): ResolvedCodeModeDocuments => {
          const projectConfigExists = scope === "project" ? true : other.exists;
          const globalConfigExists = scope === "global" ? true : other.exists;
          const metadata: ScopedConfigMetadata = {
            configPath: projectConfigExists ? current.projectConfigPath : current.globalConfigPath,
            projectConfigPath: current.projectConfigPath,
            globalConfigPath: current.globalConfigPath,
            projectConfigExists,
            globalConfigExists,
          };
          return store.resolveCommittedConfig(
            { ...current, ...metadata },
            committed,
            other.raw,
            scope,
          );
        };

        /**
         * One serialized settings commit. The committed JSON document and the authoritative
         * projection publication happen inside the document store's narrow uninterruptible
         * `afterCommit` region: interruption can never observe the renamed document without
         * the matching published state. A publication failure (hostile publish callback or
         * non-plain data) surfaces as a typed `CodeModeConfigError` with operation
         * `"publish"`: the document stays committed on disk, the previously published
         * snapshot remains authoritative, and no stale snapshot is silently published.
         */
        const applyChange = (
          scope: CodeModeSettingScope,
          mutate: (document: JsonObject) => JsonObject,
        ): Effect.Effect<CodeModeState, CodeModeSettingsError> =>
          settingUpdates.withPermit(
            Effect.gen(function* () {
              const current = yield* projection.getState;
              const targetPath =
                scope === "project" ? current.projectConfigPath : current.globalConfigPath;
              const other =
                scope === "project"
                  ? yield* readOtherScope(current.globalConfigPath, current.globalConfigExists)
                  : options.projectTrusted
                    ? yield* readOtherScope(current.projectConfigPath, current.projectConfigExists)
                    : ABSENT_OTHER_SCOPE;
              const publishFailure = MutableRef.make<ProjectionError | undefined>(undefined);
              yield* provideDependencies(
                store.modifyConfig(targetPath, (document) => {
                  const committed = mutate(document);
                  const next = resolveCommittedDocuments(current, scope, committed, other);
                  return {
                    value: undefined,
                    document: committed,
                    afterCommit: projection
                      .transition(() => Effect.succeed([undefined, next] as const))
                      .pipe(
                        Effect.catch((error) =>
                          Effect.sync(() => MutableRef.set(publishFailure, error)),
                        ),
                      ),
                  };
                }),
              );
              const failure = MutableRef.get(publishFailure);
              if (failure !== undefined) {
                return yield* new CodeModeConfigError({
                  operation: "publish",
                  path: failure.path,
                  message: failure.message,
                });
              }
              return projection.getSnapshot();
            }),
          );

        const setSetting: CodeModeConfigStoreContract["setSetting"] = (scope, id, rawValue) =>
          Effect.gen(function* () {
            yield* guardScope(scope);
            const descriptor = yield* requireDescriptor(id);
            const value = yield* descriptor.decode(rawValue);
            return yield* applyChange(scope, (document) => ({
              ...document,
              [descriptor.id]: value,
            }));
          });

        const clearSetting: CodeModeConfigStoreContract["clearSetting"] = (scope, id) =>
          Effect.gen(function* () {
            yield* guardScope(scope);
            const descriptor = yield* requireDescriptor(id);
            return yield* applyChange(scope, (document) => {
              const next = { ...document };
              delete next[descriptor.id];
              return next;
            });
          });

        return CodeModeConfigStore.of({
          // The frozen snapshot and the authoritative state project the same plain data;
          // exposing the frozen clone keeps every published value immutable.
          state: Effect.sync(() => projection.getSnapshot()),
          snapshot: projection.getSnapshot,
          setSetting,
          clearSetting,
        });
      }),
    );
}
