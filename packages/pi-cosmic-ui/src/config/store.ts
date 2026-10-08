import * as Predicate from "effect/Predicate";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  AgentDirectory,
  commitPreferredScope,
  decodeTolerantFields,
  isJsonObject,
  JsonDocumentStore,
  makeScopedConfigStore,
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

const stringArray = <Candidate>(candidate: Candidate): readonly string[] | undefined =>
  Array.isArray(candidate) ? candidate.filter(Predicate.isString) : undefined;

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
const store = makeScopedConfigStore({
  error: CosmicUiConfigError,
  label: "Cosmic UI",
  spanPrefix: "CosmicUiConfig",
  projectConfigDirectory: CONFIG_DIR_NAME,
  basename: CONFIG_BASENAME,
  decode: decodeConfig,
  resolve: resolveDocuments,
});

export const { configPaths, resolveConfig } = store;

export type CosmicUiConfigAfterCommit = (config: ResolvedCosmicUiConfig) => Effect.Effect<void>;
/** The footer settings a settings change writes; visibility goes through `setFooterVisibility`. */
export type FooterPatch = Partial<Pick<ResolvedCosmicUiConfig["footer"], "enabled" | "density">>;

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
  return yield* commitPreferredScope(
    store,
    fresh,
    (raw) => ({ ...raw, footer: update(isJsonObject(raw.footer) ? raw.footer : {}, fresh) }),
    afterCommit,
    { fallbackWarning: "Unable to read a Cosmic UI configuration document." },
  ).pipe(Effect.mapError(store.errorFactory("update", fresh.configPath)));
});

export const updateFooterConfig = Effect.fn("pi-cosmic-ui.config.update-footer")(function* (
  cwd: string,
  agentDir: string,
  patch: FooterPatch,
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

/** The single Cosmic UI configuration persistence door. */
export class CosmicUiConfigStore extends Context.Service<CosmicUiConfigStore>()(
  "pi-cosmic-ui/config/store/CosmicUiConfigStore",
  {
    make: Effect.gen(function* () {
      const agentDir = yield* AgentDirectory;
      const provide = Effect.provideContext(yield* Effect.context<JsonDocumentStore | Path.Path>());
      return {
        resolve: (cwd: string, projectTrusted: boolean) =>
          provide(resolveConfig(cwd, agentDir, projectTrusted)),
        updateFooter: (
          cwd: string,
          patch: FooterPatch,
          projectTrusted: boolean,
          afterCommit: CosmicUiConfigAfterCommit,
        ) => provide(updateFooterConfig(cwd, agentDir, patch, projectTrusted, afterCommit)),
        setVisibility: (
          cwd: string,
          id: string,
          visible: boolean,
          projectTrusted: boolean,
          afterCommit: CosmicUiConfigAfterCommit,
        ) => provide(setFooterVisibility(cwd, agentDir, id, visible, projectTrusted, afterCommit)),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
