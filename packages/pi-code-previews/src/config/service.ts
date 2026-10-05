/** Internal Effect settings service room. Public persistence door: `store.ts`. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import {
  AgentDirectory,
  freezeSnapshot,
  JsonDocumentStore,
  type JsonDocumentError,
} from "pi-cosmic-core";
import {
  flushSettingsCoordinator,
  type SettingsAdmission,
  withSettingsCoordinator,
} from "./coordinator";
import { defaultCodePreviewSettings } from "./defaults";
import {
  loadSettingsSaveContextEffect,
  resetSettingsStateEffect,
  saveSettingsStateEffect,
  type LoadSettingsOptions,
  type SettingsDocumentDependencies,
  type SettingsSaveContext,
} from "./document-store";
import type { CodePreviewSettings } from "./schema";
import {
  cloneCodePreviewSettings,
  setCodePreviewSettings,
  setCodePreviewSettingsProblems,
} from "./state";

export interface SaveSettingsOptions {
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

export class CodePreviewSettingsService extends Context.Service<
  CodePreviewSettingsService,
  CodePreviewSettingsServiceContract
>()("pi-code-previews/config/service/CodePreviewSettingsService") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const agentDirectory = yield* AgentDirectory;
      const documents = yield* JsonDocumentStore;
      const path = yield* Path.Path;
      const deps: SettingsDocumentDependencies = { path, agentDir: agentDirectory, documents };
      // The Ref starts private. Layer construction must not publish settings from an unstarted runtime.
      const state = yield* Ref.make(
        freezeSnapshot<SettingsSaveContext>({
          globalBaseline: defaultCodePreviewSettings,
          baseline: defaultCodePreviewSettings,
          loaded: defaultCodePreviewSettings,
        }),
      );
      const readFromDisk = (options: LoadSettingsOptions) =>
        loadSettingsSaveContextEffect(deps, options);

      const load = (admission: SettingsAdmission, options: LoadSettingsOptions = {}) =>
        withSettingsCoordinator(admission, (coordinator) =>
          Effect.gen(function* () {
            const { context, problems } = yield* readFromDisk(options);
            const loaded = freezeSnapshot(context);
            yield* Ref.set(state, loaded);
            yield* Effect.sync(() => {
              coordinator.publishIfCurrent(() => {
                setCodePreviewSettings(loaded.loaded);
                setCodePreviewSettingsProblems(problems);
              });
            });
            return cloneCodePreviewSettings(loaded.loaded);
          }),
        );

      const modify = (
        admission: SettingsAdmission,
        options: SaveSettingsOptions,
        write: (
          current: SettingsSaveContext,
          afterCommit: (context: SettingsSaveContext) => Effect.Effect<void>,
        ) => Effect.Effect<unknown, JsonDocumentError>,
      ) =>
        withSettingsCoordinator(admission, (coordinator) =>
          Effect.gen(function* () {
            // A newer successful publication makes this save obsolete before document mutation.
            if (!coordinator.isCurrent()) return;
            let current = yield* Ref.get(state);
            if (options.rehydrate !== undefined) {
              current = freezeSnapshot((yield* readFromDisk(options.rehydrate)).context);
              yield* Ref.set(state, current);
            }
            yield* write(current, (nextContext) => {
              // Preflight the complete plain state before rename. afterCommit already holds the
              // coordinator and document locks, so it must not reacquire either one.
              const committed = freezeSnapshot<SettingsSaveContext>(nextContext);
              return Ref.set(state, committed).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    coordinator.publishIfCurrent(() => setCodePreviewSettings(committed.loaded));
                  }),
                ),
              );
            });
          }),
        );

      const save = (
        settings: CodePreviewSettings,
        admission: SettingsAdmission,
        options: SaveSettingsOptions = {},
      ) =>
        modify(admission, options, (current, afterCommit) =>
          saveSettingsStateEffect(deps, settings, current, afterCommit),
        );

      const reset = (admission: SettingsAdmission, options: SaveSettingsOptions = {}) =>
        modify(admission, options, (current, afterCommit) =>
          resetSettingsStateEffect(deps, current, afterCommit),
        );

      return CodePreviewSettingsService.of({
        load,
        save,
        reset,
        flush: flushSettingsCoordinator,
      });
    }),
  );
}
