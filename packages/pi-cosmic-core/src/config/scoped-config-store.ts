import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import {
  type JsonDocumentModification,
  type JsonObject,
  JsonDocumentStore,
} from "../platform/json-document.ts";
import {
  configDocumentErrorFactory,
  type ConfigDocumentErrorClass,
  type ConfigDocumentErrorFactory,
} from "./document-ops.ts";

interface ScopedDocumentPaths {
  readonly project: string;
  readonly global: string;
}

export interface ScopedConfigMetadata {
  readonly configPath: string;
  readonly projectConfigPath: string;
  readonly globalConfigPath: string;
  readonly projectConfigExists: boolean;
  readonly globalConfigExists: boolean;
}

export interface ScopedConfigStoreOptions<File, Resolved extends ScopedConfigMetadata, E> {
  readonly error: ConfigDocumentErrorClass<E>;
  readonly label: string;
  readonly spanPrefix: string;
  readonly projectConfigDirectory: string;
  readonly basename: string;
  readonly decode: (value: JsonObject) => File;
  readonly defaultDocument?: () => JsonObject;
  readonly resolve: (
    metadata: ScopedConfigMetadata,
    project: File | undefined,
    global: File | undefined,
  ) => Resolved;
}

export interface ScopedConfigStore<File, Resolved extends ScopedConfigMetadata, E> {
  readonly errorFactory: ConfigDocumentErrorFactory<E>;
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
  readonly resolveCommittedConfig: (
    current: Resolved,
    committed: JsonObject,
    fallback: JsonObject | undefined,
  ) => Resolved;
}

export const makeScopedConfigStore = <File, Resolved extends ScopedConfigMetadata, E>(
  options: ScopedConfigStoreOptions<File, Resolved, E>,
): ScopedConfigStore<File, Resolved, E> => {
  const { decode, defaultDocument, resolve, spanPrefix } = options;
  const errorFactory = configDocumentErrorFactory(options.error, options.label);

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
    const [projectExists, globalFound] = yield* Effect.all(
      [
        projectTrusted === true ? exists(paths.project) : Effect.succeed(false),
        exists(paths.global),
      ],
      { concurrency: 2 },
    );
    let globalExists = globalFound;
    let globalReadable = globalFound;
    if (!projectExists && !globalExists && defaultDocument !== undefined) {
      globalReadable = yield* JsonDocumentStore.use((documents) =>
        documents
          .modifyObject(paths.global, (document) =>
            documents.exists(paths.global).pipe(
              Effect.map((present) => ({
                value: true,
                document: present ? document : defaultDocument(),
                write: !present,
              })),
            ),
          )
          .pipe(
            Effect.catchIf(
              (error) => error.operation === "read" || error.operation === "decode",
              () => Effect.logWarning(warning).pipe(Effect.as(false)),
            ),
            Effect.mapError((error) =>
              errorFactory(error.operation === "exists" ? "inspect" : "write", paths.global)(),
            ),
          ),
      );
      globalExists = globalReadable || (yield* exists(paths.global));
    }
    const [project, global] = yield* Effect.all(
      [readIfPresent(paths.project, projectExists), readIfPresent(paths.global, globalReadable)],
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
    errorFactory,
    configPaths,
    readRawConfig,
    readConfig,
    writeConfig,
    modifyConfig,
    resolveConfig,
    resolveCommittedConfig,
  };
};

export type PreferredScopeStore<Resolved extends ScopedConfigMetadata, E> = Pick<
  ScopedConfigStore<unknown, Resolved, E>,
  "readRawConfig" | "modifyConfig" | "resolveCommittedConfig"
>;

export const commitPreferredScope = Effect.fn("ScopedConfig.commitPreferredScope")(function* <
  Resolved extends ScopedConfigMetadata,
  E,
  R = never,
>(
  store: PreferredScopeStore<Resolved, E>,
  current: Resolved,
  change: (document: JsonObject) => JsonObject,
  afterCommit: (next: Resolved) => Effect.Effect<void, never, R>,
  options: { readonly fallbackWarning?: string } = {},
): Effect.fn.Return<Resolved, E, JsonDocumentStore | R> {
  const { fallbackWarning } = options;
  const read: Effect.Effect<JsonObject | undefined, E, JsonDocumentStore> =
    current.configPath === current.projectConfigPath && current.globalConfigExists
      ? store.readRawConfig(current.globalConfigPath)
      : Effect.undefined;
  const fallback = yield* fallbackWarning === undefined
    ? read
    : read.pipe(Effect.catch(() => Effect.logWarning(fallbackWarning).pipe(Effect.as(undefined))));
  return yield* store.modifyConfig(current.configPath, (document) => {
    const committed = change(document);
    const next = store.resolveCommittedConfig(current, committed, fallback);
    return { value: next, document: committed, afterCommit: afterCommit(next) };
  });
});
