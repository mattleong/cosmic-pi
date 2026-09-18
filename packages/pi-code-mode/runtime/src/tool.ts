import { hasObjectRuntimeType } from "./runtime-values.js";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { runHost, type ToolError } from "./tool-error.js";

/**
 * JSON Schema subset accepted for render-only tool schemas.
 *
 * A JSON-Schema-described side of a tool is used to generate the model-visible TypeScript
 * signature only - CodeMode performs no validation against it. This is the natural shape for
 * adapter-provided tools (e.g. MCP definitions) whose schemas arrive as JSON Schema documents.
 */
export type JsonSchema = {
  readonly type?: string | ReadonlyArray<string> | undefined;
  readonly enum?: ReadonlyArray<unknown> | undefined;
  readonly const?: unknown;
  readonly anyOf?: ReadonlyArray<JsonSchema> | undefined;
  readonly oneOf?: ReadonlyArray<JsonSchema> | undefined;
  readonly allOf?: ReadonlyArray<JsonSchema> | undefined;
  readonly properties?: Readonly<Record<string, JsonSchema>> | undefined;
  readonly required?: ReadonlyArray<string> | undefined;
  readonly items?: JsonSchema | undefined;
  readonly additionalProperties?: boolean | JsonSchema | undefined;
  readonly description?: string | undefined;
  readonly default?: unknown;
  readonly format?: string | undefined;
  readonly deprecated?: boolean | undefined;
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
  readonly exclusiveMinimum?: number | boolean | undefined;
  readonly exclusiveMaximum?: number | boolean | undefined;
  readonly multipleOf?: number | undefined;
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
  readonly pattern?: string | undefined;
  readonly minProperties?: number | undefined;
  readonly maxProperties?: number | undefined;
  readonly uniqueItems?: boolean | undefined;
  readonly minItems?: number | undefined;
  readonly maxItems?: number | undefined;
  readonly $ref?: string | undefined;
  readonly $defs?: Readonly<Record<string, JsonSchema>> | undefined;
  readonly definitions?: Readonly<Record<string, JsonSchema>> | undefined;
};

/** Either a validating Effect Schema or a render-only JSON Schema document. */
export type SchemaType = Schema.Decoder<unknown> | JsonSchema;

/** Schema-backed tool definition consumed by a CodeMode tool tree. */
export type Definition<R = never> = {
  readonly _tag: "CodeModeTool";
  readonly description: string;
  readonly input: SchemaType;
  readonly output: SchemaType | undefined;
  /** Stored runner, already normalized onto the closed `ToolError` failure channel. */
  readonly run: <Input>(input: Input) => Effect.Effect<unknown, ToolError, R>;
};

/** The value `run` receives: the decoded type for Effect Schemas, `unknown` for JSON Schemas. */
type InputType<S> = S extends Schema.Decoder<unknown> ? S["Type"] : unknown;

/** The value `run` returns: the encoded type for Effect Schemas, `unknown` otherwise. */
type ResultType<S> = S extends Schema.Decoder<unknown> ? S["Encoded"] : unknown;

/** Options for defining one CodeMode tool. */
export type Options<
  I extends SchemaType,
  O extends SchemaType | undefined,
  E = never,
  R = never,
> = {
  readonly description: string;
  readonly input: I;
  readonly output?: O;
  readonly run: (input: InputType<I>) => Effect.Effect<ResultType<O>, E, R>;
};

export const isDefinition = <R = never, Value = unknown>(
  value: Value,
): value is Value & Definition<R> =>
  hasObjectRuntimeType(value) && value !== null && "_tag" in value && value._tag === "CodeModeTool";

/**
 * Defines one schema-described tool available to a CodeMode program through `tools.*`.
 *
 * `input` and `output` each accept a validating Effect Schema or a render-only JSON Schema
 * document. Effect Schema input is decoded before `run` is invoked, and `run` returns the
 * encoded representation of an Effect Schema `output`, which CodeMode decodes before returning
 * it to the program. JSON Schemas only shape the model-visible signature; values pass through
 * unvalidated. `output` is optional - without it the signature advertises `unknown` and the
 * host result is exposed as-is. The host tool remains responsible for authorization and
 * durable side-effect handling.
 *
 * @example
 * ```ts
 * const lookup = Tool.make({
 *   description: "Look up an order",
 *   input: Schema.Struct({ id: Schema.String }),
 *   output: Schema.Struct({ status: Schema.String }),
 *   run: ({ id }) => Effect.succeed({ status: "open" }),
 * })
 *
 * const fromJsonSchema = Tool.make({
 *   description: "Call an adapter-described tool",
 *   input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
 *   run: (input) => callHost(input),
 * })
 * ```
 */
// SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
export const make = <
  I extends SchemaType,
  const O extends SchemaType | undefined = undefined,
  E = never,
  R = never,
>(
  options: Options<I, O, E, R>,
): Definition<R> => ({
  _tag: "CodeModeTool",
  description: options.description,
  input: options.input,
  output: options.output,
  run: (input) => {
    // SAFETY: ToolRuntime decodes Effect Schema inputs before invoking this stored definition.
    return runHost(options.run(input as InputType<I>));
  },
});
