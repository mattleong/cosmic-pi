import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import {
  type JsonDocumentModification,
  type JsonObject,
  JsonDocumentStore,
} from "../platform/json-document.ts";
import type { ConfigDocumentErrorFactory } from "./document-ops.ts";

/** Project and global locations of one extension configuration document. */
export interface ScopedDocumentPaths {
  readonly project: string;
  readonly global: string;
}

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
   * The committed scope is the one `current.configPath` names: callers always commit to the
   * preferred scope.
   */
  readonly resolveCommittedConfig: (
    current: Resolved,
    committed: JsonObject,
    fallback: JsonObject | undefined,
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
  const { decode, defaultDocument, errorFactory, resolve, spanPrefix } = options;

  const configPaths = Effect.fn(`${spanPrefix}.configPaths`)((cwd: string, agentDir: string) =>
    Path.Path.useSync(
      (path): ScopedDocumentPaths => ({
        project: path.join(cwd, options.projectConfigDirectory, "extensions", options.basename),
        global: path.join(agentDir, "extensions", options.basename),
      }),
    ),
  );

  const readObject = (path: string) =>
    JsonDocumentStore.use((documents) =>
      documents.readObject(path).pipe(Effect.mapError(errorFactory("read", path))),
    );

  const readRawConfig = Effect.fn(`${spanPrefix}.readRawConfig`)((path: string) =>
    readObject(path).pipe(Effect.map((value) => value ?? {})),
  );

  const readConfig = Effect.fn(`${spanPrefix}.readConfig`)((path: string) =>
    readObject(path).pipe(Effect.map((raw) => (raw === undefined ? undefined : decode(raw)))),
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
      JsonDocumentStore.use((documents) =>
        documents
          .modifyObject(path, (document) =>
            Effect.try({ try: () => modify(document), catch: errorFactory("write", path) }),
          )
          .pipe(Effect.mapError(errorFactory("write", path))),
      ),
  );

  const exists = (path: string) =>
    JsonDocumentStore.use((documents) =>
      documents.exists(path).pipe(Effect.mapError(errorFactory("inspect", path))),
    );

  const warning = `Unable to read a ${options.label} configuration document.`;
  // An existing but unreadable document keeps its scope selection and contributes no values.
  const readIfPresent = (path: string, present: boolean) =>
    present
      ? readConfig(path).pipe(
          Effect.catch(() => Effect.logWarning(warning).pipe(Effect.as(undefined))),
        )
      : Effect.undefined;

  const resolveConfig = Effect.fn(`${spanPrefix}.resolveConfig`)(function* (
    cwd: string,
    agentDir: string,
    projectTrusted = false,
  ) {
    const paths = yield* configPaths(cwd, agentDir);
    // Untrusted projects get no project exists or read call: the path stays inert metadata.
    // Existence alone decides precedence, so a malformed project document still wins configPath.
    const [projectExists, globalFound] = yield* Effect.all(
      [
        projectTrusted === true ? exists(paths.project) : Effect.succeed(false),
        exists(paths.global),
      ],
      { concurrency: 2 },
    );
    let globalExists = globalFound;
    if (!projectExists && !globalExists && defaultDocument !== undefined) {
      yield* writeConfig(paths.global, defaultDocument());
      globalExists = true;
    }
    const [project, global] = yield* Effect.all(
      [readIfPresent(paths.project, projectExists), readIfPresent(paths.global, globalExists)],
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
  ): Resolved => {
    const project = current.configPath === current.projectConfigPath;
    const projectConfigExists = project || current.projectConfigExists;
    const metadata: ScopedConfigMetadata = {
      configPath: projectConfigExists ? current.projectConfigPath : current.globalConfigPath,
      projectConfigPath: current.projectConfigPath,
      globalConfigPath: current.globalConfigPath,
      projectConfigExists,
      globalConfigExists: !project || current.globalConfigExists,
    };
    const committedFile = decode(committed);
    const fallbackFile = fallback === undefined ? undefined : decode(fallback);
    return project
      ? resolve(metadata, committedFile, fallbackFile)
      : resolve(metadata, fallbackFile, committedFile);
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
