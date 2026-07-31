// Native CLI catalog discovery and bounded child-process ownership live at this boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
import { spawn, type ChildProcess as NodeChildProcess } from "node:child_process";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { SubagentEffort } from "../run/model.ts";
import {
  codexArgv,
  prepareCodexCatalogHarness,
  sanitizeLocalCliEnvironment,
  type LocalCliRuntime,
} from "./local-cli-process.ts";
import { terminateProcessTree } from "./process-tree.ts";

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
      }),
    ),
    nextCursor: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  }),
});

export interface NativeRuntimeModel {
  readonly selector: string;
  readonly label: string;
  readonly description: string;
  readonly supportedEfforts: ReadonlyArray<SubagentEffort>;
  readonly isDefault: boolean;
}

export class NativeModelCatalogError extends Schema.TaggedErrorClass<NativeModelCatalogError>()(
  "NativeModelCatalogError",
  {
    runtime: Schema.Literals(["claude", "codex"]),
    code: Schema.String,
    message: Schema.String,
  },
) {}

export interface NativeModelCatalogShape {
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

const catalogFrames = (
  runtime: LocalCliRuntime,
): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  runtime === "claude"
    ? [
        {
          type: "control_request",
          request_id: CATALOG_REQUEST_ID,
          request: { subtype: "initialize" },
        },
      ]
    : [
        {
          id: "pi-subagents-initialize",
          method: "initialize",
          params: {
            clientInfo: { name: "pi-subagents", title: "pi-subagents", version: "1" },
            capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
          },
        },
        { method: "initialized" },
        {
          id: CATALOG_REQUEST_ID,
          method: "model/list",
          params: { includeHidden: false, limit: 100 },
        },
      ];

const isClaudeCatalogErrorResponse = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const response = record.response;
  return (
    record.type === "control_response" &&
    response !== null &&
    typeof response === "object" &&
    !Array.isArray(response) &&
    (response as Readonly<Record<string, unknown>>).request_id === CATALOG_REQUEST_ID &&
    (response as Readonly<Record<string, unknown>>).subtype === "error"
  );
};

const isCodexCatalogErrorResponse = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    record.id === CATALOG_REQUEST_ID &&
    record.error !== null &&
    typeof record.error === "object" &&
    !Array.isArray(record.error)
  );
};

const isCatalogResponse = (runtime: LocalCliRuntime, value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  if (runtime === "codex") return record.id === CATALOG_REQUEST_ID;
  if (record.type !== "control_response") return false;
  const response = record.response;
  return (
    response !== null &&
    typeof response === "object" &&
    !Array.isArray(response) &&
    (response as Readonly<Record<string, unknown>>).request_id === CATALOG_REQUEST_ID
  );
};

const runCatalogProcess = (
  runtime: LocalCliRuntime,
  executable: string,
  args: ReadonlyArray<string>,
  frames: ReadonlyArray<Readonly<Record<string, unknown>>>,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMillis: number,
  signal?: AbortSignal | undefined,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let child: NodeChildProcess;
    let buffer = "";
    let outputBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void =>
      release(
        undefined,
        catalogError(runtime, "catalog_canceled", `${runtime} model catalog was canceled.`),
      );

    const release = (value: unknown, error?: NativeModelCatalogError): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void terminateProcessTree(child, "force").then(
        () => (error ? reject(error) : resolve(value)),
        () =>
          reject(
            catalogError(
              runtime,
              "catalog_cleanup_unconfirmed",
              `${runtime} model catalog process cleanup could not be confirmed.`,
            ),
          ),
      );
    };

    if (signal?.aborted) {
      reject(catalogError(runtime, "catalog_canceled", `${runtime} model catalog was canceled.`));
      return;
    }
    try {
      child = spawn(executable, [...args], {
        cwd,
        detached: process.platform !== "win32",
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      reject(
        catalogError(
          runtime,
          "catalog_executable_unavailable",
          `${runtime} model catalog executable is unavailable.`,
        ),
      );
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("spawn", () => {
      const stdin = child.stdin;
      if (!stdin) {
        release(
          undefined,
          catalogError(
            runtime,
            "catalog_transport_unavailable",
            `${runtime} catalog input closed.`,
          ),
        );
        return;
      }
      for (const frame of frames) stdin.write(`${JSON.stringify(frame)}\n`);
    });
    child.stdin?.on("error", () =>
      release(
        undefined,
        catalogError(runtime, "catalog_transport_unavailable", `${runtime} catalog input failed.`),
      ),
    );
    child.stdout?.on("error", () =>
      release(
        undefined,
        catalogError(runtime, "catalog_transport_unavailable", `${runtime} catalog output failed.`),
      ),
    );
    child.stderr?.on("error", () =>
      release(
        undefined,
        catalogError(
          runtime,
          "catalog_transport_unavailable",
          `${runtime} catalog diagnostics failed.`,
        ),
      ),
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES)
        release(
          undefined,
          catalogError(
            runtime,
            "catalog_output_unbounded",
            `${runtime} model catalog output exceeded its bounded limit.`,
          ),
        );
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        release(
          undefined,
          catalogError(
            runtime,
            "catalog_output_unbounded",
            `${runtime} model catalog output exceeded its bounded limit.`,
          ),
        );
        return;
      }
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch {
          release(
            undefined,
            catalogError(
              runtime,
              "catalog_protocol_invalid",
              `${runtime} catalog emitted invalid JSONL.`,
            ),
          );
          return;
        }
        if (isCatalogResponse(runtime, value)) {
          release(value);
          return;
        }
      }
    });
    child.once("error", () =>
      release(
        undefined,
        catalogError(
          runtime,
          "catalog_executable_unavailable",
          `${runtime} model catalog executable is unavailable.`,
        ),
      ),
    );
    child.once("close", () => {
      if (!settled)
        release(
          undefined,
          catalogError(
            runtime,
            "catalog_response_missing",
            `${runtime} model catalog closed without a model list.`,
          ),
        );
    });
    timer = setTimeout(
      () =>
        release(
          undefined,
          catalogError(
            runtime,
            "catalog_timeout",
            `${runtime} model catalog did not respond within its bounded deadline.`,
          ),
        ),
      timeoutMillis,
    );
    timer.unref();
  });

