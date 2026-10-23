import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
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

/** A trusted project's settings load from its working directory, which the caller supplies. */
export type LoadSettingsOptions =
  | { readonly projectCwd?: string | undefined; readonly projectTrusted?: false | undefined }
  | { readonly projectCwd: string; readonly projectTrusted: true };

type LoadedSettingsFile = {
  readonly settings: CodePreviewSettings;
  readonly problems: readonly SettingsLoadProblem[];
};

type SettingKey = keyof CodePreviewSettings;

export class CodePreviewSettingsSuperseded extends Schema.TaggedError<
  CodePreviewSettingsSuperseded,
  { readonly brand: unique symbol }
>()("CodePreviewSettingsSuperseded", { message: Schema.String }) {}

type SettingsWriteError = JsonDocumentError | CodePreviewSettingsSuperseded;

interface SaveSettingsOptions {
  readonly rehydrate?: LoadSettingsOptions;
  readonly previous?: CodePreviewSettings;
  readonly editedKeys?: readonly SettingKey[];
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
  ) => Effect.Effect<void, SettingsWriteError>;
  readonly reset: (
    admission: SettingsAdmission,
    options?: SaveSettingsOptions,
  ) => Effect.Effect<void, SettingsWriteError>;
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
    Effect.mapError(() =>
      JsonDocumentError.make({
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

function editedSettingKeys(
  settings: CodePreviewSettings,
  previous: CodePreviewSettings,
  editedKeys: readonly SettingKey[] | undefined,
): readonly SettingKey[] {
  // Explicit assignments remain edits even while pending saves make the snapshot stale.
  return (
    editedKeys ??
    Arr.filter(CODE_PREVIEW_SETTING_KEYS, (key) => !Equal.equals(settings[key], previous[key]))
  );
}

function settingsDocument(
  settings: CodePreviewSettings,
  context: SettingsSaveContext,
  latestGlobalDocument: JsonObject,
  editedKeys: readonly SettingKey[],
): JsonObject {
  const document = withoutKnownSettings(latestGlobalDocument);
  for (const key of CODE_PREVIEW_SETTING_KEYS) {
    const value = latestGlobalDocument[key];
    if (value !== undefined) document[key] = value;
  }
  for (const key of editedKeys) {
    const value = settings[key];
    if (
      Equal.equals(value, context.baseline[key]) &&
      Equal.equals(value, context.globalBaseline[key])
    )
      delete document[key];
    else document[key] = value;
  }
  return document;
}

// A later admission may win the settings permit first; it then owns the keys it edited.
const failIfSuperseded = (
  coordinator: SettingsCoordinator,
  editedKeys: readonly SettingKey[],
): Effect.Effect<void, CodePreviewSettingsSuperseded> =>
  Effect.suspend(() =>
    coordinator.isSuperseded(editedKeys)
      ? Effect.fail(
          CodePreviewSettingsSuperseded.make({
            message: "A newer change to the same setting was saved first",
          }),
        )
      : Effect.void,
  );

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
      ) {
        const read = yield* documents.readObject(settingsPath).pipe(
          Effect.map((document) => ({ document, readable: true })),
          Effect.catchTag("JsonDocumentError", () =>
            Effect.logWarning(
              "Failed to load settings for code previews; ignoring that document.",
            ).pipe(Effect.as({ document: undefined, readable: false })),
          ),
        );
        if (!read.document)
          return {
            settings: fallback,
            problems: read.readable ? [] : [{ path: settingsPath }],
          } satisfies LoadedSettingsFile;
        const normalized = normalizeSettingsWithDiagnostics(extract(read.document), fallback);
        if (normalized.diagnostics.length === 0)
          return { settings: normalized.settings, problems: [] } satisfies LoadedSettingsFile;
        const paths = Arr.map(normalized.diagnostics, (diagnostic) => diagnostic.path);
        yield* Effect.logWarning(
          `Ignored invalid code preview setting fields: ${Arr.join(paths, ", ")}.`,
        );
        const fields = Arr.flatMap(paths, (field) =>
          Fn.pipe(field, Str.startsWith("settings."))
            ? [Fn.pipe(field, Str.slice("settings.".length))]
            : [],
        );
        return {
          settings: normalized.settings,
          problems: [fields.length > 0 ? { path: settingsPath, fields } : { path: settingsPath }],
        } satisfies LoadedSettingsFile;
      });

      const loadSaveContext = Effect.fn("CodePreviewSettings.loadSaveContext")(function* (
        options: LoadSettingsOptions,
      ) {
        const global = yield* loadFile(
          path.join(agentDir, "settings.json"),
          nestedCodePreviewSettings,
          defaultCodePreviewSettings,
        );
        const project = options.projectTrusted
          ? yield* loadFile(
              path.join(options.projectCwd, ".pi", "settings.json"),
              nestedCodePreviewSettings,
              global.settings,
            )
          : undefined;
        const baseline = project?.settings ?? global.settings;
        const flat = yield* loadFile(flatSettingsPath, Fn.identity, baseline);
        const context: SettingsSaveContext = {
          globalBaseline: global.settings,
          baseline,
          loaded: flat.settings,
        };
        const problems = [...global.problems, ...(project?.problems ?? []), ...flat.problems];
        return { context, problems };
      });

      const commit = (context: SettingsSaveContext, publication: () => void) =>
        Ref.set(state, freezeSnapshot(context)).pipe(
          Effect.andThen(Effect.sync(publication)),
          Effect.uninterruptible,
        );

      const commitDocument = (
        coordinator: SettingsCoordinator,
        editedKeys: readonly SettingKey[],
        next: SettingsSaveContext,
        edit: (latest: JsonObject) => JsonObject,
      ) =>
        failIfSuperseded(coordinator, editedKeys).pipe(
          Effect.andThen(
            documents.modifyObject(flatSettingsPath, (latest) =>
              // Editing and normalizing the document are pure and total.
              Effect.sync(() => {
                const document = edit(latest);
                const committed = {
                  ...next,
                  loaded: normalizeSettingsWithDiagnostics(document, next.baseline).settings,
                };
                return {
                  value: committed,
                  document,
                  write: !Equal.equals(document, latest),
                  afterCommit: commit(committed, () =>
                    coordinator.publishEdit(editedKeys, next.baseline, (baseline) =>
                      setCodePreviewSettings(
                        normalizeSettingsWithDiagnostics(document, baseline).settings,
                      ),
                    ),
                  ),
                } satisfies JsonDocumentModification<SettingsSaveContext>;
              }).pipe(Effect.tap((change) => (change.write ? Effect.void : change.afterCommit))),
            ),
          ),
        );

      const saveState = Effect.fn("CodePreviewSettings.saveState")(function* (
        settings: CodePreviewSettings,
        context: SettingsSaveContext,
        coordinator: SettingsCoordinator,
        previous: CodePreviewSettings = context.loaded,
        editedKeys?: readonly SettingKey[],
      ) {
        const loaded = yield* decodeCommittedSettings(settings, flatSettingsPath);
        const keys = editedSettingKeys(loaded, previous, editedKeys);
        return yield* commitDocument(coordinator, keys, { ...context, loaded }, (latest) =>
          settingsDocument(loaded, context, latest, keys),
        );
      });

      const resetState = Effect.fn("CodePreviewSettings.resetState")(
        (context: SettingsSaveContext, coordinator: SettingsCoordinator) =>
          commitDocument(
            coordinator,
            CODE_PREVIEW_SETTING_KEYS,
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
        ) => Effect.Effect<unknown, SettingsWriteError>,
      ) =>
        withSettingsCoordinator(admission, (coordinator) =>
          Effect.gen(function* () {
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
              Effect.tap(({ context, problems }) =>
                commit(context, () =>
                  coordinator.publishIfCurrent(context.baseline, () => {
                    setCodePreviewSettings(context.loaded);
                    setCodePreviewSettingsProblems(problems);
                  }),
                ),
              ),
              Effect.map(({ context }) => cloneCodePreviewSettings(context.loaded)),
            ),
          ),
        save: (settings, admission, options = {}) =>
          modify(admission, options, (current, coordinator) =>
            saveState(settings, current, coordinator, options.previous, options.editedKeys),
          ),
        reset: (admission, options = {}) => modify(admission, options, resetState),
        flush: flushSettingsCoordinator,
      });
    }),
  );
}
