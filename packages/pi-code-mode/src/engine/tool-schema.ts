/**
 * Tool schemas as model-visible TypeScript signatures, and the decoding applied to tool input
 * and output at the program boundary.
 */
import * as Predicate from "effect/Predicate";
import * as JsonPointer from "effect/JsonPointer";
import * as Schema from "effect/Schema";
import type { Definition } from "./tool.ts";

/** The JSON Schema subset Effect emits for tool schemas, read only to render signatures. */
type JsonSchema = {
  readonly type?: string | ReadonlyArray<string> | undefined;
  readonly enum?: ReadonlyArray<unknown> | undefined;
  readonly const?: unknown;
  readonly anyOf?: ReadonlyArray<JsonSchema> | undefined;
  readonly oneOf?: ReadonlyArray<JsonSchema> | undefined;
  readonly allOf?: ReadonlyArray<JsonSchema> | undefined;
  readonly properties?: Readonly<Record<string, JsonSchema>> | undefined;
  readonly required?: ReadonlyArray<string> | undefined;
  readonly items?: JsonSchema | boolean | undefined;
  readonly prefixItems?: ReadonlyArray<JsonSchema> | undefined;
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

const isObjectSchema = <Value>(value: Value): value is Value & object =>
  Predicate.isObjectOrArray(value);

const jsonSchemaDocument = (schema: Schema.Top) =>
  // SAFETY: Effect emits a JSON Schema document; rendering reads it defensively and never throws.
  Schema.toJsonSchemaDocument(schema) as {
    readonly schema: JsonSchema;
    readonly definitions?: Readonly<Record<string, JsonSchema>>;
  };

const renderLiteral = <Value>(value: Value): string => JSON.stringify(value) ?? "unknown";

/**
 * Bare TypeScript identifier - usable unquoted as an object key (and, in tool paths,
 * with dot access as a tool-path segment). Anything else must be quoted/bracketed.
 */
export const identifierSegment = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Renders a property name as a valid TS object key: bare when an identifier, quoted otherwise. */
const renderKey = (name: string): string =>
  identifierSegment.test(name) ? name : JSON.stringify(name);

const effectNumberSentinelValues = new Set(["NaN", "Infinity", "-Infinity"]);

const effectNumberSentinel = (schema: JsonSchema) =>
  schema.type === "string" &&
  Array.isArray(schema.enum) &&
  schema.enum.length > 0 &&
  schema.enum.every((value) => Predicate.isString(value) && effectNumberSentinelValues.has(value));

const isEffectNumberAlternatives = (alternatives: ReadonlyArray<JsonSchema>): boolean => {
  const numberBranches = alternatives.filter((item) => item.type === "number");
  const sentinelBranches = alternatives.filter(effectNumberSentinel);
  const sentinels = sentinelBranches.flatMap((item) => item.enum ?? []);
  return (
    numberBranches.length === 1 &&
    alternatives.length === numberBranches.length + sentinelBranches.length &&
    sentinels.length === effectNumberSentinelValues.size &&
    new Set(sentinels).size === effectNumberSentinelValues.size
  );
};

const intersection = (members: ReadonlyArray<string>): string => {
  const concrete = members.filter((member) => member !== "unknown");
  if (concrete.length === 0) return "unknown";
  if (concrete.length === 1) return concrete[0] ?? "unknown";
  return concrete.map((member) => (member.includes(" | ") ? `(${member})` : member)).join(" & ");
};

/**
 * Recursion ceiling for schema rendering. Object, array, and union recursion all increment
 * depth, so this bounds every recursion path - pathological or structurally cyclic schemas
 * degrade to `unknown` instead of overflowing the stack (rendering must never throw).
 */
const MAX_RENDER_DEPTH = 8;

type RenderContext = {
  readonly definitions: Readonly<Record<string, JsonSchema>>;
  /** Indented, JSDoc-annotated multiline rendering (search results); compact single line otherwise. */
  readonly pretty: boolean;
};

const hasUnresolvedRef = (
  schema: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>>,
  seen: ReadonlySet<string> = new Set(),
  visited: ReadonlySet<JsonSchema> = new Set(),
): boolean => {
  if (visited.has(schema)) return false;
  const nextVisited = new Set([...visited, schema]);
  if (schema.$ref !== undefined) {
    const segment = schema.$ref.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/)?.[1];
    const name = segment === undefined ? undefined : JsonPointer.unescapeToken(segment);
    if (name === undefined || definitions[name] === undefined || seen.has(name)) return true;
    if (hasUnresolvedRef(definitions[name], definitions, new Set([...seen, name]), nextVisited))
      return true;
  }
  return [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
    ...Object.values(schema.properties ?? {}),
    ...(schema.prefixItems ?? []),
    ...(isObjectSchema(schema.items) ? [schema.items] : []),
    ...(isObjectSchema(schema.additionalProperties) ? [schema.additionalProperties] : []),
  ].some((item) => hasUnresolvedRef(item, definitions, seen, nextVisited));
};

