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
import {
  defaultSettingsSaveContext,
  loadSettingsSaveContextEffect,
  saveSettingsStateEffect,
  type LoadSettingsOptions,
  type SettingsSaveContext,
} from "./document-store";
import { CodePreviewEnvironmentService } from "./env";
import type { CodePreviewSettings } from "./schema";
import { cloneCodePreviewSettings, setCodePreviewSettings } from "./state";

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
  readonly flush: Effect.Effect<void>;
}

export class CodePreviewSettingsService extends Context.Service<
  CodePreviewSettingsService,
  CodePreviewSettingsServiceContract
>()("pi-code-previews/config/service/CodePreviewSettingsService") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const environment = yield* CodePreviewEnvironmentService;
      const agentDirectory = yield* AgentDirectory;
      const documents = yield* JsonDocumentStore;
      const path = yield* Path.Path;
      const dependencies = Context.make(CodePreviewEnvironmentService, environment).pipe(
        Context.add(AgentDirectory, agentDirectory),
        Context.add(JsonDocumentStore, documents),
        Context.add(Path.Path, path),
      );
      // The Ref starts private. Layer construction must not publish settings from an unstarted runtime.
      const state = yield* Ref.make(
        freezeSnapshot(defaultSettingsSaveContext(environment.defaults)),
      );
      const readFromDisk = (options: LoadSettingsOptions) =>
        loadSettingsSaveContextEffect(options).pipe(Effect.provide(dependencies));

      const load = (admission: SettingsAdmission, options: LoadSettingsOptions = {}) =>
        withSettingsCoordinator(admission, (coordinator) =>
          Effect.gen(function* () {
            const loaded = freezeSnapshot(yield* readFromDisk(options));
            yield* Ref.set(state, loaded);
            yield* Effect.sync(() => {
              coordinator.publishIfCurrent(() => setCodePreviewSettings(loaded.loaded));
            });
            return cloneCodePreviewSettings(loaded.loaded);
          }),
        );

      const save = (
        settings: CodePreviewSettings,
        admission: SettingsAdmission,
        options: SaveSettingsOptions = {},
      ) =>
        withSettingsCoordinator(admission, (coordinator) =>
          Effect.gen(function* () {
            // A newer successful publication makes this save obsolete before document mutation.
            if (!coordinator.isCurrent()) return;
            let current = yield* Ref.get(state);
            if (options.rehydrate !== undefined) {
              current = freezeSnapshot(yield* readFromDisk(options.rehydrate));
              yield* Ref.set(state, current);
            }
            yield* saveSettingsStateEffect(settings, current, (nextContext) => {
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
            }).pipe(Effect.provide(dependencies));
          }),
        );

      return CodePreviewSettingsService.of({
        load,
        save,
        flush: flushSettingsCoordinator,
      });
    }),
  );
}
