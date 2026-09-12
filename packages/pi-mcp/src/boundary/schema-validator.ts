import { fileURLToPath } from "node:url";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  runBoundedProcessNode,
  type BoundedProcessError,
  type BoundedProcessResult,
} from "pi-cosmic-core";
import { boundaryError } from "../client/errors.ts";
import type { McpBoundaryError } from "../client/errors.ts";
import {
  encodeSchemaValidationRequest,
  JSON_SCHEMA_VALIDATOR_LIMITS,
} from "../validation/schema-policy.ts";

export { JSON_SCHEMA_VALIDATOR_LIMITS } from "../validation/schema-policy.ts";

export type JsonSchemaValidationOutcome = "not-sent" | "completed";

const encodeRequest = (
  schema: Schema.Json,
  data: Schema.Json,
  outcome: JsonSchemaValidationOutcome,
): Effect.Effect<Uint8Array, McpBoundaryError> =>
  Effect.try({
    try: () => encodeSchemaValidationRequest(schema, data),
    catch: () =>
      boundaryError(
        "invalid-input",
        outcome,
        "JSON Schema input is invalid or exceeds its limits.",
      ),
  });

const helperReplySchema = Schema.Union([
  Schema.Struct({ valid: Schema.Literal(true) }),
  Schema.Struct({ valid: Schema.Literal(false) }),
]);

const decodeHelperReply = (
  stdout: string,
  outcome: JsonSchemaValidationOutcome,
): Effect.Effect<typeof helperReplySchema.Type, McpBoundaryError> =>
  Schema.decodeEffect(Schema.fromJsonString(helperReplySchema))(stdout, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(() =>
      boundaryError("unavailable", outcome, "Schema validator returned an invalid response."),
    ),
  );

export interface JsonSchemaProcessRunner {
  (
    input: Uint8Array,
    onCleanup: (confirmed: boolean) => void,
  ): Effect.Effect<BoundedProcessResult, BoundedProcessError>;
}

export interface JsonSchemaValidatorOptions {
  /** Test seam for process lifecycle, deadline, and protocol faults. */
  readonly processRunner?: JsonSchemaProcessRunner | undefined;
}

const runSchemaHelper: JsonSchemaProcessRunner = (input, onCleanup) =>
  runBoundedProcessNode({
    executable: process.execPath,
    args: [fileURLToPath(new URL("./schema-validator-helper.mjs", import.meta.url))],
    stdin: input,
    stdoutLimitBytes: JSON_SCHEMA_VALIDATOR_LIMITS.maximumResponseBytes,
    stderrLimitBytes: 256,
    totalOutputLimitBytes: JSON_SCHEMA_VALIDATOR_LIMITS.maximumResponseBytes + 256,
    timeoutMillis: JSON_SCHEMA_VALIDATOR_LIMITS.timeoutMillis,
    cleanupTimeoutMillis: JSON_SCHEMA_VALIDATOR_LIMITS.cleanupTimeoutMillis,
    onCleanup,
    windowsHide: true,
  });

// A validator process is intentionally never queued. This cap is shared by
// independently constructed session runtimes in the same Pi process.
const processAdmission = Semaphore.makeUnsafe(1);
// Cleanup uncertainty must survive rebuilding a service or session. Test runners
// own separate records; every production service uses the same fixed runner.
const disabledByRunner = new WeakMap<JsonSchemaProcessRunner, Ref.Ref<boolean>>();

const outcomeKind = (outcome: JsonSchemaValidationOutcome): "invalid-input" | "protocol" =>
  outcome === "not-sent" ? "invalid-input" : "protocol";

const unavailable = (outcome: JsonSchemaValidationOutcome) =>
  boundaryError("unavailable", outcome, "Schema validator helper is unavailable.");

