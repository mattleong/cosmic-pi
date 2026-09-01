// Native CLI catalog discovery and bounded child-process ownership live at this boundary.
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { confirmEffectProcessClose, provideNodeProcess } from "pi-cosmic-core";
import {
  initializeRequest,
  initializedNotification,
  type CodexInitializeRequest,
  type CodexInitializedNotification,
} from "../backend/local-codex-protocol.ts";
import {
  claudeInitializeFrame,
  type ClaudeInitializeFrame,
} from "../backend/local-claude-protocol.ts";
import type { SubagentEffort } from "../domain/routing.ts";
import {
  codexArgv,
  prepareCodexCatalogHarness,
  sanitizeLocalCliEnvironment,
} from "./local-cli-harness.ts";
import type { LocalCliRuntime } from "./local-cli-process.ts";
import { decodeUnknownJsonOption } from "./wire-shared.ts";

const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_SELECTOR_CHARS = 256;
const MAX_LABEL_CHARS = 256;
const MAX_DESCRIPTION_CHARS = 4_096;
const CATALOG_TIMEOUT_MILLIS = 10_000;
const CATALOG_REQUEST_ID = "pi-subagents-model-catalog";

const containsNoTerminalControls = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
};
const containsOnlySafeDescriptionControls = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159))
      return false;
  }
  return true;
};
const hasNoTerminalControls = Schema.makeFilter(containsNoTerminalControls);
const hasOnlySafeDescriptionControls = Schema.makeFilter(containsOnlySafeDescriptionControls);
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
const ServiceTier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  hasNoTerminalControls,
);

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

const CodexCatalogCorrelatedFrame = Schema.Struct({ id: Schema.Literal(CATALOG_REQUEST_ID) });
const CodexCatalogErrorResponse = Schema.Struct({
  id: Schema.Literal(CATALOG_REQUEST_ID),
  error: Schema.Struct({
    code: Schema.Number.check(Schema.isFinite(), Schema.isInt()),
    message: Description,
    data: Schema.optional(Schema.Unknown),
  }),
});
const CodexCatalogResponse = Schema.Struct({
  id: Schema.Literal(CATALOG_REQUEST_ID),
  result: Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        id: Selector,
        model: Selector,
        displayName: Label,
        description: Description,
        isDefault: Schema.Boolean,
        supportedReasoningEfforts: Schema.Array(
          Schema.Struct({
            reasoningEffort: Effort,
            description: Schema.optional(Description),
          }),
        ),
        serviceTiers: Schema.optional(
          Schema.Array(
            Schema.Struct({
              id: ServiceTier,
              name: Label,
              description: Description,
            }),
          ),
        ),
      }),
    ),
    nextCursor: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  }),
});

const decodeClaudeCatalogCorrelatedFrameOption = Schema.decodeUnknownOption(
  ClaudeCatalogCorrelatedFrame,
);
const decodeCodexCatalogCorrelatedFrameOption = Schema.decodeUnknownOption(
  CodexCatalogCorrelatedFrame,
);
const decodeClaudeCatalogErrorResponseOption = Schema.decodeUnknownOption(
  ClaudeCatalogErrorResponse,
);
const decodeCodexCatalogErrorResponseOption = Schema.decodeUnknownOption(CodexCatalogErrorResponse);
const decodeClaudeCatalogResponseEffect = Schema.decodeUnknownEffect(ClaudeCatalogResponse);
const decodeCodexCatalogResponseEffect = Schema.decodeUnknownEffect(CodexCatalogResponse);

export interface NativeRuntimeModel {
  readonly selector: string;
  readonly label: string;
  readonly description: string;
  readonly supportedEfforts: ReadonlyArray<SubagentEffort>;
  readonly supportedServiceTiers: ReadonlyArray<string>;
  readonly isDefault: boolean;
}

export class NativeModelCatalogError extends Schema.TaggedError<NativeModelCatalogError>()(
  "NativeModelCatalogError",
  {
    runtime: Schema.Literals(["claude", "codex"]),
    code: Schema.String,
    message: Schema.String,
  },
) {}

