import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { confirmEffectProcessClose, provideNodeProcess } from "pi-cosmic-core/platform/process";
import { confirmProcessGroupExit, signalProcessGroup } from "pi-cosmic-core/platform/process-tree";
import { guardProcessGroupAtHostExit } from "pi-cosmic-core/platform/process-group-exit-guard";
import { hasControlCharacter } from "pi-cosmic-core/security";
import { nodeFilePlatformLayer } from "pi-cosmic-core/platform/node-file";
import { SafeFile } from "pi-cosmic-core/platform/safe-file";
import { readClaudeModelPreference } from "./claude-model-preference.ts";
import { claudeInitializeFrame } from "../backend/local-claude-protocol.ts";
import { SUBAGENT_EFFORTS, type SubagentEffort } from "../domain/routing.ts";
import { sanitizeLocalCliEnvironment } from "./local-cli-harness.ts";
import type { LocalCliRuntime } from "./local-cli-process.ts";
import { decodeUnknownJsonOption } from "./wire-shared.ts";

const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_SELECTOR_CHARS = 256;
const MAX_LABEL_CHARS = 256;
const MAX_DESCRIPTION_CHARS = 4_096;
const CATALOG_TIMEOUT_MILLIS = 10_000;
const CATALOG_REQUEST_ID = "pi-subagents-model-catalog";

const hasNoTerminalControls = Schema.makeFilter((value: string) => !hasControlCharacter(value));
const hasOnlySafeDescriptionControls = Schema.makeFilter(
  (value: string) => !hasControlCharacter(Fn.pipe(value, Str.replace(/[\t\n\r]/gu, ""))),
);
const Selector = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SELECTOR_CHARS),
  hasNoTerminalControls,
);
const Label = Schema.String.check(Schema.isMaxLength(MAX_LABEL_CHARS), hasNoTerminalControls);
const Description = Schema.String.check(
  Schema.isMaxLength(MAX_DESCRIPTION_CHARS),
  hasOnlySafeDescriptionControls,
);
const Effort = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32));

const ClaudeCatalogCorrelatedFrame = Schema.Struct({
  type: Schema.Literal("control_response"),
  response: Schema.Struct({ request_id: Schema.Literal(CATALOG_REQUEST_ID) }),
});
const ClaudeCatalogErrorResponse = Schema.Struct({
  type: Schema.Literal("control_response"),
  response: Schema.Struct({
    subtype: Schema.Literal("error"),
    request_id: Schema.Literal(CATALOG_REQUEST_ID),
    error: Schema.optional(Description),
  }),
});
const ClaudeCatalogResponse = Schema.Struct({
  type: Schema.Literal("control_response"),
  response: Schema.Struct({
    subtype: Schema.Literal("success"),
    request_id: Schema.Literal(CATALOG_REQUEST_ID),
    response: Schema.Struct({
      models: Schema.Array(
        Schema.Struct({
          value: Selector,
          resolvedModel: Selector,
          displayName: Schema.optional(Label),
          description: Schema.optional(Description),
          supportedEffortLevels: Schema.optional(Schema.Array(Effort)),
        }),
      ),
    }),
  }),
});

const isCatalogCorrelated = Schema.is(ClaudeCatalogCorrelatedFrame);
const isCatalogRejected = Schema.is(ClaudeCatalogErrorResponse);
const decodeClaudeCatalog = Schema.decodeUnknownEffect(ClaudeCatalogResponse);
const catalogRequest = `${JSON.stringify(claudeInitializeFrame(CATALOG_REQUEST_ID))}\n`;

export interface NativeRuntimeModel {
  readonly selector: string;
  readonly label: string;
  readonly description: string;
  readonly supportedEfforts: ReadonlyArray<SubagentEffort>;
  readonly isDefault: boolean;
}

class NativeModelCatalogError extends Schema.TaggedError<
  NativeModelCatalogError,
  { readonly brand: unique symbol }
>()("NativeModelCatalogError", {
  runtime: Schema.Literal("claude"),
  code: Schema.String,
  message: Schema.String,
}) {}

