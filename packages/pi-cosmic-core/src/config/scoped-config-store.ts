import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import {
  type JsonDocumentModification,
  type JsonObject,
  JsonDocumentStore,
} from "../platform/json-document.ts";
import {
  readConfigOrWarn,
  readOptionalJsonObject,
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
  /**
   * Document seeded into the global scope when neither scope exists yet. When omitted,
   * resolution never writes: both scopes simply resolve as absent with package defaults.
   */
  readonly defaultDocument?: () => JsonObject;
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
  /**
   * Resolves the exact document returned by an atomic commit without post-commit I/O.
   *
   * `fallback` is the other scope's raw document captured before the commit (the global
   * document for a project commit, the project document for a global commit). It affects only
   * the decoded overlay, never existence metadata. The committed scope becomes present, the
   * other existence flag is preserved, and project existence selects the preferred path.
   * When `committedScope` is omitted it is derived from `current.configPath`, which matches
   * callers that always commit to the preferred scope.
   */
  readonly resolveCommittedConfig: (
    current: Resolved,
    committed: JsonObject,
    fallback: JsonObject | undefined,
    committedScope?: "project" | "global",
  ) => Resolved;
}

/**
 * Builds the standard project/global scoped configuration store: path resolution, tolerant reads,
 * atomic writes, and layered resolution that seeds the global document when neither scope exists
 * (only when `defaultDocument` is supplied), warns (rather than fails) on unreadable documents,
 * and overlays project over global.
 */
export const makeScopedConfigStore = <File, Resolved extends ScopedConfigMetadata, E>(
  options: ScopedConfigStoreOptions<File, Resolved, E>,
): ScopedConfigStore<File, Resolved, E> => {
  const { basename, decode, defaultDocument, errorFactory, resolve, spanPrefix } = options;

  const configPaths = Effect.fn(`${spanPrefix}.configPaths`)((cwd: string, agentDir: string) =>
    scopedDocumentPaths(cwd, agentDir, {
      basename,
      projectConfigDirectory: options.projectConfigDirectory,
      ...(options.extensionsDirectory !== undefined && {
        extensionsDirectory: options.extensionsDirectory,
      }),
    }),
  );

  const readRawConfig = Effect.fn(`${spanPrefix}.readRawConfig`)((path: string) =>
    JsonDocumentStore.use((documents) =>
      documents.readObject(path).pipe(
        Effect.mapError(errorFactory("read", path)),
        Effect.map((value) => value ?? {}),
      ),
    ),
  );

  const readConfig = Effect.fn(`${spanPrefix}.readConfig`)((path: string) =>
    readOptionalJsonObject(path, decode, errorFactory),
  );

  const writeConfig = Effect.fn(`${spanPrefix}.writeConfig`)((path: string, config: JsonObject) =>
    JsonDocumentStore.use((documents) =>
      documents.writeObject(path, config).pipe(Effect.mapError(errorFactory("write", path))),
    ),
  );

  const modifyConfig = Effect.fn(`${spanPrefix}.modifyConfig`)(
    <A, AfterCommitR>(
      path: string,
      modify: (document: JsonObject) => JsonDocumentModification<A, AfterCommitR>,
    ) =>
      JsonDocumentStore.use((documents) => {
        const modifyObject = documents.modifyObject;
        if (modifyObject === undefined) {
          return Effect.fail(errorFactory("write", path)());
        }
        return modifyObject(path, (document) =>
          Effect.try({
            try: () => modify(document),
            catch: errorFactory("write", path),
          }),
        ).pipe(Effect.mapError(errorFactory("write", path)));
      }),
  );

  const warning = `Unable to read a ${options.label} configuration document.`;

  const resolveConfig = Effect.fn(`${spanPrefix}.resolveConfig`)(function* (
    cwd: string,
    agentDir: string,
    projectTrusted = false,
  ) {
    const paths = yield* configPaths(cwd, agentDir);
    const trusted = projectTrusted === true;
    // Untrusted projects perform no project-document I/O at all: the path stays inert metadata.
    const selected = yield* selectScopedDocument(paths, { probeProject: trusted }).pipe(
      Effect.mapError((error) => errorFactory("inspect", error.path)()),
    );
    const projectExists = trusted && selected.projectExists;
    let globalExists = selected.globalExists;
    if (!projectExists && !globalExists && defaultDocument !== undefined) {
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
    fallback: JsonObject | undefined,
    committedScope?: "project" | "global",
  ): Resolved => {
    const scope =
      committedScope ?? (current.configPath === current.projectConfigPath ? "project" : "global");
    const projectConfigExists = scope === "project" ? true : current.projectConfigExists;
    const globalConfigExists = scope === "global" ? true : current.globalConfigExists;
    const metadata: ScopedConfigMetadata = {
      configPath: projectConfigExists ? current.projectConfigPath : current.globalConfigPath,
      projectConfigPath: current.projectConfigPath,
      globalConfigPath: current.globalConfigPath,
      projectConfigExists,
      globalConfigExists,
    };
    if (scope === "project") {
      return resolve(
        metadata,
        decode(committed),
        fallback === undefined ? undefined : decode(fallback),
      );
    }
    return resolve(
      metadata,
      fallback === undefined ? undefined : decode(fallback),
      decode(committed),
    );
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
