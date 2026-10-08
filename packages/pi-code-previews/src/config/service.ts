/** Internal Effect settings service room. Public persistence door: `store.ts`. */
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

export type LoadSettingsOptions = {
  projectCwd?: string | undefined;
  projectTrusted?: boolean | undefined;
};

interface SaveSettingsOptions {
  readonly rehydrate?: LoadSettingsOptions;
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
  /** Removes the flat overrides, restoring the `settings.json` and built-in values. */
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

/** Flat current-shape package document: unknown root fields are preserved untouched. */
function settingsDocument(
  settings: CodePreviewSettings,
  context: SettingsSaveContext,
  latestGlobalDocument: JsonObject,
): JsonObject {
  const document = withoutKnownSettings(latestGlobalDocument);
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
      // The Ref starts private. Layer construction must not publish settings from an unstarted runtime.
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

      /**
       * Current settings sources only: nested `codePreview` objects in the agent-directory and
       * trusted-project `settings.json` baselines, then the flat package `code-previews.json`.
       */
      const loadSaveContext = Effect.fn("CodePreviewSettings.loadSaveContext")(function* (
        options: LoadSettingsOptions,
      ) {
        const projectCwd = options.projectCwd ?? process.cwd();
        const problems: SettingsLoadProblem[] = [];
        // Unchanged layers may share objects; the commit publishes only a frozen deep clone.
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

      // Private replacement and gated publication share one commit that interruption cannot split.
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

      /**
       * One locked replacement of the flat document. An unchanged document is not rewritten, but
       * the operation still applies: the store skips `afterCommit` without a write, so it runs here.
       * Building the commit preflights the complete plain state before rename.
       */
      const commitDocument = (
        coordinator: SettingsCoordinator,
        next: SettingsSaveContext,
        edit: (latest: JsonObject) => JsonObject,
      ) =>
        documents.modifyObject(flatSettingsPath, (latest) =>
          Effect.try({
            try: () => {
              const document = edit(latest);
              return {
                value: next,
                document,
                write: !Equal.equals(document, latest),
                afterCommit: commit(coordinator, next),
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
      ) {
        const loaded = yield* decodeCommittedSettings(settings, flatSettingsPath);
        return yield* commitDocument(coordinator, { ...context, loaded }, (latest) =>
          settingsDocument(loaded, context, latest),
        );
      });

      /** Restore removes every known flat override, so `settings.json` values apply again. */
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
            // A newer successful publication makes this save obsolete before document mutation.
            if (!coordinator.isCurrent()) return;
            let current = yield* Ref.get(state);
            if (options.rehydrate !== undefined) {
              const { context } = yield* loadSaveContext(options.rehydrate);
              current = freezeSnapshot(context);
              yield* Ref.set(state, current);
            }
            // The commit runs while holding the coordinator and document locks, so it must not
            // reacquire either one.
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
            saveState(settings, current, coordinator),
          ),
        reset: (admission, options = {}) => modify(admission, options, resetState),
        flush: flushSettingsCoordinator,
      });
    }),
  );
}
