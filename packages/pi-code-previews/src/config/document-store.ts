import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import { identity } from "effect/Function";
import * as Schema from "effect/Schema";
import {
  isJsonObject,
  JsonDocumentError,
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonObject,
} from "pi-cosmic-core";
import { defaultCodePreviewSettings } from "./defaults";
import { CODE_PREVIEW_SETTING_KEYS, CodePreviewSettingsSchema } from "./schema";
import { cloneCodePreviewSettings } from "./state";
import type { CodePreviewSettings } from "./schema";
import { normalizeSettingsWithDiagnostics } from "./values";
import type * as Path from "effect/Path";

export type SettingsSaveContext = {
  /** Defaults plus the agent-directory `settings.json`: what every project inherits. */
  readonly globalBaseline: CodePreviewSettings;
  /** The global baseline plus a trusted project's `settings.json`. */
  readonly baseline: CodePreviewSettings;
  readonly loaded: CodePreviewSettings;
};

/** A settings file that couldn't be read, or whose invalid fields were ignored. */
export type SettingsLoadProblem = {
  readonly path: string;
  /** Ignored invalid fields; absent when the whole file was ignored. */
  readonly fields?: readonly string[];
};

export type SettingsLoad = {
  readonly context: SettingsSaveContext;
  readonly problems: readonly SettingsLoadProblem[];
};

export type LoadSettingsOptions = {
  projectCwd?: string;
  projectTrusted?: boolean;
};

export type SettingsDocumentDependencies = {
  readonly path: Path.Path;
  readonly agentDir: string;
  readonly documents: JsonDocumentStore["Service"];
};

const loadSettingsFile = Effect.fn("CodePreviewSettings.loadFile")(function* (
  deps: SettingsDocumentDependencies,
  settingsPath: string,
  extract: (document: JsonObject) => JsonObject,
  fallback: CodePreviewSettings,
  problems: SettingsLoadProblem[],
) {
  const document = yield* deps.documents
    .readObject(settingsPath)
    .pipe(
      Effect.catchTag("JsonDocumentError", () =>
        Effect.logWarning(
          "Failed to load settings for code previews; ignoring that document.",
        ).pipe(
          Effect.andThen(Effect.sync(() => problems.push({ path: settingsPath }))),
          Effect.as(undefined),
        ),
      ),
    );
  if (!document) return undefined;
  const data = extract(document);
  const normalized = normalizeSettingsWithDiagnostics(data, fallback);
  if (normalized.diagnostics.length > 0) {
    const paths = normalized.diagnostics.map((diagnostic) => diagnostic.path).join(", ");
    yield* Effect.logWarning(`Ignored invalid code preview setting fields: ${paths}.`);
    const fields = normalized.diagnostics.flatMap(({ path }) =>
      path.startsWith("settings.") ? [path.slice("settings.".length)] : [],
    );
    problems.push(fields.length > 0 ? { path: settingsPath, fields } : { path: settingsPath });
  }
  return normalized.settings;
});

/**
 * Current settings sources only: nested `codePreview` objects in the agent-directory and
 * trusted-project `settings.json` baselines, then the flat package `code-previews.json`.
 */
export const loadSettingsSaveContextEffect = Effect.fn("CodePreviewSettings.loadSaveContext")(
  function* (deps: SettingsDocumentDependencies, options: LoadSettingsOptions = {}) {
    const { path, agentDir } = deps;
    const settingsPath = path.join(agentDir, "code-previews.json");
    const projectCwd = options.projectCwd ?? process.cwd();
    const problems: SettingsLoadProblem[] = [];
    const layer = (current: CodePreviewSettings, file: string) =>
      loadSettingsFile(deps, file, nestedCodePreviewSettings, current, problems).pipe(
        Effect.map((next) => next ?? current),
      );
    const globalBaseline = yield* layer(
      cloneCodePreviewSettings(defaultCodePreviewSettings),
      path.join(agentDir, "settings.json"),
    );
    const baseline = options.projectTrusted
      ? yield* layer(globalBaseline, path.join(projectCwd, ".pi", "settings.json"))
      : globalBaseline;
    const loaded =
      (yield* loadSettingsFile(deps, settingsPath, identity, baseline, problems)) ?? baseline;
    return {
      context: {
        globalBaseline: cloneCodePreviewSettings(globalBaseline),
        baseline: cloneCodePreviewSettings(baseline),
        loaded: cloneCodePreviewSettings(loaded),
      },
      problems,
    } satisfies SettingsLoad;
  },
);

const decodeCommittedSettings = (settings: CodePreviewSettings, settingsPath: string) =>
  Schema.decodeUnknownEffect(CodePreviewSettingsSchema)(settings).pipe(
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

/** One locked replacement of the flat document; an unchanged document is not rewritten. */
const modifySettingsDocument = (
  deps: SettingsDocumentDependencies,
  settingsPath: string,
  change: (latest: JsonObject) => { document: JsonObject; context: SettingsSaveContext },
  afterCommit: (context: SettingsSaveContext) => Effect.Effect<void>,
) =>
  deps.documents.modifyObject(settingsPath, (latest) =>
    Effect.try({
      try: () => {
        const { document, context } = change(latest);
        return {
          value: context,
          document,
          write: JSON.stringify(document) !== JSON.stringify(latest),
          afterCommit: afterCommit(context),
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

export const saveSettingsStateEffect = Effect.fn("CodePreviewSettings.saveState")(function* (
  deps: SettingsDocumentDependencies,
  settings: CodePreviewSettings,
  context: SettingsSaveContext,
  afterCommit: (context: SettingsSaveContext) => Effect.Effect<void>,
) {
  const settingsPath = deps.path.join(deps.agentDir, "code-previews.json");
  const committedSettings = yield* decodeCommittedSettings(settings, settingsPath);
  return yield* modifySettingsDocument(
    deps,
    settingsPath,
    (latest) => ({
      document: settingsDocument(committedSettings, context, latest),
      context: {
        globalBaseline: cloneCodePreviewSettings(context.globalBaseline),
        baseline: cloneCodePreviewSettings(context.baseline),
        loaded: cloneCodePreviewSettings(committedSettings),
      },
    }),
    afterCommit,
  );
});

/** Restore removes every known flat override, so `settings.json` values apply again. */
export const resetSettingsStateEffect = Effect.fn("CodePreviewSettings.resetState")(function* (
  deps: SettingsDocumentDependencies,
  context: SettingsSaveContext,
  afterCommit: (context: SettingsSaveContext) => Effect.Effect<void>,
) {
  const settingsPath = deps.path.join(deps.agentDir, "code-previews.json");
  return yield* modifySettingsDocument(
    deps,
    settingsPath,
    (latest) => {
      const document = { ...latest };
      for (const key of CODE_PREVIEW_SETTING_KEYS) delete document[key];
      return {
        document,
        context: {
          globalBaseline: cloneCodePreviewSettings(context.globalBaseline),
          baseline: cloneCodePreviewSettings(context.baseline),
          loaded: cloneCodePreviewSettings(context.baseline),
        },
      };
    },
    afterCommit,
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
    // The flat file is global: dropping an override must leave this project and every project
    // that only inherits the global baseline on the chosen value.
    if (
      Equal.equals(value, context.baseline[key]) &&
      Equal.equals(value, context.globalBaseline[key])
    )
      delete document[key];
    else document[key] = value;
  }
  return document;
}

/** `settings.json` documents contribute settings through their nested `codePreview` object only. */
export function nestedCodePreviewSettings(document: JsonObject): JsonObject {
  const nested = document.codePreview;
  return isJsonObject(nested) ? nested : {};
}
