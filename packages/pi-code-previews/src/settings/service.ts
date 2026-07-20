import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { AgentDirectory, JsonDocumentStore, type JsonDocumentError } from "pi-cosmic-core";
import { CodePreviewEnvironmentService } from "./environment-service";
import { cloneCodePreviewSettings, setCodePreviewSettings } from "./state";
import {
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
  readonly load: (options?: LoadSettingsOptions) => Effect.Effect<CodePreviewSettings>;
  readonly loadFromDisk: (
    options?: LoadSettingsOptions,
  ) => Effect.Effect<CodePreviewSettings | undefined>;
  readonly save: (
    settings: CodePreviewSettings,
    context?: SettingsSaveContext,
  ) => Effect.Effect<void, JsonDocumentError>;
  readonly flush: Effect.Effect<void>;
  readonly snapshot: Effect.Effect<CodePreviewSettingsState>;
}

let saveContextProjection: SettingsSaveContext | undefined;

function publishSaveContext(context: SettingsSaveContext): void {
  saveContextProjection = Object.freeze({
    ...context,
    baseline: Object.freeze(cloneCodePreviewSettings(context.baseline)),
    loaded: Object.freeze(cloneCodePreviewSettings(context.loaded)),
    globalOverrides: Object.freeze({ ...context.globalOverrides }),
    globalDocument: Object.freeze({ ...context.globalDocument }),
  });
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
      const initial: CodePreviewSettingsState = {
        settings: cloneCodePreviewSettings(environment.defaults),
        saveContext: saveContextProjection ?? defaultSettingsSaveContext(environment.defaults),
      };
      const state = yield* SynchronizedRef.make(initial);
      const coordination = yield* Semaphore.make(1);
      publishSaveContext(initial.saveContext);
      setCodePreviewSettings(initial.settings);

      const loadFromDisk = (options: LoadSettingsOptions = {}) =>
        coordination.withPermits(1)(
          Effect.gen(function* () {
            const loaded = yield* loadSettingsStateEffect(options).pipe(
              Effect.provide(dependencies),
            );
            const settings = loaded.settings ?? environment.defaults;
            const next = {
              settings: cloneCodePreviewSettings(settings),
              saveContext: loaded.saveContext,
            } satisfies CodePreviewSettingsState;
            yield* SynchronizedRef.set(state, next);
            publishSaveContext(next.saveContext);
            return loaded.settings;
          }),
        );

      const load = (options: LoadSettingsOptions = {}) =>
        loadFromDisk(options).pipe(
          Effect.map((saved) => saved ?? environment.defaults),
          Effect.tap((settings) => Effect.sync(() => setCodePreviewSettings(settings))),
          Effect.map(cloneCodePreviewSettings),
        );

      const save = (settings: CodePreviewSettings, context?: SettingsSaveContext) =>
        coordination.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* SynchronizedRef.get(state);
            yield* saveSettingsStateEffect(settings, context ?? current.saveContext).pipe(
              Effect.provide(dependencies),
            );
          }),
        );

      return CodePreviewSettingsService.of({
        load,
        loadFromDisk,
        save,
        flush: coordination.withPermits(1)(Effect.void),
        snapshot: SynchronizedRef.get(state),
      });
    }),
  );
}
