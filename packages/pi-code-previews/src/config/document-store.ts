import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  AgentDirectory,
  isJsonObject,
  JsonDocumentError,
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonObject,
} from "pi-cosmic-core";
import { CodePreviewEnvironmentService } from "./env";
import { CODE_PREVIEW_SETTING_KEYS, CodePreviewSettingsSchema } from "./schema";
import { cloneCodePreviewSettings } from "./state";
import type { CodePreviewSettings } from "./schema";
import { normalizeSettingsWithDiagnostics } from "./values";

export type SettingsSaveContext = {
  readonly baseline: CodePreviewSettings;
  readonly loaded: CodePreviewSettings;
};

export type LoadSettingsOptions = {
  projectCwd?: string;
  projectTrusted?: boolean;
};

const loadSettingsFile = Effect.fn("CodePreviewSettings.loadFile")(function* (
  settingsPath: string,
  extract: (document: JsonObject) => JsonObject,
  fallback: CodePreviewSettings,
) {
  const documents = yield* JsonDocumentStore;
  const document = yield* documents
    .readObject(settingsPath)
    .pipe(
      Effect.catchTag("JsonDocumentError", () =>
        Effect.logWarning(
          "Failed to load settings for code previews; ignoring that document.",
        ).pipe(Effect.as(undefined)),
      ),
    );
  if (!document) return undefined;
  const data = extract(document);
  const normalized = normalizeSettingsWithDiagnostics(data, fallback);
  if (normalized.diagnostics.length > 0) {
    const paths = normalized.diagnostics.map((diagnostic) => diagnostic.path).join(", ");
    yield* Effect.logWarning(`Ignored invalid code preview setting fields: ${paths}.`);
  }
  return normalized.settings;
});

/**
 * Current settings sources only: nested `codePreview` objects in the agent-directory and
 * trusted-project `settings.json` baselines, then the flat package `code-previews.json`.
 */
export const loadSettingsSaveContextEffect = Effect.fn("CodePreviewSettings.loadSaveContext")(
  function* (options: LoadSettingsOptions = {}) {
    const path = yield* Path.Path;
    const agentDir = yield* AgentDirectory;
    const environment = yield* CodePreviewEnvironmentService;
    const settingsPath = path.join(agentDir, "code-previews.json");
    const projectCwd = options.projectCwd ?? process.cwd();
    let effective = cloneCodePreviewSettings(environment.defaults);
    const baselinePaths = [
      path.join(agentDir, "settings.json"),
      ...(options.projectTrusted ? [path.join(projectCwd, ".pi", "settings.json")] : []),
    ];
    for (const candidate of baselinePaths) {
      const next = yield* loadSettingsFile(candidate, nestedCodePreviewSettings, effective);
      if (next) effective = next;
    }
    const baseline = cloneCodePreviewSettings(effective);
    const globalSettings = yield* loadSettingsFile(
      settingsPath,
      flatCodePreviewSettings,
      effective,
    );
    if (globalSettings) effective = globalSettings;
    return {
      baseline,
      loaded: cloneCodePreviewSettings(effective),
    } satisfies SettingsSaveContext;
  },
);

export const saveSettingsStateEffect = Effect.fn("CodePreviewSettings.saveState")(function* (
  settings: CodePreviewSettings,
  context: SettingsSaveContext,
  afterCommit: (context: SettingsSaveContext) => Effect.Effect<void>,
) {
  const path = yield* Path.Path;
  const agentDir = yield* AgentDirectory;
  const documents = yield* JsonDocumentStore;
  const settingsPath = path.join(agentDir, "code-previews.json");
  const committedSettings = yield* Schema.decodeUnknownEffect(CodePreviewSettingsSchema)(
    settings,
  ).pipe(
    Effect.map(
      (decoded): CodePreviewSettings => ({
        ...decoded,
        tools: [...decoded.tools],
      }),
    ),
    Effect.mapError(
      () =>
        new JsonDocumentError({
          operation: "validate",
          path: settingsPath,
          message: "Code preview settings are invalid.",
        }),
    ),
  );
  const modifyObject = documents.modifyObject;
  if (!modifyObject)
    return yield* new JsonDocumentError({
      operation: "write",
      path: settingsPath,
      message: "Atomic JSON document modification is unavailable.",
    });
  return yield* modifyObject(settingsPath, (latest) =>
    Effect.try({
      try: () => {
        const document = settingsDocument(committedSettings, context, latest);
        const nextContext = {
          baseline: cloneCodePreviewSettings(context.baseline),
          loaded: cloneCodePreviewSettings(committedSettings),
        } satisfies SettingsSaveContext;
        return {
          value: nextContext,
          document,
          afterCommit: afterCommit(nextContext),
        } satisfies JsonDocumentModification<SettingsSaveContext>;
      },
      catch: () =>
        new JsonDocumentError({
          operation: "write",
          path: settingsPath,
          message: "Unable to update code preview settings.",
        }),
    }),
  );
});

function settingsOverrides(
  settings: CodePreviewSettings,
  context: SettingsSaveContext,
  latestGlobalDocument: JsonObject,
): JsonObject {
  const overrides = flatCodePreviewSettings(latestGlobalDocument);
  for (const key of CODE_PREVIEW_SETTING_KEYS) {
    const value = settings[key];
    if (settingValuesEqual(value, context.loaded[key])) continue;
    if (settingValuesEqual(value, context.baseline[key])) delete overrides[key];
    else Object.assign(overrides, { [key]: value });
  }
  return overrides;
}

/** Flat current-shape package document: unknown root fields are preserved untouched. */
function settingsDocument(
  settings: CodePreviewSettings,
  context: SettingsSaveContext,
  latestGlobalDocument: JsonObject,
): JsonObject {
  const overrides = settingsOverrides(settings, context, latestGlobalDocument);
  const document = { ...latestGlobalDocument };
  for (const key of CODE_PREVIEW_SETTING_KEYS) delete document[key];
  return { ...document, ...overrides };
}

type CodePreviewSettingValue = CodePreviewSettings[keyof CodePreviewSettings];

function settingValuesEqual(
  left: CodePreviewSettingValue,
  right: CodePreviewSettingValue,
): boolean {
  return Array.isArray(left)
    ? Array.isArray(right) &&
        left.length === right.length &&
        left.every((entry, index) => entry === right[index])
    : left === right;
}

export function defaultSettingsSaveContext(defaults: CodePreviewSettings): SettingsSaveContext {
  return {
    baseline: cloneCodePreviewSettings(defaults),
    loaded: cloneCodePreviewSettings(defaults),
  };
}

/** `settings.json` documents contribute settings through their nested `codePreview` object only. */
export function nestedCodePreviewSettings(document: JsonObject): JsonObject {
  const nested = document.codePreview;
  return isJsonObject(nested) ? nested : {};
}

/** The package `code-previews.json` document carries current setting keys flat at the root only. */
export function flatCodePreviewSettings(document: JsonObject): JsonObject {
  const extracted: JsonObject = {};
  for (const key of CODE_PREVIEW_SETTING_KEYS) {
    const value = document[key];
    if (value !== undefined) extracted[key] = value;
  }
  return extracted;
}
