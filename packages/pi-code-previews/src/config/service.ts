import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  AgentDirectory,
  freezeSnapshot,
  isJsonObject,
  JsonDocumentError,
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonObject,
} from "pi-cosmic-core";
import {
  flushSettingsCoordinator,
  type SettingsAdmission,
  type SettingsCoordinator,
  withSettingsCoordinator,
} from "./coordinator";
import { defaultCodePreviewSettings } from "./defaults";
import { CODE_PREVIEW_SETTING_KEYS, CodePreviewSettingsSchema } from "./schema";
import type { CodePreviewSettings } from "./schema";
import {
  cloneCodePreviewSettings,
  setCodePreviewSettings,
  setCodePreviewSettingsProblems,
} from "./state";
import { normalizeSettingsWithDiagnostics } from "./values";

type SettingsSaveContext = {
  readonly globalBaseline: CodePreviewSettings;
  readonly baseline: CodePreviewSettings;
  readonly loaded: CodePreviewSettings;
};

export type SettingsLoadProblem = {
  readonly path: string;
  readonly fields?: readonly string[];
};

export type LoadSettingsOptions = {
  projectCwd?: string | undefined;
  projectTrusted?: boolean | undefined;
};

interface SaveSettingsOptions {
  readonly rehydrate?: LoadSettingsOptions;
  readonly previous?: CodePreviewSettings;
}

export interface CodePreviewSettingsServiceContract {
  readonly load: (
    admission: SettingsAdmission,
    options?: LoadSettingsOptions,
  ) => Effect.Effect<CodePreviewSettings>;
  readonly save: (
    settings: CodePreviewSettings,
    admission: SettingsAdmission,
    options?: SaveSettingsOptions,
  ) => Effect.Effect<void, JsonDocumentError>;
  readonly reset: (
    admission: SettingsAdmission,
    options?: SaveSettingsOptions,
  ) => Effect.Effect<void, JsonDocumentError>;
  readonly flush: Effect.Effect<void>;
}

