import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import type {
  JsonDocumentModification,
  JsonObject,
  JsonDocumentStore,
} from "../platform/json-document.ts";
import {
  modifyJsonObject,
  readConfigOrWarn,
  readOptionalJsonObject,
  readRawJsonObject,
  writeJsonObject,
  type ConfigDocumentErrorFactory,
} from "./document-ops.ts";
import {
  scopedDocumentPaths,
  selectScopedDocument,
  type ScopedDocumentPaths,
} from "./scoped-store.ts";

/** Scope metadata shared by every resolved scoped configuration. */
export interface ScopedConfigMetadata {
  readonly configPath: string;
  readonly projectConfigPath: string;
  readonly globalConfigPath: string;
  readonly projectConfigExists: boolean;
  readonly globalConfigExists: boolean;
}

export interface ScopedConfigStoreOptions<File, Resolved extends ScopedConfigMetadata, E> {
  /** Maps document failures onto the package's tagged configuration error. */
  readonly errorFactory: ConfigDocumentErrorFactory<E>;
  /** Human-readable label used in read warnings, e.g. "Better OpenAI". */
  readonly label: string;
  /** Span prefix for the store's Effect.fn names, e.g. "OpenAIConfig". */
  readonly spanPrefix: string;
  /** Project-level configuration directory, e.g. the host agent's config dir name. */
  readonly projectConfigDirectory: string;
  /** Document basename shared by the project and global scopes. */
  readonly basename: string;
  /** Overrides the "extensions" segment of the scoped document paths. */
  readonly extensionsDirectory?: string;
  /** Tolerant wire decode of a raw document into the package's config file shape. */
  readonly decode: (value: JsonObject) => File;
  /** Document seeded into the global scope when neither scope exists yet. */
  readonly defaultDocument: () => JsonObject;
  /** Overlays project over global over package defaults into the resolved config. */
  readonly resolve: (
    metadata: ScopedConfigMetadata,
    project: File | undefined,
    global: File | undefined,
  ) => Resolved;
}

export interface ScopedConfigStore<File, Resolved extends ScopedConfigMetadata, E> {
  readonly configPaths: (
    cwd: string,
    agentDir: string,
  ) => Effect.Effect<ScopedDocumentPaths, never, Path.Path>;
  readonly readRawConfig: (path: string) => Effect.Effect<JsonObject, E, JsonDocumentStore>;
  readonly readConfig: (path: string) => Effect.Effect<File | undefined, E, JsonDocumentStore>;
  readonly writeConfig: (
    path: string,
    config: JsonObject,
  ) => Effect.Effect<void, E, JsonDocumentStore>;
  readonly modifyConfig: <A, AfterCommitR = never>(
    path: string,
    modify: (document: JsonObject) => JsonDocumentModification<A, AfterCommitR>,
  ) => Effect.Effect<A, E, JsonDocumentStore | AfterCommitR>;
  readonly resolveConfig: (
    cwd: string,
    agentDir: string,
    projectTrusted?: boolean,
  ) => Effect.Effect<Resolved, E, JsonDocumentStore | Path.Path>;
  /** Resolves the exact document returned by an atomic commit without post-commit I/O. */
  readonly resolveCommittedConfig: (
    current: Resolved,
    committed: JsonObject,
    globalFallback: JsonObject | undefined,
  ) => Resolved;
}

/**
 * Builds the standard project/global scoped configuration store: path resolution, tolerant reads,
 * atomic writes, and layered resolution that seeds the global document when neither scope exists,
 * warns (rather than fails) on unreadable documents, and overlays project over global.
 */
export const makeScopedConfigStore = <File, Resolved extends ScopedConfigMetadata, E>(
  options: ScopedConfigStoreOptions<File, Resolved, E>,
): ScopedConfigStore<File, Resolved, E> => {
  const { basename, decode, defaultDocument, errorFactory, resolve, spanPrefix } = options;

  const configPaths = Effect.fn(`${spanPrefix}.configPaths`)(function* (
    cwd: string,
    agentDir: string,
  ) {
    return yield* scopedDocumentPaths(cwd, agentDir, {
      projectConfigDirectory: options.projectConfigDirectory,
      basename,
      ...(options.extensionsDirectory === undefined
        ? {}
        : { extensionsDirectory: options.extensionsDirectory }),
    });
  });

  const readRawConfig = Effect.fn(`${spanPrefix}.readRawConfig`)(function* (path: string) {
    return yield* readRawJsonObject(path, errorFactory);
  });

  const readConfig = Effect.fn(`${spanPrefix}.readConfig`)(function* (path: string) {
    return yield* readOptionalJsonObject(path, decode, errorFactory);
  });

  const writeConfig = Effect.fn(`${spanPrefix}.writeConfig`)(function* (
    path: string,
    config: JsonObject,
  ) {
    yield* writeJsonObject(path, config, errorFactory);
  });

  const modifyConfig = Effect.fn(`${spanPrefix}.modifyConfig`)(function* <A, AfterCommitR>(
    path: string,
    modify: (document: JsonObject) => JsonDocumentModification<A, AfterCommitR>,
  ) {
    return yield* modifyJsonObject(path, modify, errorFactory);
  });

  const warning = `Unable to read a ${options.label} configuration document.`;

  const resolveConfig = Effect.fn(`${spanPrefix}.resolveConfig`)(function* (
    cwd: string,
    agentDir: string,
    projectTrusted = true,
  ) {
    const paths = yield* configPaths(cwd, agentDir);
    const selected = yield* selectScopedDocument(paths).pipe(
      Effect.mapError((error) => errorFactory("inspect", error.path)()),
    );
    const projectExists = projectTrusted && selected.projectExists;
    let globalExists = selected.globalExists;
    if (!projectExists && !globalExists) {
      yield* writeConfig(paths.global, defaultDocument());
      globalExists = true;
    }
    const [project, global] = yield* Effect.all(
      [
        readConfigOrWarn(paths.project, projectExists, readConfig, warning),
        readConfigOrWarn(paths.global, globalExists, readConfig, warning),
      ] as const,
      { concurrency: 2 },
    );
    return resolve(
      {
        configPath: projectExists ? paths.project : paths.global,
        projectConfigPath: paths.project,
        globalConfigPath: paths.global,
        projectConfigExists: projectExists,
        globalConfigExists: globalExists,
      },
      project,
      global,
    );
  });

  const resolveCommittedConfig = (
    current: Resolved,
    committed: JsonObject,
    globalFallback: JsonObject | undefined,
  ): Resolved => {
    const metadata: ScopedConfigMetadata = {
      configPath: current.configPath,
      projectConfigPath: current.projectConfigPath,
      globalConfigPath: current.globalConfigPath,
      projectConfigExists: current.projectConfigExists,
      globalConfigExists: current.globalConfigExists,
    };
    if (current.configPath === current.projectConfigPath) {
      return resolve(
        metadata,
        decode(committed),
        globalFallback === undefined ? undefined : decode(globalFallback),
      );
    }
    return resolve(metadata, undefined, decode(committed));
  };

  return {
    configPaths,
    readRawConfig,
    readConfig,
    writeConfig,
    modifyConfig,
    resolveConfig,
    resolveCommittedConfig,
  };
};