export interface NativeModelCatalogContract {
  readonly list: (
    runtime: LocalCliRuntime,
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<NativeRuntimeModel>, NativeModelCatalogError>;
}

export interface NativeModelCatalogLayerOptions {
  /** Production private-state root used to isolate Codex configuration. */
  readonly agentDirectory?: string | undefined;
  /** Package-test seam only. Production always uses fixed executable names. */
  readonly executables?: { readonly claude: string; readonly codex: string } | undefined;
  /** Package-test seam only. */
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /** Package-test seam only. */
  readonly timeoutMillis?: number | undefined;
}

const catalogError = (runtime: LocalCliRuntime, code: string, message: string) =>
  new NativeModelCatalogError({ runtime, code, message });

const supportedEffortSet: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const normalizeEfforts = (values: ReadonlyArray<string>): ReadonlyArray<SubagentEffort> =>
  values.filter((value): value is SubagentEffort => supportedEffortSet.has(value));

const normalizeDescription = (value: string): string =>
  value.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("\t", " ").trim();

const claudeArgs = (): ReadonlyArray<string> => [
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--model",
  "default",
  "--effort",
  "low",
  "--disable-slash-commands",
  "--no-chrome",
  "--no-session-persistence",
  "--setting-sources",
  "",
  "--permission-mode",
  "dontAsk",
  "--tools",
  "",
];

interface CodexModelListRequest {
  readonly id: typeof CATALOG_REQUEST_ID;
  readonly method: "model/list";
  readonly params: { readonly includeHidden: false; readonly limit: 100 };
}

type CatalogRequestFrame =
  | ClaudeInitializeFrame
  | CodexInitializeRequest
  | CodexInitializedNotification
  | CodexModelListRequest;

type ClaudeCatalogErrorFrame = Schema.Schema.Type<typeof ClaudeCatalogErrorResponse>;
type CodexCatalogErrorFrame = Schema.Schema.Type<typeof CodexCatalogErrorResponse>;

const catalogFrames = (runtime: LocalCliRuntime): ReadonlyArray<CatalogRequestFrame> =>
  runtime === "claude"
    ? [claudeInitializeFrame(CATALOG_REQUEST_ID)]
    : [
        initializeRequest("pi-subagents-initialize"),
        initializedNotification(),
        {
          id: CATALOG_REQUEST_ID,
          method: "model/list",
          params: { includeHidden: false, limit: 100 },
        },
      ];

const isClaudeCatalogErrorResponse = <ValueInput>(
  value: ValueInput,
): value is ValueInput & ClaudeCatalogErrorFrame =>
  Option.isSome(decodeClaudeCatalogErrorResponseOption(value));

const isCodexCatalogErrorResponse = <ValueInput>(
  value: ValueInput,
): value is ValueInput & CodexCatalogErrorFrame =>
  Option.isSome(decodeCodexCatalogErrorResponseOption(value));

const runCatalogProcess = (
  runtime: LocalCliRuntime,
  executable: string,
  args: ReadonlyArray<string>,
  frames: ReadonlyArray<CatalogRequestFrame>,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMillis: number,
): Effect.Effect<unknown, NativeModelCatalogError> =>
  Effect.scoped(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const decodeCorrelatedFrameOption =
          runtime === "codex"
            ? decodeCodexCatalogCorrelatedFrameOption
            : decodeClaudeCatalogCorrelatedFrameOption;
        const input = new TextEncoder().encode(
          `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
        );
        const child = yield* restore(
          ChildProcess.make(executable, [...args], {
            cwd,
            detached: process.platform !== "win32",
            env,
            stdin: { stream: Stream.make(input), endOnDone: false },
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
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
        let stdoutBytes = 0;
        const reply = child.stdout.pipe(
          Stream.mapEffect((bytes) => {
            stdoutBytes += bytes.byteLength;
            return stdoutBytes > MAX_OUTPUT_BYTES
              ? Effect.fail(
                  catalogError(
                    runtime,
                    "catalog_output_unbounded",
                    `${runtime} model catalog output exceeded its bounded limit.`,
                  ),
                )
              : Effect.succeed(bytes);
          }),
          Stream.mapError((error) =>
            error instanceof NativeModelCatalogError
              ? error
              : catalogError(
                  runtime,
                  "catalog_transport_unavailable",
                  `${runtime} catalog output failed.`,
                ),
          ),
          Stream.decodeText,
          Stream.splitLines,
          Stream.mapEffect((line) => {
            if (!line.trim()) return Effect.succeedNone;
            const parsed = decodeUnknownJsonOption(line);
            if (Option.isNone(parsed))
              return Effect.fail(
                catalogError(
                  runtime,
                  "catalog_protocol_invalid",
                  `${runtime} catalog emitted invalid JSONL.`,
                ),
              );
            const correlated = decodeCorrelatedFrameOption(parsed.value);
            return Effect.succeed(
              correlated._tag === "Some" ? Option.some(parsed.value) : Option.none(),
            );
          }),
          Stream.filter(Option.isSome),
          Stream.map((value) => value.value),
          Stream.runHead,
          Effect.flatMap((value) =>
            Option.isSome(value)
              ? Effect.succeed(value.value)
              : Effect.fail(
                  catalogError(
                    runtime,
                    "catalog_response_missing",
                    `${runtime} model catalog closed without a model list.`,
                  ),
                ),
          ),
        );
        let diagnosticBytes = 0;
        const diagnostics = child.stderr.pipe(
          Stream.mapEffect((bytes) => {
            diagnosticBytes += bytes.byteLength;
            return diagnosticBytes > MAX_OUTPUT_BYTES
              ? Effect.fail(
                  catalogError(
                    runtime,
                    "catalog_output_unbounded",
                    `${runtime} model catalog output exceeded its bounded limit.`,
                  ),
                )
              : Effect.void;
          }),
          Stream.mapError((error) =>
            error instanceof NativeModelCatalogError
              ? error
              : catalogError(
                  runtime,
                  "catalog_transport_unavailable",
                  `${runtime} catalog diagnostics failed.`,
                ),
          ),
          Stream.runDrain,
          // Stderr can close before the stdout decoder drains the final reply.
          // Stay pending after clean EOF while still surfacing overflow/stream failures.
          Effect.andThen(Effect.never),
        );
        const deadline = Effect.sleep(timeoutMillis).pipe(
          Effect.andThen(
            Effect.fail(
              catalogError(
                runtime,
                "catalog_timeout",
                `${runtime} model catalog did not respond within its bounded deadline.`,
              ),
            ),
          ),
        );
        const outcome = yield* restore(
          Effect.raceFirst(reply, Effect.raceFirst(diagnostics, deadline)),
        ).pipe(Effect.exit);
        const cleanupConfirmed = yield* confirmEffectProcessClose(child, 2_000);
        if (!cleanupConfirmed)
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

const decodeClaudeModels = <ValueInput>(value: ValueInput) =>
  decodeClaudeCatalogResponseEffect(value).pipe(
    Effect.map((response) =>
      response.response.response.models.map(
        (model): NativeRuntimeModel => ({
          selector: model.value,
          label: model.displayName ?? model.value,
          description: normalizeDescription(
            model.description ??
              (model.resolvedModel === model.value
                ? model.value
                : `Resolves to ${model.resolvedModel}`),
          ),
          supportedEfforts: normalizeEfforts(model.supportedEffortLevels ?? []),
          supportedServiceTiers: [],
          isDefault: model.value === "default",
        }),
      ),
    ),
  );

const decodeCodexModels = <ValueInput>(value: ValueInput) =>
  decodeCodexCatalogResponseEffect(value).pipe(
    Effect.map((response) =>
      response.result.data.map(
        (model): NativeRuntimeModel => ({
          selector: model.model,
          label: model.displayName,
          description: normalizeDescription(model.description),
          supportedEfforts: normalizeEfforts(
            model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
          ),
          supportedServiceTiers: [...new Set((model.serviceTiers ?? []).map((tier) => tier.id))],
          isDefault: model.isDefault,
        }),
      ),
    ),
  );

const discoverCatalog = Effect.fn("NativeModelCatalog.discover")(function* (
  runtime: LocalCliRuntime,
  executable: string,
  cwd: string,
  sourceEnvironment: NodeJS.ProcessEnv,
  timeoutMillis: number,
  options: NativeModelCatalogLayerOptions,
) {
  if (runtime !== "codex" || !options.agentDirectory)
    return yield* runCatalogProcess(
      runtime,
      executable,
      runtime === "claude" ? claudeArgs() : codexArgv(),
      catalogFrames(runtime),
      cwd,
      sanitizeLocalCliEnvironment(sourceEnvironment, runtime),
      timeoutMillis,
    );
  return yield* Effect.acquireUseRelease(
    prepareCodexCatalogHarness({
      agentDirectory: options.agentDirectory,
      environment: sourceEnvironment,
    }).pipe(
      Effect.mapError(() =>
        catalogError(runtime, "catalog_failed", "Unable to prepare the Codex model catalog."),
      ),
    ),
    (harness) =>
      runCatalogProcess(
        runtime,
        executable,
        harness.args,
        catalogFrames(runtime),
        cwd,
        harness.env,
        timeoutMillis,
      ),
    (harness) =>
      harness.release.pipe(
        Effect.mapError(() =>
          catalogError(
            runtime,
            "catalog_cleanup_unconfirmed",
            "Codex model catalog private harness cleanup could not be confirmed.",
          ),
        ),
      ),
  );
});

class CatalogCacheKey extends Data.Class<{
  readonly runtime: LocalCliRuntime;
  readonly cwd: string;
}> {}

const loadNativeModelCatalog =
  (options: NativeModelCatalogLayerOptions) =>
  (
    key: CatalogCacheKey,
  ): Effect.Effect<ReadonlyArray<NativeRuntimeModel>, NativeModelCatalogError> => {
    const { runtime, cwd } = key;
    const executable = options.executables?.[runtime] ?? runtime;
    const sourceEnvironment = options.environment ?? process.env;
    return discoverCatalog(
      runtime,
      executable,
      cwd,
      sourceEnvironment,
      options.timeoutMillis ?? CATALOG_TIMEOUT_MILLIS,
      options,
    ).pipe(
      Effect.flatMap((value) => {
        if (
          (runtime === "codex" && isCodexCatalogErrorResponse(value)) ||
          (runtime === "claude" && isClaudeCatalogErrorResponse(value))
        )
          return Effect.fail(
            catalogError(
              runtime,
              "catalog_request_rejected",
              `${runtime === "claude" ? "Claude Code" : "Codex"} rejected the bounded model catalog request.`,
            ),
          );
        return (runtime === "claude" ? decodeClaudeModels(value) : decodeCodexModels(value)).pipe(
          Effect.mapError(() =>
            catalogError(
              runtime,
              "catalog_protocol_invalid",
              `${runtime} returned an invalid model catalog.`,
            ),
          ),
        );
      }),
    );
  };

export const makeNativeModelCatalog = (
  options: NativeModelCatalogLayerOptions = {},
): Effect.Effect<NativeModelCatalogContract> =>
  // One session cwd can cache one key for each of the two native runtimes.
  Cache.makeWith(loadNativeModelCatalog(options), {
    capacity: 2,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  }).pipe(
    Effect.map((cache) => ({
      list: (runtime, cwd) => Cache.get(cache, new CatalogCacheKey({ runtime, cwd })),
    })),
  );

export class NativeModelCatalog extends Context.Service<
  NativeModelCatalog,
  NativeModelCatalogContract
>()("pi-subagents/boundary/native-model-catalog/NativeModelCatalog") {
  static readonly layer = (
    options: NativeModelCatalogLayerOptions = {},
  ): Layer.Layer<NativeModelCatalog> => Layer.effect(this, makeNativeModelCatalog(options));
}
