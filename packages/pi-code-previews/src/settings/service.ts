import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import {
  AgentDirectory,
  freezeSnapshot,
  JsonDocumentStore,
  makeFrozenProjection,
  type JsonDocumentError,
  type ProjectionError,
} from "pi-cosmic-core";
import { CodePreviewEnvironmentService } from "./environment-service";
import { cloneCodePreviewSettings, setCodePreviewSettings } from "./state";
import {
  CodePreviewSettingsLoadError,
  defaultSettingsSaveContext,
  loadSettingsStateEffect,
  saveSettingsStateEffect,
  type LoadSettingsOptions,
  type SettingsSaveContext,
} from "./document-store";
import type { CodePreviewSettings } from "./schema";

export interface CodePreviewSettingsState {
  readonly settings: CodePreviewSettings;
  readonly saveContext: SettingsSaveContext;
}

export interface CodePreviewSettingsServiceShape {
  readonly load: (
    options?: LoadSettingsOptions,
  ) => Effect.Effect<CodePreviewSettings, ProjectionError>;
  readonly loadFromDisk: (
    options?: LoadSettingsOptions,
  ) => Effect.Effect<
    CodePreviewSettings | undefined,
    CodePreviewSettingsLoadError | ProjectionError
  >;
  readonly save: (
    settings: CodePreviewSettings,
    context?: SettingsSaveContext,
  ) => Effect.Effect<void, JsonDocumentError | ProjectionError>;
  readonly flush: Effect.Effect<void, ProjectionError>;
  readonly snapshot: Effect.Effect<CodePreviewSettingsState>;
}

let saveContextProjection: SettingsSaveContext | undefined;

function publishState(state: CodePreviewSettingsState): void {
  setCodePreviewSettings(state.settings);
  saveContextProjection = state.saveContext;
}

export function settingsSaveContextProjection(): SettingsSaveContext | undefined {
  return saveContextProjection;
}

export class CodePreviewSettingsService extends Context.Service<
  CodePreviewSettingsService,
  CodePreviewSettingsServiceShape
>()("pi-code-previews/settings/service/CodePreviewSettingsService") {
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
      // Every session starts from its own environment defaults. The process projection is output
      // only and must never seed a later session's persistence context.
      const initial: CodePreviewSettingsState = {
        settings: cloneCodePreviewSettings(environment.defaults),
        saveContext: defaultSettingsSaveContext(environment.defaults),
      };
      const state = yield* makeFrozenProjection(initial, (current) => current, publishState);
      const operations = yield* Semaphore.make(1);

      const loadFromDisk = (options: LoadSettingsOptions = {}) =>
        operations.withPermits(1)(
          state.transition(() =>
            loadSettingsStateEffect(options).pipe(
              Effect.provide(dependencies),
              Effect.map((loaded) => {
                const settings = cloneCodePreviewSettings(loaded.settings ?? environment.defaults);
                return [loaded.settings, { settings, saveContext: loaded.saveContext }] as const;
              }),
            ),
          ),
        );

      const load = (options: LoadSettingsOptions = {}) =>
        loadFromDisk(options).pipe(
          Effect.map((saved) => cloneCodePreviewSettings(saved ?? environment.defaults)),
        );

      const save = (settings: CodePreviewSettings, context?: SettingsSaveContext) =>
        operations.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* state.getState;
            yield* saveSettingsStateEffect(
              settings,
              context ?? current.saveContext,
              (saveContext) => {
                // This callback is evaluated before the document write. Preflight the exact plain
                // projection now so the post-rename hook performs only an invariant-safe swap.
                const committedState = freezeSnapshot<CodePreviewSettingsState>({
                  settings: cloneCodePreviewSettings(saveContext.loaded),
                  saveContext,
                });
                return state
                  .transition(() => Effect.succeed([undefined, committedState] as const))
                  .pipe(Effect.orDie);
              },
            ).pipe(Effect.provide(dependencies));
          }),
        );

      return CodePreviewSettingsService.of({
        load,
        loadFromDisk,
        save,
        // The operation semaphore is a FIFO barrier behind every save/load that has entered the
        // service. The Promise-shaped Pi close edge awaits this before disposal.
        flush: operations.withPermits(1)(Effect.void),
        snapshot: state.getState,
      });
    }),
  );
}