export interface NativeModelCatalogContract {
  readonly list: (
    runtime: LocalCliRuntime,
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<NativeRuntimeModel>, NativeModelCatalogError>;
}

export interface NativeModelCatalogLayerOptions {
  readonly executables?: { readonly claude: string } | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}

const catalogError = (runtime: LocalCliRuntime, code: string, message: string) =>
  NativeModelCatalogError.make({ runtime, code, message });

const isSupportedEffort = Schema.is(
  Schema.Literals(Arr.filter(SUBAGENT_EFFORTS, (effort) => effort !== "off")),
);

const normalizeEfforts = (values: ReadonlyArray<string>): ReadonlyArray<SubagentEffort> =>
  Arr.filter(values, isSupportedEffort);

const normalizeDescription = (value: string): string =>
  Str.trim(Fn.pipe(value, Str.replace(/[\t\n\r]/gu, " ")));

const claudeArgs = (probeSelector: string): ReadonlyArray<string> => [
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--model",
  probeSelector,
  "--effort",
  "low",
  "--disable-slash-commands",
  "--no-chrome",
  "--no-session-persistence",
  "--setting-sources",
  "",
  "--settings",
  '{"disableAllHooks":true,"enableAllProjectMcpServers":false}',
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--permission-mode",
  "dontAsk",
  "--tools",
  "",
];

const runCatalogProcess = (
  runtime: LocalCliRuntime,
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Effect.Effect<Schema.Json, NativeModelCatalogError> =>
  Effect.scoped(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const input = new TextEncoder().encode(catalogRequest);
        const child = yield* restore(
          ChildProcess.make(executable, [...args], {
            cwd,
            detached: true,
            env,
            stdin: { stream: Stream.make(input), endOnDone: false },
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGTERM",
            forceKillAfter: 1_000,
          }),
        ).pipe(
          Effect.mapError(() =>
            catalogError(
              runtime,
              "catalog_executable_unavailable",
              `${runtime} model catalog executable is unavailable.`,
            ),
          ),
        );
        // Covers host exits that skip this scope until the group is confirmed gone.
        const exitGuard = yield* guardProcessGroupAtHostExit(Number(child.pid));
        const bounded = <E>(stream: Stream.Stream<Uint8Array, E>, label: string) => {
          let bytes = 0;
          return stream.pipe(
            Stream.mapEffect((chunk) =>
              (bytes += chunk.byteLength) > MAX_OUTPUT_BYTES
                ? Effect.fail(
                    catalogError(
                      runtime,
                      "catalog_output_unbounded",
                      `${runtime} model catalog output exceeded its bounded limit.`,
                    ),
                  )
                : Effect.succeed(chunk),
            ),
            Stream.mapError((error) =>
              Predicate.isTagged(error, "NativeModelCatalogError")
                ? error
                : catalogError(
                    runtime,
                    "catalog_transport_unavailable",
                    `${runtime} catalog ${label} failed.`,
                  ),
            ),
          );
        };
        const reply = bounded(child.stdout, "output").pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.filter((line) => Str.trim(line).length > 0),
          Stream.mapEffect((line) =>
            Effect.fromOption(decodeUnknownJsonOption(line), () =>
              catalogError(
                runtime,
                "catalog_protocol_invalid",
                `${runtime} catalog emitted invalid JSONL.`,
              ),
            ),
          ),
          Stream.filter(isCatalogCorrelated),
          Stream.runHead,
          Effect.flatMap((frame) =>
            Effect.fromOption(frame, () =>
              catalogError(
                runtime,
                "catalog_response_missing",
                `${runtime} model catalog closed without a model list.`,
              ),
            ),
          ),
          Effect.timeoutOrElse({
            duration: CATALOG_TIMEOUT_MILLIS,
            orElse: () =>
              Effect.fail(
                catalogError(
                  runtime,
                  "catalog_timeout",
                  `${runtime} model catalog did not respond within its bounded deadline.`,
                ),
              ),
          }),
        );
        const diagnostics = bounded(child.stderr, "diagnostics").pipe(
          Stream.runDrain,
          Effect.andThen(Effect.never),
        );
        const outcome = yield* restore(Effect.raceFirst(reply, diagnostics)).pipe(Effect.exit);
        const cleanupConfirmed = yield* confirmEffectProcessClose(child, 2_000);
        const groupSignal = signalProcessGroup(Number(child.pid), "SIGKILL");
        const groupConfirmed =
          groupSignal === "absent" || (yield* confirmProcessGroupExit(Number(child.pid), 2_000));
        if (groupConfirmed) yield* exitGuard.release;
        if (!cleanupConfirmed || !groupConfirmed)
          return yield* catalogError(
            runtime,
            "catalog_cleanup_unconfirmed",
            `${runtime} model catalog process cleanup could not be confirmed.`,
          );
        if (Exit.isSuccess(outcome)) return outcome.value;
        return yield* Effect.failCause(outcome.cause);
      }),
    ).pipe(provideNodeProcess),
  );

type ClaudeAdvertisedModel =
  (typeof ClaudeCatalogResponse.Type)["response"]["response"]["models"][number];

