import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  AgentDirectory,
  decodeTolerantFields,
  JsonDocumentStore,
  makeConfigDocumentErrorFactory,
  scopedDocumentPaths,
  selectScopedDocument,
  type JsonDocumentModification,
  type JsonObject,
} from "pi-cosmic-core";
import {
  DEFAULT_CONFIG,
  FooterDensitySchema,
  MediaPlacementSchema,
  type CosmicUiConfigFile,
  type ResolvedCosmicUiConfig,
} from "./schema.ts";

export const CONFIG_BASENAME = "pi-cosmic-ui.json";

export class CosmicUiConfigError extends Schema.TaggedErrorClass<CosmicUiConfigError>()(
  "CosmicUiConfigError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

const mapError = makeConfigDocumentErrorFactory(CosmicUiConfigError, "Cosmic UI");

const stringArray = (candidate: unknown): readonly string[] | undefined =>
  Array.isArray(candidate)
    ? candidate.filter((entry): entry is string => typeof entry === "string")
    : undefined;

export const configPaths = Effect.fn("pi-cosmic-ui.config.paths")(function* (
  cwd: string,
  agentDir: string,
) {
  return yield* scopedDocumentPaths(cwd, agentDir, {
    projectConfigDirectory: CONFIG_DIR_NAME,
    basename: CONFIG_BASENAME,
  });
});

function decodeConfig(value: unknown): CosmicUiConfigFile {
  const root = decodeTolerantFields(
    value,
    { footer: Schema.Record(Schema.String, Schema.Unknown) },
    { path: "config" },
  ).value;
  const footer = decodeTolerantFields(
    root.footer,
    {
      enabled: Schema.Boolean,
      density: FooterDensitySchema,
      mediaPlacement: MediaPlacementSchema,
    },
    { path: "footer" },
  ).value;
  const order = stringArray(root.footer?.order);
  const hidden = stringArray(root.footer?.hidden);
  return {
    footer: {
      ...footer,
      ...(order !== undefined ? { order } : {}),
      ...(hidden !== undefined ? { hidden } : {}),
    },
  };
}

const resolveDocuments = (
  paths: { readonly project: string; readonly global: string },
  projectExists: boolean,
  project: CosmicUiConfigFile | undefined,
  global: CosmicUiConfigFile | undefined,
): ResolvedCosmicUiConfig => {
  const footer = Object.assign({}, DEFAULT_CONFIG.footer, global?.footer, project?.footer);
  return {
    configPath: projectExists ? paths.project : paths.global,
    projectConfigPath: paths.project,
    globalConfigPath: paths.global,
    footer: {
      enabled: footer.enabled,
      density: footer.density,
      order: [...footer.order],
      hidden: [...footer.hidden],
      mediaPlacement: footer.mediaPlacement,
    },
  };
};

const readConfigTolerantly = (path: string) =>
  readConfig(path).pipe(
    Effect.catch(() =>
      Effect.logWarning("Unable to read a Cosmic UI configuration document.").pipe(
        Effect.as(undefined),
      ),
    ),
  );

export const readConfig = Effect.fn("pi-cosmic-ui.config.read")(function* (path: string) {
  const documents = yield* JsonDocumentStore;
  const raw = yield* documents.readObject(path).pipe(Effect.mapError(mapError("read", path)));
  return raw === undefined ? undefined : decodeConfig(raw);
});

export const resolveConfig = Effect.fn("pi-cosmic-ui.config.resolve")(function* (
  cwd: string,
  agentDir: string,
  projectTrusted = true,
) {
  const paths = yield* configPaths(cwd, agentDir);
  // Untrusted projects never probe the project document: its path stays inert metadata.
  const selected = yield* selectScopedDocument(paths, { probeProject: projectTrusted }).pipe(
    Effect.mapError((error) => mapError("inspect", error.path)()),
  );
  const projectExists = projectTrusted && selected.projectExists;
  const { globalExists } = selected;
  const project = projectExists ? yield* readConfigTolerantly(paths.project) : undefined;
  const global = globalExists ? yield* readConfigTolerantly(paths.global) : undefined;
  return resolveDocuments(paths, projectExists, project, global);
});

export type CosmicUiConfigAfterCommit = (config: ResolvedCosmicUiConfig) => Effect.Effect<void>;

const noAfterCommit: CosmicUiConfigAfterCommit = () => Effect.void;

/**
 * Selects the live scope at the start of each atomic document mutation. The projection callback is
 * part of the document store's uninterruptible commit region, so persistence and publication cannot
 * be separated by fiber interruption.
 */
const modifyFooterConfig = Effect.fn("pi-cosmic-ui.config.modify-footer")(function* (
  cwd: string,
  agentDir: string,
  update: (footer: JsonObject, config: ResolvedCosmicUiConfig) => JsonObject,
  projectTrusted: boolean,
  afterCommit: CosmicUiConfigAfterCommit,
) {
  const documents = yield* JsonDocumentStore;
  const modifyObject = documents.modifyObject;
  const fresh = yield* resolveConfig(cwd, agentDir, projectTrusted);
  const projectSelected = fresh.configPath === fresh.projectConfigPath;
  const global = projectSelected ? yield* readConfigTolerantly(fresh.globalConfigPath) : undefined;
  if (modifyObject === undefined) return yield* mapError("update", fresh.configPath)();

  return yield* modifyObject(fresh.configPath, (raw) =>
    Effect.try({
      try: () => {
        const currentFooter =
          typeof raw.footer === "object" && raw.footer !== null && !Array.isArray(raw.footer)
            ? (raw.footer as JsonObject)
            : {};
        const committed = { ...raw, footer: update(currentFooter, fresh) };
        const committedConfig = decodeConfig(committed);
        const next = resolveDocuments(
          { project: fresh.projectConfigPath, global: fresh.globalConfigPath },
          projectSelected,
          projectSelected ? committedConfig : undefined,
          projectSelected ? global : committedConfig,
        );
        return {
          value: next,
          document: committed,
          afterCommit: afterCommit(next),
        } satisfies JsonDocumentModification<ResolvedCosmicUiConfig>;
      },
      catch: mapError("update", fresh.configPath),
    }),
  ).pipe(Effect.mapError(mapError("update", fresh.configPath)));
});

export const updateFooterConfig = Effect.fn("pi-cosmic-ui.config.update-footer")(function* (
  cwd: string,
  agentDir: string,
  patch: Partial<ResolvedCosmicUiConfig["footer"]>,
  projectTrusted = true,
  afterCommit: CosmicUiConfigAfterCommit = noAfterCommit,
) {
  return yield* modifyFooterConfig(
    cwd,
    agentDir,
    (footer) => ({ ...footer, ...patch }),
    projectTrusted,
    afterCommit,
  );
});

export const setFooterVisibility = Effect.fn("pi-cosmic-ui.config.set-visibility")(function* (
  cwd: string,
  agentDir: string,
  id: string,
  visible: boolean,
  projectTrusted = true,
  afterCommit: CosmicUiConfigAfterCommit = noAfterCommit,
) {
  return yield* modifyFooterConfig(
    cwd,
    agentDir,
    (footer, fresh) => {
      const hidden = new Set(stringArray(footer.hidden) ?? fresh.footer.hidden);
      if (visible) hidden.delete(id);
      else hidden.add(id);
      return { ...footer, hidden: [...hidden] };
    },
    projectTrusted,
    afterCommit,
  );
});

export interface CosmicUiConfigStoreShape {
  readonly resolve: (
    cwd: string,
    projectTrusted?: boolean,
  ) => Effect.Effect<ResolvedCosmicUiConfig, CosmicUiConfigError>;
  readonly updateFooter: (
    cwd: string,
    patch: Partial<ResolvedCosmicUiConfig["footer"]>,
    projectTrusted?: boolean,
    afterCommit?: CosmicUiConfigAfterCommit,
  ) => Effect.Effect<ResolvedCosmicUiConfig, CosmicUiConfigError>;
  readonly setVisibility: (
    cwd: string,
    id: string,
    visible: boolean,
    projectTrusted?: boolean,
    afterCommit?: CosmicUiConfigAfterCommit,
  ) => Effect.Effect<ResolvedCosmicUiConfig, CosmicUiConfigError>;
}

/** The single Cosmic UI configuration persistence door. */
export class CosmicUiConfigStore extends Context.Service<
  CosmicUiConfigStore,
  CosmicUiConfigStoreShape
>()("pi-cosmic-ui/config/store/CosmicUiConfigStore") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const agentDir = yield* AgentDirectory;
      const dependencies = yield* Effect.context<JsonDocumentStore | Path.Path>();
      const provide = <A, E>(effect: Effect.Effect<A, E, JsonDocumentStore | Path.Path>) =>
        effect.pipe(Effect.provideContext(dependencies));
      return CosmicUiConfigStore.of({
        resolve: (cwd, projectTrusted) => provide(resolveConfig(cwd, agentDir, projectTrusted)),
        updateFooter: (cwd, patch, projectTrusted, afterCommit) =>
          provide(updateFooterConfig(cwd, agentDir, patch, projectTrusted, afterCommit)),
        setVisibility: (cwd, id, visible, projectTrusted, afterCommit) =>
          provide(setFooterVisibility(cwd, agentDir, id, visible, projectTrusted, afterCommit)),
      });
    }),
  );
}
