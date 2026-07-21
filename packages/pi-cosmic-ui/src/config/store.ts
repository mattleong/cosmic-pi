import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  decodeTolerantFields,
  JsonDocumentStore,
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

const mapError = (operation: string, path: string) => () =>
  new CosmicUiConfigError({
    operation,
    path,
    message: `Unable to ${operation} Cosmic UI configuration.`,
  });

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
  const strings = (candidate: unknown): readonly string[] | undefined => {
    if (!Array.isArray(candidate)) return undefined;
    return candidate.filter((entry): entry is string => typeof entry === "string");
  };
  const order = strings(root.footer?.order);
  const hidden = strings(root.footer?.hidden);
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
  const footer = {
    enabled: project?.footer?.enabled ?? global?.footer?.enabled ?? DEFAULT_CONFIG.footer.enabled,
    density: project?.footer?.density ?? global?.footer?.density ?? DEFAULT_CONFIG.footer.density,
    order: project?.footer?.order ?? global?.footer?.order ?? DEFAULT_CONFIG.footer.order,
    hidden: project?.footer?.hidden ?? global?.footer?.hidden ?? DEFAULT_CONFIG.footer.hidden,
    mediaPlacement:
      project?.footer?.mediaPlacement ??
      global?.footer?.mediaPlacement ??
      DEFAULT_CONFIG.footer.mediaPlacement,
  };
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

export const readRawConfig = Effect.fn("pi-cosmic-ui.config.read-raw")(function* (path: string) {
  const documents = yield* JsonDocumentStore;
  return yield* documents.readObject(path).pipe(
    Effect.map((value) => value ?? {}),
    Effect.mapError(mapError("read", path)),
  );
});

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
  const selected = yield* selectScopedDocument(paths).pipe(
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
      const hidden = new Set(
        Array.isArray(footer.hidden)
          ? footer.hidden.filter((entry): entry is string => typeof entry === "string")
          : fresh.footer.hidden,
      );
      if (visible) hidden.delete(id);
      else hidden.add(id);
      return { ...footer, hidden: [...hidden] };
    },
    projectTrusted,
    afterCommit,
  );
});