const claudeRuntimeModel = (model: ClaudeAdvertisedModel): NativeRuntimeModel => ({
  selector: model.value,
  label: model.displayName ?? model.value,
  description: normalizeDescription(
    model.description ??
      (model.resolvedModel === model.value ? model.value : `Resolves to ${model.resolvedModel}`),
  ),
  supportedEfforts: normalizeEfforts(model.supportedEffortLevels ?? []),
  isDefault: model.value === "default",
});

const withExplicitClaudeModels = (
  models: ReadonlyArray<ClaudeAdvertisedModel>,
): ReadonlyArray<NativeRuntimeModel> => {
  const advertised = new Set(Arr.map(models, (model) => model.value));
  const namers = new Map<string, ClaudeAdvertisedModel>();
  for (const model of models)
    if (model.value !== "default" && !namers.has(model.resolvedModel))
      namers.set(model.resolvedModel, model);
  const added = new Set<string>();
  return Arr.flatMap(models, (model) => {
    const target = model.resolvedModel;
    const namer = namers.get(target) ?? model;
    if (advertised.has(target) || added.has(target) || namer !== model)
      return [claudeRuntimeModel(model)];
    added.add(target);
    return [
      claudeRuntimeModel(model),
      claudeRuntimeModel({
        ...model,
        value: target,
        displayName: model.value === "default" ? undefined : model.displayName,
      }),
    ];
  });
};

const discoverCatalog = (
  runtime: LocalCliRuntime,
  cwd: string,
  options: NativeModelCatalogLayerOptions,
  probeSelector: string,
): Effect.Effect<Schema.Json, NativeModelCatalogError> =>
  runCatalogProcess(
    runtime,
    options.executables?.[runtime] ?? runtime,
    claudeArgs(probeSelector),
    cwd,
    sanitizeLocalCliEnvironment(options.environment ?? process.env),
  );

class CatalogCacheKey extends Data.Class<{
  readonly runtime: LocalCliRuntime;
  readonly cwd: string;
  readonly probeSelector: string;
}> {}

const loadNativeModelCatalog =
  (options: NativeModelCatalogLayerOptions) =>
  (
    key: CatalogCacheKey,
  ): Effect.Effect<ReadonlyArray<NativeRuntimeModel>, NativeModelCatalogError> => {
    const { runtime, cwd } = key;
    const load = (probeSelector: string) =>
      discoverCatalog(runtime, cwd, options, probeSelector).pipe(
        Effect.flatMap((frame) =>
          isCatalogRejected(frame)
            ? Effect.fail(
                catalogError(
                  runtime,
                  "catalog_request_rejected",
                  "Claude Code rejected the bounded model catalog request.",
                ),
              )
            : decodeClaudeCatalog(frame).pipe(
                Effect.map((response) =>
                  withExplicitClaudeModels(response.response.response.models),
                ),
                Effect.mapError(() =>
                  catalogError(
                    runtime,
                    "catalog_protocol_invalid",
                    `${runtime} returned an invalid model catalog.`,
                  ),
                ),
              ),
        ),
      );
    return Effect.gen(function* () {
      const defaults = yield* load("default");
      if (key.probeSelector === "default") return defaults;
      const preferred = yield* load(key.probeSelector);
      return [
        ...new Map(
          Arr.map([...defaults, ...preferred], (model) => [model.selector, model]),
        ).values(),
      ];
    });
  };

const makeNativeModelCatalog = Effect.fn("NativeModelCatalog.make")(function* (
  options: NativeModelCatalogLayerOptions = {},
): Effect.fn.Return<NativeModelCatalogContract, never, SafeFile> {
  const safeFile = yield* SafeFile;
  const cache = yield* Cache.makeWith(loadNativeModelCatalog(options), {
    capacity: 2,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  });
  return {
    list: Effect.fn("NativeModelCatalog.list")(function* (runtime, cwd) {
      const probeSelector = yield* readClaudeModelPreference(
        sanitizeLocalCliEnvironment(options.environment ?? process.env),
        safeFile,
      );
      return yield* Cache.get(cache, new CatalogCacheKey({ runtime, cwd, probeSelector }));
    }),
  } satisfies NativeModelCatalogContract;
});

export class NativeModelCatalog extends Context.Service<
  NativeModelCatalog,
  NativeModelCatalogContract
>()("pi-subagents/boundary/native-model-catalog/NativeModelCatalog") {
  static readonly layer = (
    options: NativeModelCatalogLayerOptions = {},
  ): Layer.Layer<NativeModelCatalog> =>
    Layer.effect(this, makeNativeModelCatalog(options)).pipe(
      Layer.provide(SafeFile.layer.pipe(Layer.provide(nodeFilePlatformLayer))),
    );
}