/**
 * Schema constraints a TypeScript type cannot express natively but a model benefits from,
 * surfaced as JSDoc tags.
 */
const docTags = (schema: JsonSchema): Array<string> => {
  const tags: Array<string> = [];
  if (schema.deprecated === true) tags.push("@deprecated");
  if (schema.default !== undefined) {
    try {
      const rendered = JSON.stringify(schema.default);
      if (rendered !== undefined) tags.push(`@default ${rendered}`);
    } catch {
      // unserializable default: skip rather than emit a broken tag
    }
  }
  if (Predicate.isString(schema.format)) tags.push(`@format ${schema.format}`);
  if (schema.type === "integer") tags.push("@integer");
  for (const key of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
  ] as const) {
    const value = schema[key];
    if (Predicate.isNumber(value) && Number.isFinite(value)) tags.push(`@${key} ${value}`);
    else if (value === true) tags.push(`@${key} true`);
  }
  if (Predicate.isString(schema.pattern)) tags.push(`@pattern ${JSON.stringify(schema.pattern)}`);
  if (schema.uniqueItems === true) tags.push("@uniqueItems true");
  return tags;
};

/**
 * Format a schema `description` plus `tags` as a JSDoc comment at the given indent,
 * preserving multi-line text (a single line stays `/** ... *\/`; multiple lines become a
 * `*`-prefixed block). `*\/` is neutralized so nothing can close the comment early, and
 * blank leading/trailing lines are trimmed. Returns "" (else a trailing newline) so
 * callers can prepend it directly to the field line.
 */
const jsdoc = (
  description: string | undefined,
  tags: ReadonlyArray<string>,
  pad: string,
): string => {
  const lines = [...(description === undefined ? [] : description.split("\n")), ...tags].map(
    (line) => line.replaceAll("*/", "* /").replace(/\s+$/, ""),
  );
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length === 0) return "";
  if (lines.length === 1) return `${pad}/** ${lines[0]} */\n`;
  const body = lines.map((line) => `${pad} *${line === "" ? "" : ` ${line}`}`).join("\n");
  return `${pad}/**\n${body}\n${pad} */\n`;
};

const renderSchema = (
  schema: JsonSchema,
  ctx: RenderContext,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): string => {
  const rendered = renderSchemaType(schema, ctx, depth, seen);
  if (!ctx.pretty || depth > MAX_RENDER_DEPTH) return rendered;
  // Constraint-only schemas still carry useful documentation. Keep their `unknown`
  // type in intersections rather than inferring a type from a validation keyword.
  if (
    rendered === "unknown" &&
    hasUnresolvedRef(schema, { ...ctx.definitions, ...schema.definitions, ...schema.$defs }, seen)
  )
    return rendered;
  const tags = docTags(schema);
  return tags.length === 0
    ? rendered
    : `${jsdoc(undefined, [tags.join(" ")], "").trim()} ${rendered}`;
};

