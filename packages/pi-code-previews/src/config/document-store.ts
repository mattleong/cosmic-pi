import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import { identity } from "effect/Function";
import * as Schema from "effect/Schema";
import {
  decodeTolerantFields,
  isJsonObject,
  JsonDocumentError,
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonObject,
} from "pi-cosmic-core";
import { defaultCodePreviewStartupSettings } from "./defaults";
import { CodePreviewEnvironmentService } from "./env";
import {
  CODE_PREVIEW_SETTING_KEYS,
  CodePreviewSettingsSchema,
  CodePreviewStartupSettingsSchema,
  type CodePreviewStartupSettings,
} from "./schema";
import { cloneCodePreviewSettings } from "./state";
import type { CodePreviewSettings } from "./schema";
import { normalizeSettingsWithDiagnostics } from "./values";
import type * as Path from "effect/Path";

export type SettingsSaveContext = {
  readonly baseline: CodePreviewSettings;
  readonly loaded: CodePreviewSettings;
};

export type LoadSettingsOptions = {
  projectCwd?: string;
  projectTrusted?: boolean;
};

export type SettingsDocumentDependencies = {
  readonly path: Path.Path;
  readonly agentDir: string;
  readonly documents: JsonDocumentStore["Service"];
  readonly environment: CodePreviewEnvironmentService["Service"];
};

const loadSettingsFile = Effect.fn("CodePreviewSettings.loadFile")(function* (
  deps: SettingsDocumentDependencies,
  settingsPath: string,
  extract: (document: JsonObject) => JsonObject,
  fallback: CodePreviewSettings,
) {
  const document = yield* deps.documents
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
  function* (deps: SettingsDocumentDependencies, options: LoadSettingsOptions = {}) {
    const { path, agentDir, environment } = deps;
    const settingsPath = path.join(agentDir, "code-previews.json");
    const projectCwd = options.projectCwd ?? process.cwd();
    let effective = cloneCodePreviewSettings(environment.defaults);
    const baselinePaths = [
      path.join(agentDir, "settings.json"),
      ...(options.projectTrusted ? [path.join(projectCwd, ".pi", "settings.json")] : []),
    ];
    for (const candidate of baselinePaths) {
      const next = yield* loadSettingsFile(deps, candidate, nestedCodePreviewSettings, effective);
      if (next) effective = next;
    }
    const baseline = cloneCodePreviewSettings(effective);
    const globalSettings = yield* loadSettingsFile(deps, settingsPath, identity, effective);
    if (globalSettings) effective = globalSettings;
    return {
      baseline,
      loaded: cloneCodePreviewSettings(effective),
    } satisfies SettingsSaveContext;
  },
);

/**
 * Global startup opt-ins only: the agent-directory `settings.json` nested `codePreview` object,
 * then the flat `code-previews.json`. Trusted-project settings never contribute. An unreadable
 * document or an invalid present field fails closed to the defaults rather than to a lower layer.
 */
export const loadStartupSettingsEffect = Effect.fn("CodePreviewSettings.loadStartup")(
  function* (deps: SettingsDocumentDependencies) {
    const { path, agentDir, documents, environment } = deps;
    const sources = [
      [path.join(agentDir, "settings.json"), nestedCodePreviewSettings],
      [path.join(agentDir, "code-previews.json"), identity<JsonObject>],
    ] as const;
    const startup: CodePreviewStartupSettings = { ...environment.startupDefaults };
    for (const [candidate, extract] of sources) {
      const document = yield* documents.readObject(candidate);
      if (!document) continue;
      const decoded = decodeTolerantFields(
        extract(document),
        CodePreviewStartupSettingsSchema.fields,
      );
      if (decoded.diagnostics.length > 0) {
        yield* Effect.logWarning("Ignored invalid code preview startup settings; they stay off.");
        return defaultCodePreviewStartupSettings;
      }
      Object.assign(startup, decoded.value);
    }
    return startup;
  },
  Effect.catchTag("JsonDocumentError", () =>
    Effect.logWarning("Failed to load code preview startup settings; they stay off.").pipe(
      Effect.as(defaultCodePreviewStartupSettings),
    ),
  ),
);

/** Startup edits touch only their global overrides; ordinary and unknown fields stay intact. */
export const saveStartupSettingsEffect = Effect.fn("CodePreviewSettings.saveStartup")(function* (
  deps: SettingsDocumentDependencies,
  settings: CodePreviewStartupSettings,
  afterCommit: Effect.Effect<void>,
) {
  const settingsPath = deps.path.join(deps.agentDir, "code-previews.json");
  const next = yield* Schema.decodeEffect(CodePreviewStartupSettingsSchema)(settings).pipe(
    Effect.mapError(
      () =>
        new JsonDocumentError({
          operation: "validate",
          path: settingsPath,
          message: "Code preview startup settings are invalid.",
        }),
    ),
  );
  return yield* deps.documents.modifyObject(settingsPath, (latest) =>
    Effect.succeed({
      document: { ...latest, ...next },
      value: { ...next },
      afterCommit,
    }),
  );
});

export const saveSettingsStateEffect = Effect.fn("CodePreviewSettings.saveState")(function* (
  deps: SettingsDocumentDependencies,
  settings: CodePreviewSettings,
  context: SettingsSaveContext,
  afterCommit: (context: SettingsSaveContext) => Effect.Effect<void>,
) {
  const { path, agentDir, documents } = deps;
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
  return yield* documents.modifyObject(settingsPath, (latest) =>
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

/** Flat current-shape package document: unknown root fields are preserved untouched. */
function settingsDocument(
  settings: CodePreviewSettings,
  context: SettingsSaveContext,
  latestGlobalDocument: JsonObject,
): JsonObject {
  const document = { ...latestGlobalDocument };
  for (const key of CODE_PREVIEW_SETTING_KEYS) delete document[key];
  // Preserve existing known-key order before appending newly edited overrides.
  for (const key of CODE_PREVIEW_SETTING_KEYS) {
    const value = latestGlobalDocument[key];
    if (value !== undefined) document[key] = value;
  }
  for (const key of CODE_PREVIEW_SETTING_KEYS) {
    const value = settings[key];
    if (Equal.equals(value, context.loaded[key])) continue;
    if (Equal.equals(value, context.baseline[key])) delete document[key];
    else document[key] = value;
  }
  return document;
}

/** `settings.json` documents contribute settings through their nested `codePreview` object only. */
export function nestedCodePreviewSettings(document: JsonObject): JsonObject {
  const nested = document.codePreview;
  return isJsonObject(nested) ? nested : {};
}
