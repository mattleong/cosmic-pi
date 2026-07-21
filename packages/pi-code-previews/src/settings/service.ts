import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import {
  AgentDirectory,
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
} from "./store-core";
import type { CodePreviewSettings } from "./types";

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
  saveContextProjection = state.saveContext;
  setCodePreviewSettings(state.settings);
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

      const loadFromDisk = (options: LoadSettingsOptions = {}) =>
        state.transition(() =>
          loadSettingsStateEffect(options).pipe(
            Effect.provide(dependencies),
            Effect.map((loaded) => {
              const settings = cloneCodePreviewSettings(loaded.settings ?? environment.defaults);
              return [loaded.settings, { settings, saveContext: loaded.saveContext }] as const;
            }),
          ),
        );

      const load = (options: LoadSettingsOptions = {}) =>
        loadFromDisk(options).pipe(
          Effect.map((saved) => cloneCodePreviewSettings(saved ?? environment.defaults)),
        );

      const save = (settings: CodePreviewSettings, context?: SettingsSaveContext) =>
        state.transition((current) =>
          saveSettingsStateEffect(settings, context ?? current.saveContext).pipe(
            Effect.provide(dependencies),
            Effect.map(
              (saveContext) =>
                [undefined, { settings: cloneCodePreviewSettings(settings), saveContext }] as const,
            ),
          ),
        );

      return CodePreviewSettingsService.of({
        load,
        loadFromDisk,
        save,
        // A no-op transition is a FIFO barrier behind every save that has already entered the
        // synchronized state. The Promise-shaped Pi close edge awaits this before disposal.
        flush: state.transition((current) => Effect.succeed([undefined, current] as const)),
        snapshot: state.getState,
      });
    }),
  );
}
