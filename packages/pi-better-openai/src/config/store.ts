import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Num from "effect/Number";
import type * as Path from "effect/Path";
import * as Rec from "effect/Record";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { AgentDirectory } from "pi-cosmic-core/platform/agent-directory";
import {
  commitPreferredScope,
  makeScopedConfigStore,
  type ScopedConfigMetadata,
} from "pi-cosmic-core/config/scoped-config-store";
import { decodeTolerantFields } from "pi-cosmic-core/config/tolerant-fields";
import { freezeSnapshot } from "pi-cosmic-core/projection";
import { type JsonDocumentStore, type JsonObject } from "pi-cosmic-core/platform/json-document";
import { prepareSettingUpdate } from "./options.ts";
import {
  CONFIG_BASENAME,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_USAGE_CONFIG,
  ImageOutputFormatSchema,
  ImageSaveModeSchema,
  type ResolvedConfig,
} from "./schema.ts";

export class OpenAIConfigError extends Schema.TaggedError<
  OpenAIConfigError,
  { readonly brand: unique symbol }
>()("OpenAIConfigError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

const decodeRoot = decodeTolerantFields(
  {
    persistState: Schema.Boolean,
    desiredActive: Schema.Boolean,
    usage: UnknownRecordSchema,
    compaction: UnknownRecordSchema,
    image: UnknownRecordSchema,
  },
  { path: "config" },
);
const decodeUsage = decodeTolerantFields(
  {
    refreshIntervalMs: Schema.Finite,
    showOnlyOnSubscriptionModels: Schema.Boolean,
    showResetTimes: Schema.Boolean,
  },
  { path: "usage" },
);
const decodeCompaction = decodeTolerantFields({ enabled: Schema.Boolean }, { path: "compaction" });
const decodeImage = decodeTolerantFields(
  {
    enabled: Schema.Boolean,
    defaultModel: Schema.Trim.check(Schema.isNonEmpty()),
    defaultSave: ImageSaveModeSchema,
    outputFormat: ImageOutputFormatSchema,
    timeoutMs: Schema.Finite,
  },
  { path: "image" },
);

function decodeConfig(value: JsonObject) {
  const root = decodeRoot(value).value;
  const usage = decodeUsage(root.usage).value;
  const compaction = decodeCompaction(root.compaction).value;
  const image = decodeImage(root.image).value;
  return {
    ...(root.persistState !== undefined && { persistState: root.persistState }),
    ...(root.desiredActive !== undefined && { desiredActive: root.desiredActive }),
    ...(Rec.keys<string, unknown>(usage).length > 0 && { usage }),
    ...(compaction.enabled !== undefined && { compaction }),
    ...(Rec.keys<string, unknown>(image).length > 0 && { image }),
  };
}

function resolveConfigFiles(
  metadata: ScopedConfigMetadata,
  project: ReturnType<typeof decodeConfig> | undefined,
  global: ReturnType<typeof decodeConfig> | undefined,
): ResolvedConfig {
  const usage = { ...DEFAULT_USAGE_CONFIG, ...global?.usage, ...project?.usage };
  const image = { ...DEFAULT_IMAGE_CONFIG, ...global?.image, ...project?.image };
  return {
    ...metadata,
    persistState: project?.persistState ?? global?.persistState ?? DEFAULT_CONFIG.persistState,
    desiredActive: project?.desiredActive ?? global?.desiredActive ?? DEFAULT_CONFIG.desiredActive,
    usage: {
      ...usage,
      refreshIntervalMs: Num.clamp(usage.refreshIntervalMs, {
        minimum: 15_000,
        maximum: 10 * 60_000,
      }),
    },
    compaction: { ...DEFAULT_COMPACTION_CONFIG, ...global?.compaction, ...project?.compaction },
    image: {
      ...image,
      timeoutMs: Num.clamp(image.timeoutMs, { minimum: 30_000, maximum: 5 * 60_000 }),
    },
  };
}

const store = makeScopedConfigStore({
  error: OpenAIConfigError,
  label: "Better OpenAI",
  spanPrefix: "OpenAIConfig",
  projectConfigDirectory: CONFIG_DIR_NAME,
  basename: CONFIG_BASENAME,
  decode: decodeConfig,
  defaultDocument: () => DEFAULT_CONFIG,
  resolve: resolveConfigFiles,
});

export const {
  configPaths,
  modifyConfig,
  readConfig,
  readRawConfig,
  resolveCommittedConfig,
  resolveConfig,
  writeConfig,
} = store;

interface ConfigChange {
  readonly previous: ResolvedConfig;
  readonly config: ResolvedConfig;
  readonly reason: "load" | "setting" | "fast";
}

interface ConfigConsumer {
  readonly commit: (change: ConfigChange) => Effect.Effect<void>;
  readonly settled?: (change: ConfigChange) => Effect.Effect<void>;
}

const settle = ({
  change,
  listeners,
}: {
  readonly change: ConfigChange;
  readonly listeners: ReadonlyArray<ConfigConsumer>;
}) =>
  Effect.forEach(listeners, (consumer) => consumer.settled?.(change) ?? Effect.void, {
    discard: true,
  });

interface OpenAIConfigServiceOptions {
  readonly cwd: string;
  readonly projectTrusted?: boolean;
  readonly projection: MutableRef.MutableRef<ResolvedConfig | undefined>;
  readonly canPublish?: () => boolean;
}

export class OpenAIConfigService extends Context.Service<OpenAIConfigService>()(
  "pi-better-openai/config/store/OpenAIConfigService",
  {
    make: Effect.fnUntraced(function* (options: OpenAIConfigServiceOptions) {
      const dependencies = yield* Effect.context<Path.Path | JsonDocumentStore>();
      const provide = <A, E>(effect: Effect.Effect<A, E, Path.Path | JsonDocumentStore>) =>
        Effect.provideContext(effect, dependencies);
      const agentDir = yield* AgentDirectory;
      const load = resolveConfig(options.cwd, agentDir, options.projectTrusted === true);
      const initial = freezeSnapshot(yield* load);
      const state = yield* Ref.make(initial);
      const consumers = yield* Ref.make<ReadonlyArray<ConfigConsumer>>([]);
      const changes = yield* Semaphore.make(1);
      const publish = (config: ResolvedConfig) => {
        if (options.canPublish?.() !== false) MutableRef.set(options.projection, config);
      };
      yield* Effect.sync(() => publish(initial));

      const install = (change: ConfigChange, listeners: ReadonlyArray<ConfigConsumer>) =>
        Effect.uninterruptible(
          Effect.forEach(listeners, (consumer) => consumer.commit(change), { discard: true }).pipe(
            Effect.andThen(Ref.set(state, change.config)),
            Effect.andThen(Effect.sync(() => publish(change.config))),
          ),
        );
      const modify = Effect.fn("OpenAIConfigService.modify")(function* (
        current: ResolvedConfig,
        update: (document: JsonObject) => JsonObject,
        reason: "setting" | "fast",
        afterCommit: Effect.Effect<void> = Effect.void,
      ) {
        const previous = yield* Ref.get(state);
        const listeners = yield* Ref.get(consumers);
        const config = yield* commitPreferredScope(store, current, update, (next) =>
          install({ previous, config: freezeSnapshot(next), reason }, listeners).pipe(
            Effect.andThen(afterCommit),
          ),
        );
        return { change: { previous, config, reason }, listeners };
      });

      return {
        get: Ref.get(state),
        readConfigDocument: provide(
          Ref.get(state).pipe(Effect.flatMap((config) => readRawConfig(config.configPath))),
        ),
        observe: (consumer: ConfigConsumer) =>
          Effect.acquireRelease(Effect.void, () =>
            Ref.get(consumers).pipe(
              Effect.flatMap((current) =>
                current.includes(consumer)
                  ? changes.withPermit(
                      Ref.update(consumers, (entries) =>
                        entries.filter((entry) => entry !== consumer),
                      ),
                    )
                  : Effect.void,
              ),
            ),
          ).pipe(
            Effect.andThen(
              changes.withPermit(
                Effect.gen(function* () {
                  const config = yield* Ref.get(state);
                  yield* consumer.commit({ previous: config, config, reason: "load" });
                  yield* Ref.update(consumers, (current) => [...current, consumer]);
                }),
              ),
            ),
          ),
        updateSetting: (id: string, value: string) =>
          provide(
            prepareSettingUpdate(id, value).pipe(
              Effect.flatMap((update) =>
                changes.withPermit(
                  load.pipe(Effect.flatMap((fresh) => modify(fresh, update, "setting"))),
                ),
              ),
              Effect.flatMap(settle),
            ),
          ),
        persistFast: (desiredActive: boolean, afterCommit: Effect.Effect<void>) =>
          provide(
            changes.withPermit(
              Effect.gen(function* () {
                const fresh = yield* load;
                if (!fresh.persistState) {
                  yield* Effect.uninterruptible(afterCommit);
                  return;
                }
                yield* modify(fresh, (raw) => ({ ...raw, desiredActive }), "fast", afterCommit);
              }),
            ),
          ),
      };
    }),
  },
) {
  static layer(options: OpenAIConfigServiceOptions) {
    return Layer.effect(this, this.make(options));
  }
}