const renderSchemaType = (
  schema: JsonSchema,
  ctx: RenderContext,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): string => {
  if (depth > MAX_RENDER_DEPTH) return "unknown";
  const nested =
    schema.definitions === undefined && schema.$defs === undefined
      ? ctx
      : {
          ...ctx,
          definitions: {
            ...ctx.definitions,
            ...schema.definitions,
            ...schema.$defs,
          },
        };
  if (schema.$ref) {
    const segment = schema.$ref.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/)?.[1];
    const name = segment === undefined ? undefined : JsonPointer.unescapeToken(segment);
    if (!name || !nested.definitions[name] || seen.has(name)) return "unknown";
    return intersection([
      renderSchema(nested.definitions[name], nested, depth, new Set([...seen, name])),
      renderSchema({ ...schema, $ref: undefined }, nested, depth + 1, seen),
    ]);
  }
  if (schema.const !== undefined) return renderLiteral(schema.const);
  if (schema.enum) return schema.enum.map(renderLiteral).join(" | ");
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives?.length === 0) return "never";
  if (alternatives) {
    // Effect's number schema emits a number branch plus string-enum representations for
    // NaN/Infinity/-Infinity (one enum per sentinel in older betas, one combined enum in the
    // RC). Collapse only that complete artifact; real JSON Schema unions such as
    // `string | number` or `number | null` must keep every branch.
    if (isEffectNumberAlternatives(alternatives)) return "number";
    // An empty Schema.Struct({}) emits `anyOf: [{ type: "object" }, { type: "array" }]`
    // (no properties/items); render the bare shape as {} instead of `{} | Array<unknown>`.
    if (
      alternatives.length === 2 &&
      alternatives[0]?.type === "object" &&
      alternatives[0].properties === undefined &&
      alternatives[1]?.type === "array" &&
      alternatives[1].items === undefined
    ) {
      return "{}";
    }
    const members = alternatives.map((item) => renderSchema(item, nested, depth + 1, seen));
    if (members.some((member) => member === "unknown")) return "unknown";
    return intersection([
      members.join(" | "),
      renderSchema({ ...schema, anyOf: undefined, oneOf: undefined }, nested, depth + 1, seen),
    ]);
  }
  if (schema.allOf) {
    const members = schema.allOf.map((item) => renderSchema(item, nested, depth + 1, seen));
    if (schema.allOf.some((item) => hasUnresolvedRef(item, nested.definitions))) return "unknown";
    return intersection([
      renderSchema({ ...schema, allOf: undefined }, nested, depth + 1, seen),
      ...members,
    ]);
  }
  if (Array.isArray(schema.type)) {
    return schema.type
      .map((item) => renderSchema({ ...schema, type: item }, nested, depth + 1, seen))
      .join(" | ");
  }
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  if (schema.type === "array") {
    const items = schema.items;
    if (schema.prefixItems !== undefined) {
      // A tuple: fixed leading positions, then either nothing more or a typed rest.
      const leading = schema.prefixItems.map((item) => renderSchema(item, nested, depth + 1, seen));
      const closed = items === false || schema.maxItems === schema.prefixItems.length;
      const rest = closed
        ? []
        : [`...${renderSchema(isObjectSchema(items) ? items : {}, nested, depth + 1, seen)}[]`];
      return `[${[...leading, ...rest].join(", ")}]`;
    }
    return `Array<${renderSchema(isObjectSchema(items) ? items : {}, nested, depth + 1, seen)}>`;
  }
  if (schema.type === "object" || schema.properties) {
    const required = new Set(schema.required ?? []);
    const properties = Object.entries(schema.properties ?? {});
    const additional = schema.additionalProperties;
    const indexType =
      additional && isObjectSchema(additional)
        ? renderSchema(additional, nested, depth + 1, seen)
        : undefined;
    const field = ([name, value]: readonly [string, JsonSchema]) =>
      `${renderKey(name)}${required.has(name) ? "" : "?"}: ${renderSchema(value, nested, depth + 1, seen)}`;

    if (!ctx.pretty) {
      const fields = properties.map(field);
      if (indexType !== undefined) fields.push(`[key: string]: ${indexType}`);
      return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
    }

    // Pretty: an indented block, each described field preceded by its JSDoc comment.
    if (properties.length === 0 && indexType === undefined) return "{}";
    const pad = "  ".repeat(depth + 1);
    const lines = properties.map(
      (entry) => `${jsdoc(entry[1].description, [], pad)}${pad}${field(entry)},`,
    );
    if (indexType !== undefined) lines.push(`${pad}[key: string]: ${indexType},`);
    return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
  }
  return "unknown";
};

