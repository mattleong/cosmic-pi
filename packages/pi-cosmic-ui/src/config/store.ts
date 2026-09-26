import * as Predicate from "effect/Predicate";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  AgentDirectory,
  decodeTolerantFields,
  isJsonObject,
  JsonDocumentStore,
  makeConfigDocumentErrorFactory,
  makeScopedConfigStore,
  type JsonDocumentModification,
  type JsonObject,
  type ScopedConfigMetadata,
} from "pi-cosmic-core";
import {
  DEFAULT_CONFIG,
  FooterDensitySchema,
  type CosmicUiConfigFile,
  type ResolvedCosmicUiConfig,
} from "./schema.ts";

export const CONFIG_BASENAME = "pi-cosmic-ui.json";

export class CosmicUiConfigError extends Schema.TaggedError<CosmicUiConfigError>()(
  "CosmicUiConfigError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

const mapError = makeConfigDocumentErrorFactory(CosmicUiConfigError, "Cosmic UI");

const stringArray = <Candidate>(candidate: Candidate): readonly string[] | undefined =>
  Array.isArray(candidate)
    ? candidate.filter((entry): entry is string => Predicate.isString(entry))
    : undefined;

function decodeConfig<ValueInput>(value: ValueInput): CosmicUiConfigFile {
  const root = decodeTolerantFields(
    value,
    { footer: Schema.Record(Schema.String, Schema.Unknown) },
    { path: "config" },
  ).value;
  const footer = decodeTolerantFields(
    root.footer,
    { enabled: Schema.Boolean, density: FooterDensitySchema },
    { path: "footer" },
  ).value;
  const order = stringArray(root.footer?.order);
  const hidden = stringArray(root.footer?.hidden);
  return { footer: { ...footer, ...(order && { order }), ...(hidden && { hidden }) } };
}

const resolveDocuments = (
  metadata: ScopedConfigMetadata,
  project: CosmicUiConfigFile | undefined,
  global: CosmicUiConfigFile | undefined,
): ResolvedCosmicUiConfig => {
  const footer = Object.assign({}, DEFAULT_CONFIG.footer, global?.footer, project?.footer);
  return {
    ...metadata,
    footer: { ...footer, order: [...footer.order], hidden: [...footer.hidden] },
  };
};

/**
 * The shared scoped store is instantiated without a default document, so resolution never
 * writes: an absent scope stays absent and the resolved config falls back to package defaults.
 * Untrusted projects still perform zero project-document I/O.
 */
const store = makeScopedConfigStore<
  CosmicUiConfigFile,
  ResolvedCosmicUiConfig,
  CosmicUiConfigError
>({
  errorFactory: mapError,
  label: "Cosmic UI",
  spanPrefix: "CosmicUiConfig",
  projectConfigDirectory: CONFIG_DIR_NAME,
  basename: CONFIG_BASENAME,
  decode: decodeConfig,
  resolve: resolveDocuments,
});

export const { configPaths, readConfig, resolveConfig } = store;

const readRawConfigTolerantly = (path: string) =>
  store
    .readRawConfig(path)
    .pipe(
      Effect.catch(() =>
        Effect.logWarning("Unable to read a Cosmic UI configuration document.").pipe(
          Effect.as(undefined),
        ),
      ),
    );

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
  const fresh = yield* resolveConfig(cwd, agentDir, projectTrusted);
  const projectSelected = fresh.configPath === fresh.projectConfigPath;
  // The other scope's raw document is only needed as the overlay fallback for a project commit.
  const global = projectSelected
    ? yield* readRawConfigTolerantly(fresh.globalConfigPath)
    : undefined;

  return yield* store
    .modifyConfig(fresh.configPath, (raw) => {
      const currentFooter = isJsonObject(raw.footer) ? raw.footer : {};
      const committed = { ...raw, footer: update(currentFooter, fresh) };
      const next = store.resolveCommittedConfig(fresh, committed, global);
      return {
        value: next,
        document: committed,
        afterCommit: afterCommit(next),
      } satisfies JsonDocumentModification<ResolvedCosmicUiConfig>;
    })
    .pipe(Effect.mapError(mapError("update", fresh.configPath)));
});

export const updateFooterConfig = Effect.fn("pi-cosmic-ui.config.update-footer")(function* (
  cwd: string,
  agentDir: string,
  patch: Partial<ResolvedCosmicUiConfig["footer"]>,
  projectTrusted = false,
  afterCommit: CosmicUiConfigAfterCommit = noAfterCommit,
) {
  return yield* modifyFooterConfig(
    cwd,
    agentDir,
    (footer) => {
      const updated: JsonObject = { ...footer };
      if (patch.enabled !== undefined) updated.enabled = patch.enabled;
      if (patch.density !== undefined) updated.density = patch.density;
      if (patch.order !== undefined) updated.order = [...patch.order];
      if (patch.hidden !== undefined) updated.hidden = [...patch.hidden];
      return updated;
    },
    projectTrusted,
    afterCommit,
  );
});

export const setFooterVisibility = Effect.fn("pi-cosmic-ui.config.set-visibility")(function* (
  cwd: string,
  agentDir: string,
  id: string,
  visible: boolean,
  projectTrusted = false,
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

export interface CosmicUiConfigStoreContract {
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
  CosmicUiConfigStoreContract
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