const decodeClaudeModels = (value: unknown) =>
  Schema.decodeUnknownEffect(ClaudeCatalogResponse)(value).pipe(
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
          isDefault: model.value === "default",
        }),
      ),
    ),
  );

const decodeCodexModels = (value: unknown) =>
  Schema.decodeUnknownEffect(CodexCatalogResponse)(value).pipe(
    Effect.map((response) =>
      response.result.data.map(
        (model): NativeRuntimeModel => ({
          selector: model.model,
          label: model.displayName,
          description: normalizeDescription(model.description),
          supportedEfforts: normalizeEfforts(
            model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
          ),
          isDefault: model.isDefault,
        }),
      ),
    ),
  );

const discoverCatalog = async (
  runtime: LocalCliRuntime,
  executable: string,
  cwd: string,
  sourceEnvironment: NodeJS.ProcessEnv,
  timeoutMillis: number,
  signal: AbortSignal,
  options: NativeModelCatalogLayerOptions,
): Promise<unknown> => {
  if (runtime !== "codex" || !options.agentDirectory)
    return runCatalogProcess(
      runtime,
      executable,
      runtime === "claude" ? claudeArgs() : codexArgv(),
      catalogFrames(runtime),
      cwd,
      sanitizeLocalCliEnvironment(sourceEnvironment, runtime),
      timeoutMillis,
      signal,
    );
  const harness = await prepareCodexCatalogHarness({
    agentDirectory: options.agentDirectory,
    environment: sourceEnvironment,
  });
  let result: unknown;
  let failure: unknown;
  try {
    result = await runCatalogProcess(
      runtime,
      executable,
      harness.args,
      catalogFrames(runtime),
      cwd,
      harness.env,
      timeoutMillis,
      signal,
    );
  } catch (error) {
    failure = error;
  }
  try {
    await harness.release();
  } catch {
    throw catalogError(
      runtime,
      "catalog_cleanup_unconfirmed",
      "Codex model catalog private harness cleanup could not be confirmed.",
    );
  }
  if (failure !== undefined) throw failure;
  return result;
};

interface InFlightCatalogRequest {
  readonly controller: AbortController;
  readonly promise: Promise<unknown>;
  waiters: number;
  settled: boolean;
}

export const makeNativeModelCatalog = (
  options: NativeModelCatalogLayerOptions = {},
): NativeModelCatalogShape => {
  const cache = new Map<string, ReadonlyArray<NativeRuntimeModel>>();
  const inFlight = new Map<string, InFlightCatalogRequest>();

  const acquireRequest = (
    cacheKey: string,
    runtime: LocalCliRuntime,
    cwd: string,
  ): InFlightCatalogRequest => {
    const existing = inFlight.get(cacheKey);
    if (existing) {
      existing.waiters += 1;
      return existing;
    }
    const controller = new AbortController();
    const executable = options.executables?.[runtime] ?? runtime;
    const sourceEnvironment = options.environment ?? process.env;
    const request: InFlightCatalogRequest = {
      controller,
      promise: discoverCatalog(
        runtime,
        executable,
        cwd,
        sourceEnvironment,
        options.timeoutMillis ?? CATALOG_TIMEOUT_MILLIS,
        controller.signal,
        options,
      ),
      waiters: 1,
      settled: false,
    };
    inFlight.set(cacheKey, request);
    void request.promise.then(
      () => {
        request.settled = true;
      },
      () => {
        request.settled = true;
      },
    );
    return request;
  };

  const releaseRequest = (cacheKey: string, request: InFlightCatalogRequest): void => {
    request.waiters -= 1;
    if (request.waiters > 0) return;
    if (inFlight.get(cacheKey) === request) inFlight.delete(cacheKey);
    if (!request.settled) request.controller.abort();
  };

  return {
    list: (runtime, cwd) =>
      Effect.suspend(() => {
        const cacheKey = `${runtime}\u0000${cwd}`;
        const cached = cache.get(cacheKey);
        if (cached) return Effect.succeed(cached);
        const request = acquireRequest(cacheKey, runtime, cwd);
        return Effect.tryPromise({
          try: () => request.promise,
          catch: (error) =>
            error instanceof NativeModelCatalogError
              ? error
              : catalogError(
                  runtime,
                  "catalog_failed",
                  `Unable to load the ${runtime} model catalog.`,
                ),
        }).pipe(
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
            return (
              runtime === "claude" ? decodeClaudeModels(value) : decodeCodexModels(value)
            ).pipe(
              Effect.mapError(() =>
                catalogError(
                  runtime,
                  "catalog_protocol_invalid",
                  `${runtime} returned an invalid model catalog.`,
                ),
              ),
            );
          }),
          Effect.tap((models) => Effect.sync(() => void cache.set(cacheKey, models))),
          Effect.ensuring(Effect.sync(() => releaseRequest(cacheKey, request))),
        );
      }),
  };
};

export class NativeModelCatalog extends Context.Service<
  NativeModelCatalog,
  NativeModelCatalogShape
>()("pi-subagents/boundary/native-model-catalog/NativeModelCatalog") {
  static readonly layer = (
    options: NativeModelCatalogLayerOptions = {},
  ): Layer.Layer<NativeModelCatalog> => Layer.succeed(this, makeNativeModelCatalog(options));
}
