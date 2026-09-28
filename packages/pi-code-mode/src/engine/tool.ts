/** Schema-described tool definitions exposed to programs under `tools.*`. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** Safe operational refusal from a tool, reported to the program as `ToolFailure`. */
export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
  /** The tool path that refused, attached by the dispatcher that invoked it. */
  tool: Schema.optionalKey(Schema.String),
}) {}

/** Creates a tool refusal whose message is safe to include in an execution diagnostic. */
export const toolError = (message: string, cause?: unknown): ToolError =>
  cause === undefined ? new ToolError({ message }) : new ToolError({ message, cause });

/**
 * Normalizes an arbitrary host effect onto the closed `ToolError` channel: explicit refusals
 * pass through, interruption keeps propagating, and every other failure or defect collapses
 * into a generic `ToolError`.
 */
export const runHost = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ToolError, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      const error = Cause.squash(cause);
      return Effect.fail(
        error instanceof ToolError ? error : toolError("Tool execution failed", error),
      );
    }),
  );

/**
 * Runs a host observation hook. Observers see execution; they never change it. A hook that
 * fails, dies or throws is ignored; interruption still propagates.
 */
export const observeHost = <R>(
  observe: () => Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R> =>
  Effect.suspend(observe).pipe(
    Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.void)),
  );

/** One tool: its description, schemas, and runner on the closed `ToolError` channel. */
export interface Definition<R = never> {
  readonly _tag: "CodeModeTool";
  readonly description: string;
  readonly input: Schema.Decoder<unknown> & Schema.Top;
  readonly output: (Schema.Decoder<unknown> & Schema.Top) | undefined;
  /** Runs with input already decoded by `input`. */
  readonly run: <Input>(input: Input) => Effect.Effect<unknown, ToolError, R>;
}

export const isDefinition = <R = never, Value = unknown>(
  value: Value,
): value is Value & Definition<R> =>
  Predicate.isObject(value) && "_tag" in value && value._tag === "CodeModeTool";

/**
 * Defines one tool. Input is decoded before `run`; `run` returns the encoded form of `output`,
 * which the dispatcher decodes before the program sees it. Without `output` the signature
 * advertises `unknown` and the host value passes through as JSON.
 */
export const makeTool = <
  I extends Schema.Decoder<unknown> & Schema.Top,
  const O extends (Schema.Decoder<unknown> & Schema.Top) | undefined = undefined,
  E = never,
  R = never,
>(options: {
  readonly description: string;
  readonly input: I;
  readonly output?: O;
  readonly run: (
    input: I["Type"],
  ) => Effect.Effect<O extends Schema.Decoder<unknown> ? O["Encoded"] : unknown, E, R>;
}): Definition<R> => ({
  _tag: "CodeModeTool",
  description: options.description,
  input: options.input,
  output: options.output,
  // SAFETY: the dispatcher decodes `input` with this definition's schema before calling run.
  run: (input) => runHost(options.run(input as I["Type"])),
});