const decodeCommittedSettings = (settings: CodePreviewSettings, settingsPath: string) =>
  Schema.decodeEffect(CodePreviewSettingsSchema)(settings).pipe(
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

function withoutKnownSettings(latest: JsonObject): JsonObject {
  const document = { ...latest };
  for (const key of CODE_PREVIEW_SETTING_KEYS) delete document[key];
  return document;
}

function settingsDocument(
  settings: CodePreviewSettings,
  context: SettingsSaveContext,
  latestGlobalDocument: JsonObject,
  previous: CodePreviewSettings = context.loaded,
): JsonObject {
  const document = withoutKnownSettings(latestGlobalDocument);
  for (const key of CODE_PREVIEW_SETTING_KEYS) {
    const value = latestGlobalDocument[key];
    if (value !== undefined) document[key] = value;
  }
  for (const key of CODE_PREVIEW_SETTING_KEYS) {
    const value = settings[key];
    if (Equal.equals(value, previous[key])) continue;
    if (
      Equal.equals(value, context.baseline[key]) &&
      Equal.equals(value, context.globalBaseline[key])
    )
      delete document[key];
    else document[key] = value;
  }
  return document;
}

function nestedCodePreviewSettings(document: JsonObject): JsonObject {
  const nested = document.codePreview;
  return isJsonObject(nested) ? nested : {};
}

export class CodePreviewSettingsService extends Context.Service<
  CodePreviewSettingsService,
  CodePreviewSettingsServiceContract
>()("pi-code-previews/config/service/CodePreviewSettingsService") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const agentDir = yield* AgentDirectory;
      const documents = yield* JsonDocumentStore;
      const path = yield* Path.Path;
      const flatSettingsPath = path.join(agentDir, "code-previews.json");
      const state = yield* Ref.make(
        freezeSnapshot<SettingsSaveContext>({
          globalBaseline: defaultCodePreviewSettings,
          baseline: defaultCodePreviewSettings,
          loaded: defaultCodePreviewSettings,
        }),
      );

      const loadFile = Effect.fn("CodePreviewSettings.loadFile")(function* (
        settingsPath: string,
        extract: (document: JsonObject) => JsonObject,
        fallback: CodePreviewSettings,
        problems: SettingsLoadProblem[],
      ) {
        const document = yield* documents
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
        if (!document) return fallback;
        const normalized = normalizeSettingsWithDiagnostics(extract(document), fallback);
        if (normalized.diagnostics.length > 0) {
          const paths = normalized.diagnostics.map((diagnostic) => diagnostic.path);
          yield* Effect.logWarning(
            `Ignored invalid code preview setting fields: ${paths.join(", ")}.`,
          );
          const fields = paths.flatMap((field) =>
            field.startsWith("settings.") ? [field.slice("settings.".length)] : [],
          );
          problems.push(
            fields.length > 0 ? { path: settingsPath, fields } : { path: settingsPath },
          );
        }
        return normalized.settings;
      });

      const loadSaveContext = Effect.fn("CodePreviewSettings.loadSaveContext")(function* (
        options: LoadSettingsOptions,
      ) {
        const projectCwd = options.projectCwd ?? process.cwd();
        const problems: SettingsLoadProblem[] = [];
        const globalBaseline = yield* loadFile(
          path.join(agentDir, "settings.json"),
          nestedCodePreviewSettings,
          defaultCodePreviewSettings,
          problems,
        );
        const baseline = options.projectTrusted
          ? yield* loadFile(
              path.join(projectCwd, ".pi", "settings.json"),
              nestedCodePreviewSettings,
              globalBaseline,
              problems,
            )
          : globalBaseline;
        const loaded = yield* loadFile(flatSettingsPath, identity, baseline, problems);
        const context: SettingsSaveContext = { globalBaseline, baseline, loaded };
        return { context, problems };
      });

      const commit = (
        coordinator: SettingsCoordinator,
        context: SettingsSaveContext,
        problems?: readonly SettingsLoadProblem[],
      ) => {
        const committed = freezeSnapshot(context);
        return Ref.set(state, committed).pipe(
          Effect.andThen(
            Effect.sync(() => {
              coordinator.publishIfCurrent(() => {
                setCodePreviewSettings(committed.loaded);
                if (problems) setCodePreviewSettingsProblems(problems);
              });
            }),
          ),
          Effect.uninterruptible,
        );
      };

      const commitDocument = (
        coordinator: SettingsCoordinator,
        next: SettingsSaveContext,
        edit: (latest: JsonObject) => JsonObject,
      ) =>
        documents.modifyObject(flatSettingsPath, (latest) =>
          Effect.try({
            try: () => {
              const document = edit(latest);
              const committed = {
                ...next,
                loaded: normalizeSettingsWithDiagnostics(document, next.baseline).settings,
              };
              return {
                value: committed,
                document,
                write: !Equal.equals(document, latest),
                afterCommit: commit(coordinator, committed),
              } satisfies JsonDocumentModification<SettingsSaveContext>;
            },
            catch: () =>
              new JsonDocumentError({
                operation: "write",
                path: flatSettingsPath,
                message: "Unable to update code preview settings.",
              }),
          }).pipe(Effect.tap((change) => (change.write ? Effect.void : change.afterCommit))),
        );

      const saveState = Effect.fn("CodePreviewSettings.saveState")(function* (
        settings: CodePreviewSettings,
        context: SettingsSaveContext,
        coordinator: SettingsCoordinator,
        previous?: CodePreviewSettings,
      ) {
        const loaded = yield* decodeCommittedSettings(settings, flatSettingsPath);
        return yield* commitDocument(coordinator, { ...context, loaded }, (latest) =>
          settingsDocument(loaded, context, latest, previous),
        );
      });

      const resetState = Effect.fn("CodePreviewSettings.resetState")(
        (context: SettingsSaveContext, coordinator: SettingsCoordinator) =>
          commitDocument(
            coordinator,
            { ...context, loaded: context.baseline },
            withoutKnownSettings,
          ),
      );

      const modify = (
        admission: SettingsAdmission,
        options: SaveSettingsOptions,
        write: (
          current: SettingsSaveContext,
          coordinator: SettingsCoordinator,
        ) => Effect.Effect<unknown, JsonDocumentError>,
      ) =>
        withSettingsCoordinator(admission, (coordinator) =>
          Effect.gen(function* () {
            if (!coordinator.isCurrent()) return;
            let current = yield* Ref.get(state);
            if (options.rehydrate !== undefined) {
              const { context } = yield* loadSaveContext(options.rehydrate);
              current = freezeSnapshot(context);
              yield* Ref.set(state, current);
            }
            yield* write(current, coordinator);
          }),
        );

      return CodePreviewSettingsService.of({
        load: (admission, options = {}) =>
          withSettingsCoordinator(admission, (coordinator) =>
            loadSaveContext(options).pipe(
              Effect.tap(({ context, problems }) => commit(coordinator, context, problems)),
              Effect.map(({ context }) => cloneCodePreviewSettings(context.loaded)),
            ),
          ),
        save: (settings, admission, options = {}) =>
          modify(admission, options, (current, coordinator) =>
            saveState(settings, current, coordinator, options.previous),
          ),
        reset: (admission, options = {}) => modify(admission, options, resetState),
        flush: flushSettingsCoordinator,
      });
    }),
  );
}