const validateWithProcess = (
  input: Uint8Array,
  outcome: JsonSchemaValidationOutcome,
  runner: JsonSchemaProcessRunner,
  disabled: Ref.Ref<boolean>,
): Effect.Effect<void, McpBoundaryError> => {
  let cleanupConfirmed = false;
  const invoke = Effect.try({
    try: () =>
      runner(input, (confirmed) => {
        cleanupConfirmed = confirmed;
      }),
    catch: () => unavailable(outcome),
  }).pipe(
    Effect.flatMap((effect) => effect),
    Effect.mapError(() => unavailable(outcome)),
  );

  return invoke.pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (result.cleanupUnconfirmed) cleanupConfirmed = false;
      }),
    ),
    Effect.ensuring(
      Effect.suspend(() => (cleanupConfirmed ? Effect.void : Ref.set(disabled, true))),
    ),
    Effect.flatMap((result) => {
      if (!cleanupConfirmed || result.cleanupUnconfirmed)
        return Effect.fail(
          boundaryError("cleanup", outcome, "Schema validator cleanup was not confirmed."),
        );
      if (result.timedOut)
        return Effect.fail(
          boundaryError("timeout", outcome, "Schema validation exceeded its deadline."),
        );
      if (result.overflowed)
        return Effect.fail(
          boundaryError("output-limit", outcome, "Schema validator output exceeded its limit."),
        );
      if (
        !result.dispatched ||
        result.code !== 0 ||
        result.signal !== null ||
        result.stderr.length > 0
      )
        return Effect.fail(unavailable(outcome));
      const responseBytes = new TextEncoder().encode(result.stdout).byteLength;
      if (responseBytes > JSON_SCHEMA_VALIDATOR_LIMITS.maximumResponseBytes)
        return Effect.fail(
          boundaryError("output-limit", outcome, "Schema validator output exceeded its limit."),
        );
      return decodeHelperReply(result.stdout, outcome).pipe(
        Effect.flatMap((reply) =>
          reply.valid
            ? Effect.void
            : Effect.fail(
                boundaryError(
                  outcomeKind(outcome),
                  outcome,
                  "JSON data does not match the remote schema.",
                ),
              ),
        ),
      );
    }),
  );
};

const mapFailure = (
  outcome: JsonSchemaValidationOutcome,
  cause: Cause.Cause<McpBoundaryError>,
): McpBoundaryError => {
  if (Cause.hasInterruptsOnly(cause))
    return boundaryError("cancelled", outcome, "Schema validation was cancelled.");
  return Option.getOrElse(Cause.findErrorOption(cause), () => unavailable(outcome));
};

export interface JsonSchemaValidatorContract {
  readonly validateJsonSchema: (
    schema: Schema.Json,
    data: Schema.Json,
    outcome: JsonSchemaValidationOutcome,
  ) => Effect.Effect<void, McpBoundaryError>;
}

export const makeJsonSchemaValidator = (
  options: JsonSchemaValidatorOptions = {},
): Effect.Effect<JsonSchemaValidatorContract> =>
  Effect.gen(function* () {
    const runner = options.processRunner ?? runSchemaHelper;
    const disabled = yield* Effect.sync(() => {
      const existing = disabledByRunner.get(runner);
      if (existing) return existing;
      const state = Ref.makeUnsafe(false);
      disabledByRunner.set(runner, state);
      return state;
    });

    const validateJsonSchema = (
      schema: Schema.Json,
      data: Schema.Json,
      outcome: JsonSchemaValidationOutcome,
    ): Effect.Effect<void, McpBoundaryError> =>
      Effect.gen(function* () {
        if (yield* Ref.get(disabled))
          return yield* boundaryError(
            "unavailable",
            outcome,
            "Schema validator helper is disabled.",
          );
        const input = yield* encodeRequest(schema, data, outcome);
        yield* validateWithProcess(input, outcome, runner, disabled);
      }).pipe(
        processAdmission.withPermitsIfAvailable(1),
        Effect.flatMap((result: Option.Option<void>) =>
          Effect.fromOption(result).pipe(
            Effect.mapError(() =>
              boundaryError("unavailable", outcome, "Schema validator is busy."),
            ),
          ),
        ),
        Effect.catchCause((cause) => Effect.fail(mapFailure(outcome, cause))),
      );

    return { validateJsonSchema } satisfies JsonSchemaValidatorContract;
  });

export class JsonSchemaValidator extends Context.Service<
  JsonSchemaValidator,
  JsonSchemaValidatorContract
>()("pi-mcp/boundary/schema-validator/JsonSchemaValidator") {
  static readonly layer = (
    options: JsonSchemaValidatorOptions = {},
  ): Layer.Layer<JsonSchemaValidator> => Layer.effect(this, makeJsonSchemaValidator(options));
}
