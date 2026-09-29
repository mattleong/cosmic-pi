import { Buffer } from "node:buffer";
import type * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { boundaryError } from "../client/errors.ts";

export const MCP_PARAMETER_HEADER_LIMITS = Object.freeze({
  count: 64,
  bytes: 16 * 1024,
  schemaNodes: 100_000,
  schemaDepth: 64,
});
const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const schemaMaps = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems", "items"]);
const schemaValues = new Set([
  "items",
  "additionalItems",
  "contains",
  "unevaluatedItems",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);
const object = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);
interface ParameterHeader {
  readonly path: ReadonlyArray<string>;
  readonly name: string;
  readonly type: "string" | "integer" | "number" | "boolean";
}
export type ParameterHeaderScan =
  | { readonly valid: true; readonly headers: ReadonlyArray<ParameterHeader> }
  | { readonly valid: false };

/** Inspect bounded JSON data only. No references are resolved or schemas compiled. */
export const scanParameterHeaders = (schema: Schema.Json): ParameterHeaderScan => {
  const pending: Array<{
    value: Schema.Json;
    path: ReadonlyArray<string> | undefined;
    depth: number;
    schema: boolean;
  }> = [{ value: schema, path: [], depth: 0, schema: true }];
  const headers: Array<ParameterHeader> = [];
  const names = new Set<string>();
  let nodes = 0;
  let bytes = 0;
  const invalid = { valid: false } as const;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (
      ++nodes > MCP_PARAMETER_HEADER_LIMITS.schemaNodes ||
      current.depth > MCP_PARAMETER_HEADER_LIMITS.schemaDepth
    )
      return invalid;
    if (!Array.isArray(current.value) && !Predicate.isObject(current.value)) continue;
    const value = current.value;
    if (current.schema && object(value) && Object.hasOwn(value, "x-mcp-header")) {
      const name = value["x-mcp-header"];
      const type = value.type;
      if (
        current.path === undefined ||
        current.path.length === 0 ||
        !Predicate.isString(name) ||
        !token.test(name) ||
        (type !== "string" && type !== "integer" && type !== "number" && type !== "boolean") ||
        names.has(name.toLowerCase())
      )
        return invalid;
      bytes += "Mcp-Param-".length + name.length + 4;
      if (
        headers.length >= MCP_PARAMETER_HEADER_LIMITS.count ||
        bytes > MCP_PARAMETER_HEADER_LIMITS.bytes
      )
        return invalid;
      names.add(name.toLowerCase());
      headers.push({ path: current.path, name: `Mcp-Param-${name}`, type });
    }
    const entries = Object.entries(value);
    if (nodes + pending.length + entries.length > MCP_PARAMETER_HEADER_LIMITS.schemaNodes)
      return invalid;
    for (const [key, child] of entries) {
      if (
        current.schema &&
        ((schemaMaps.has(key) && object(child)) || (schemaArrays.has(key) && Array.isArray(child)))
      ) {
        // Count containers even when empty, without interpreting their keys as annotations.
        if (
          ++nodes > MCP_PARAMETER_HEADER_LIMITS.schemaNodes ||
          current.depth + 1 > MCP_PARAMETER_HEADER_LIMITS.schemaDepth
        )
          return invalid;
        // Map keys and array indices are not annotations. Only properties provide input paths.
        const nestedSchemas = Object.entries(child);
        if (nodes + pending.length + nestedSchemas.length > MCP_PARAMETER_HEADER_LIMITS.schemaNodes)
          return invalid;
        for (const [property, nested] of nestedSchemas)
          pending.push({
            value: nested,
            depth: current.depth + 2,
            path:
              key === "properties" && current.path !== undefined
                ? [...current.path, property]
                : undefined,
            schema: true,
          });
      } else {
        // Literal data still consumes the structural budget, but cannot declare headers.
        pending.push({
          value: child,
          depth: current.depth + 1,
          path: undefined,
          schema: current.schema && schemaValues.has(key),
        });
      }
    }
  }
  return { valid: true, headers };
};

/**
 * MCP's sentinel is case-sensitive; literals matching it must themselves be encoded. An
 * empty value is encoded too, as in the SDK, so it survives field parsing.
 */
export const encodeMcpHeaderValue = (value: string): string => {
  let plain =
    value.length > 0 &&
    !/^[\t ]|[\t ]$/.test(value) &&
    !(value.startsWith("=?base64?") && value.endsWith("?="));
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdfff) {
      const next = value.charCodeAt(index + 1);
      if (code > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff))
        throw boundaryError("invalid-input", "not-sent", "MCP header value is invalid.");
      index++;
    }
    plain = plain && (code === 9 || (code >= 32 && code <= 126));
  }
  return plain ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
};

/** Called only after successful validation against this exact captured schema. */
export const parameterHeaders = (
  schema: Schema.Json,
  arguments_: Schema.JsonObject,
): Readonly<Record<string, string>> => {
  const scan = scanParameterHeaders(schema);
  const invalid = () =>
    boundaryError(
      "invalid-input",
      "not-sent",
      "MCP parameter headers are invalid or exceed local limits.",
    );
  if (!scan.valid) throw invalid();
  const headers: Record<string, string> = {};
  let bytes = 0;
  for (const header of scan.headers) {
    let value: Schema.Json | undefined = arguments_;
    for (const key of header.path) {
      if (value === undefined || value === null) break;
      if (!object(value)) throw invalid();
      value = Object.hasOwn(value, key) ? value[key] : undefined;
    }
    if (value === undefined || value === null) continue;
    if (
      (header.type === "string" && !Predicate.isString(value)) ||
      (header.type === "boolean" && !Predicate.isBoolean(value)) ||
      (header.type === "integer" && (!Predicate.isNumber(value) || !Number.isInteger(value))) ||
      (header.type === "number" && (!Predicate.isNumber(value) || !Number.isFinite(value)))
    )
      throw invalid();
    // A valid integer beyond exact JavaScript range has no faithful header text; like the
    // SDK, omit that header rather than refuse the call.
    if (Predicate.isNumber(value) && Number.isInteger(value) && !Number.isSafeInteger(value))
      continue;
    const text = String(value);
    // Reject oversized values before allocating UTF-8/base64 copies.
    if (text.length > MCP_PARAMETER_HEADER_LIMITS.bytes) throw invalid();
    const encoded = encodeMcpHeaderValue(text);
    bytes += header.name.length + encoded.length + 4;
    if (bytes > MCP_PARAMETER_HEADER_LIMITS.bytes) throw invalid();
    headers[header.name] = encoded;
  }
  return Object.freeze(headers);
};