export const toTypeScript = (schema: Schema.Top, decoded = false, pretty = false): string => {
  try {
    const document = jsonSchemaDocument(decoded ? Schema.toType(schema) : schema);
    return renderSchema(document.schema, { definitions: document.definitions ?? {}, pretty });
  } catch {
    return "unknown";
  }
};

/** One input property of a tool, extracted best-effort from its input schema. */
export type InputProperty = {
  readonly name: string;
  readonly description: string | undefined;
  readonly required: boolean;
};

/**
 * The property names, descriptions, and required flags of a tool's input schema - the raw
 * material for search text. Best-effort, through the same JSON Schema document signature
 * rendering uses, resolving a trivial top-level `$ref`. Anything unresolvable yields `[]`
 * (search falls back to path + description).
 */
export const inputProperties = <R>(definition: Definition<R>): Array<InputProperty> => {
  try {
    const document = jsonSchemaDocument(definition.input);
    const definitions = document.definitions ?? {};
    let schema = document.schema;
    if (schema.$ref !== undefined) {
      const segment = schema.$ref.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/)?.[1];
      const name = segment === undefined ? undefined : JsonPointer.unescapeToken(segment);
      const resolved = name === undefined ? undefined : definitions[name];
      if (resolved === undefined) return [];
      schema = resolved;
    }
    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties ?? {}).map(([name, value]) => ({
      name,
      description: Predicate.isString(value.description) ? value.description : undefined,
      required: required.has(name),
    }));
  } catch {
    return [];
  }
};

/**
 * The model-visible TypeScript type of a tool's input. `pretty` renders an indented
 * multiline block with schema descriptions and constraints as JSDoc comments on the
 * fields; the default stays the compact single-line form.
 */
export const inputTypeScript = <R>(definition: Definition<R>, pretty = false): string =>
  toTypeScript(definition.input, false, pretty);

/**
 * The model-visible TypeScript type of a tool's result; tools without an output schema
 * return `unknown`. `pretty` renders the JSDoc-annotated multiline form, as for inputs.
 */
export const outputTypeScript = <R>(definition: Definition<R>, pretty = false): string =>
  definition.output === undefined ? "unknown" : toTypeScript(definition.output, true, pretty);

const jsonCodecs = new WeakMap<Schema.Decoder<unknown>, Schema.Decoder<unknown>>();

const jsonCodec = (schema: Schema.Decoder<unknown>): Schema.Decoder<unknown> => {
  let codec = jsonCodecs.get(schema);
  if (codec === undefined) {
    codec = Schema.toCodecJson(schema);
    jsonCodecs.set(schema, codec);
  }
  return codec;
};

/**
 * Decodes tool input before `run` is invoked. Guest input is JSON data and the model-visible
 * signature is rendered from the schema's JSON form, so input the schema itself rejects gets a
 * second chance through its JSON codec (a Date field takes an ISO string, an optional field
 * takes null). A value both reject reports the schema's own, clearer error.
 */
export const decodeInput = <R, Value>(definition: Definition<R>, value: Value) => {
  const input = definition.input;
  try {
    return Schema.decodeUnknownSync(input)(value);
  } catch (plainError) {
    try {
      return Schema.decodeUnknownSync(jsonCodec(input))(value);
    } catch {
      throw plainError;
    }
  }
};

/**
 * Decodes a tool result before it is exposed to the program, throwing on failure. Tools
 * without an output schema pass the host value through unchanged.
 */
export const decodeOutput = <R, Value>(definition: Definition<R>, value: Value) =>
  definition.output === undefined ? value : Schema.decodeUnknownSync(definition.output)(value);
