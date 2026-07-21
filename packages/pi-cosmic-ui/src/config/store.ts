import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  decodeTolerantFields,
  JsonDocumentStore,
  scopedDocumentPaths,
  selectScopedDocument,
  updateScopedSection,
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

export const configPaths = Effect.fn("CosmicUiConfig.paths")(function* (
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

export const readRawConfig = Effect.fn("CosmicUiConfig.readRaw")(function* (path: string) {
  const documents = yield* JsonDocumentStore;
  return yield* documents.readObject(path).pipe(
    Effect.map((value) => value ?? {}),
    Effect.mapError(mapError("read", path)),
  );
});

export const readConfig = Effect.fn("CosmicUiConfig.read")(function* (path: string) {
  const documents = yield* JsonDocumentStore;
  const raw = yield* documents.readObject(path).pipe(Effect.mapError(mapError("read", path)));
  return raw === undefined ? undefined : decodeConfig(raw);
});

export const resolveConfig = Effect.fn("CosmicUiConfig.resolve")(function* (
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
  const tolerantRead = (path: string, exists: boolean) =>
    exists
      ? readConfig(path).pipe(
          Effect.catch(() =>
            Effect.logWarning("Unable to read a Cosmic UI configuration document.").pipe(
              Effect.asVoid,
            ),
          ),
        )
      : Effect.void;
  const project = yield* tolerantRead(paths.project, projectExists);
  const global = yield* tolerantRead(paths.global, globalExists);
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
  } satisfies ResolvedCosmicUiConfig;
});

export const updateFooterConfig = Effect.fn("CosmicUiConfig.updateFooter")(function* (
  cwd: string,
  agentDir: string,
  config: ResolvedCosmicUiConfig,
  patch: Partial<ResolvedCosmicUiConfig["footer"]>,
  projectTrusted = true,
) {
  yield* updateScopedSection(config.configPath, "footer", (footer) => ({
    ...footer,
    ...patch,
  })).pipe(Effect.mapError(mapError("update", config.configPath)));
  return yield* resolveConfig(cwd, agentDir, projectTrusted);
});

export const setFooterVisibility = Effect.fn("CosmicUiConfig.setVisibility")(function* (
  cwd: string,
  agentDir: string,
  config: ResolvedCosmicUiConfig,
  id: string,
  visible: boolean,
  projectTrusted = true,
) {
  yield* updateScopedSection(config.configPath, "footer", (footer) => {
    const hidden = new Set(
      Array.isArray(footer.hidden)
        ? footer.hidden.filter((entry): entry is string => typeof entry === "string")
        : config.footer.hidden,
    );
    if (visible) hidden.delete(id);
    else hidden.add(id);
    return { ...footer, hidden: [...hidden] };
  }).pipe(Effect.mapError(mapError("update", config.configPath)));
  return yield* resolveConfig(cwd, agentDir, projectTrusted);
});
