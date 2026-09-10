import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export const JSON_SCHEMA_VALIDATOR_LIMITS = Object.freeze({
  maximumSchemaBytes: 512 * 1024,
  maximumDataBytes: 8 * 1024 * 1024,
  maximumRequestBytes: 9 * 1024 * 1024,
  maximumDocumentDepth: 64,
  maximumDocumentNodes: 100_000,
  maximumSchemaStringBytes: 256 * 1024,
  maximumStringBytes: 8 * 1024 * 1024,
  maximumResponseBytes: 4 * 1024,
  timeoutMillis: 2_000,
  cleanupTimeoutMillis: 2_000,
});

const allowedDialects = new Set([
  "https://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2020-12/schema#",
  "https://json-schema.org/draft/2019-09/schema",
  "https://json-schema.org/draft/2019-09/schema#",
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft-07/schema#",
  "http://json-schema.org/draft-06/schema#",
  "https://json-schema.org/draft-06/schema#",
]);
const legacyTupleDialects = new Set([
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft-07/schema#",
  "http://json-schema.org/draft-06/schema#",
  "https://json-schema.org/draft-06/schema#",
]);

const allowedFormats = new Set([
  "date",
  "time",
  "date-time",
  "iso-time",
  "iso-date-time",
  "duration",
  "uri",
  "uri-reference",
  "uri-template",
  "url",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "regex",
  "uuid",
  "json-pointer",
  "json-pointer-uri-fragment",
  "relative-json-pointer",
  "byte",
  "int32",
  "int64",
  "float",
  "double",
  "password",
  "binary",
]);

// The SDK provider does not enforce content keywords by default. Refuse them,
// dynamic vocabularies, and deprecated dependencies instead of accepting a
// schema whose advertised constraint would be ignored.
const allowedKeywords = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$ref",
  "$defs",
  "$comment",
  "definitions",
  "additionalItems",
  "prefixItems",
  "items",
  "contains",
  "additionalProperties",
  "properties",
  "patternProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "propertyNames",
  "if",
  "then",
  "else",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "dependentSchemas",
  "type",
  "enum",
  "const",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "maxItems",
  "minItems",
  "uniqueItems",
  "maxContains",
  "minContains",
  "maxProperties",
  "minProperties",
  "required",
  "dependentRequired",
  "format",
  "title",
  "description",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "examples",
]);

const schemaChildKeywords = new Set([
  "contains",
  "additionalProperties",
  "propertyNames",
  "if",
  "then",
  "else",
  "not",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const schemaArrayKeywords = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
]);
const stringKeywords = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$ref",
  "$comment",
  "pattern",
  "title",
  "description",
]);
const booleanKeywords = new Set(["uniqueItems", "deprecated", "readOnly", "writeOnly"]);
const numberKeywords = new Set([
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
]);
const integerKeywords = new Set([
  "maxLength",
  "minLength",
  "maxItems",
  "minItems",
  "maxContains",
  "minContains",
  "maxProperties",
  "minProperties",
]);
const jsonArrayKeywords = new Set(["enum", "examples"]);
const allowedTypes = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

const invalidDocument = Symbol("invalid-json-schema-document");

type MutableJsonObject = { [key: string]: Schema.Json };
type MutableJsonArray = Array<Schema.Json>;
type MutableJsonContainer = MutableJsonObject | MutableJsonArray;
type SnapshotContext = "json" | "schema" | "schema-array" | "schema-map";

interface SnapshotSlot {
  readonly source: unknown;
  readonly parent: MutableJsonContainer | undefined;
  readonly key: string | number | undefined;
  readonly depth: number;
  readonly context: SnapshotContext;
}

interface SnapshotLimits {
  readonly maximumBytes: number;
  readonly maximumDepth: number;
  readonly maximumNodes: number;
  readonly maximumStringBytes: number;
  readonly supportsTupleItems?: boolean;
}

const isPlainObject = <ValueInput>(
  value: ValueInput,
): value is ValueInput & Readonly<Record<string, Schema.Json>> => {
  if (!Predicate.isObject(value) || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
};

const isSchemaNode = <Input>(value: Input): boolean =>
  Predicate.isBoolean(value) || isPlainObject(value);

const schemaSupportsTupleItems = (root: Schema.Json): boolean => {
  if (!isPlainObject(root)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(root, "$schema");
  return (
    descriptor !== undefined &&
    "value" in descriptor &&
    Predicate.isString(descriptor.value) &&
    legacyTupleDialects.has(descriptor.value)
  );
};

const isLocalReference = (value: Schema.Json): value is string =>
  Predicate.isString(value) && value.startsWith("#");

const isFiniteNumber = (value: Schema.Json): value is number =>
  Predicate.isNumber(value) && Number.isFinite(value);

const isNonNegativeInteger = (value: Schema.Json): value is number =>
  isFiniteNumber(value) && Number.isInteger(value) && value >= 0;

const isStringArray = (value: Schema.Json): boolean =>
  Array.isArray(value) && value.every((entry) => Predicate.isString(entry));

const isStringMapOfArrays = (value: Schema.Json): boolean =>
  isPlainObject(value) && Object.values(value).every((entry) => isStringArray(entry));

const assertKeywordValue = (key: string, value: Schema.Json): void => {
  if (stringKeywords.has(key) && !Predicate.isString(value)) throw invalidDocument;
  if (booleanKeywords.has(key) && !Predicate.isBoolean(value)) throw invalidDocument;
  if (numberKeywords.has(key) && !isFiniteNumber(value)) throw invalidDocument;
  if (integerKeywords.has(key) && !isNonNegativeInteger(value)) throw invalidDocument;
  if (jsonArrayKeywords.has(key) && !Array.isArray(value)) throw invalidDocument;
  if (key === "multipleOf" && isFiniteNumber(value) && value <= 0) throw invalidDocument;
  if (key === "type") {
    const valid = Predicate.isString(value)
      ? allowedTypes.has(value)
      : Array.isArray(value) &&
        value.length > 0 &&
        value.every((entry) => Predicate.isString(entry) && allowedTypes.has(entry));
    if (!valid) throw invalidDocument;
  }
  if (key === "required" && !isStringArray(value)) throw invalidDocument;
  if (key === "dependentRequired" && !isStringMapOfArrays(value)) throw invalidDocument;
};

const schemaChildContext = (
  key: string,
  value: Schema.Json,
  supportsTupleItems: boolean,
): SnapshotContext => {
  if (!allowedKeywords.has(key)) throw invalidDocument;
  assertKeywordValue(key, value);
  if (key === "$ref" || key === "$id") {
    if (!isLocalReference(value)) throw invalidDocument;
  } else if (key === "$schema") {
    if (!Predicate.isString(value) || !allowedDialects.has(value)) throw invalidDocument;
  } else if (key === "format") {
    if (!Predicate.isString(value) || !allowedFormats.has(value)) throw invalidDocument;
  } else if (schemaChildKeywords.has(key)) {
    if (!isSchemaNode(value)) throw invalidDocument;
    return "schema";
  } else if (schemaArrayKeywords.has(key)) {
    if (key === "prefixItems" && supportsTupleItems) throw invalidDocument;
    if (!Array.isArray(value)) throw invalidDocument;
    return "schema-array";
  } else if (schemaMapKeywords.has(key)) {
    if (!isPlainObject(value)) throw invalidDocument;
    return "schema-map";
  } else if (key === "items" || key === "additionalItems") {
    if (Array.isArray(value)) {
      if (key !== "items" || !supportsTupleItems) throw invalidDocument;
      return "schema-array";
    }
    if (!isSchemaNode(value) || (key === "additionalItems" && !supportsTupleItems))
      throw invalidDocument;
    return "schema";
  }
  return "json";
};

const putSnapshotValue = (
  slot: SnapshotSlot,
  value: Schema.Json,
  setRoot: (value: Schema.Json) => void,
): void => {
  if (slot.parent === undefined) {
    setRoot(value);
  } else if (Array.isArray(slot.parent)) {
    if (!Predicate.isNumber(slot.key)) throw invalidDocument;
    slot.parent[slot.key] = value;
  } else {
    if (!Predicate.isString(slot.key)) throw invalidDocument;
    Object.defineProperty(slot.parent, slot.key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
};

/** Clone and bound JSON before it enters the helper request. */
const snapshotJson = <Input>(
  root: Input,
  limits: SnapshotLimits,
  rootContext: SnapshotContext,
): Schema.Json => {
  const stack: Array<SnapshotSlot> = [
    {
      source: root,
      parent: undefined,
      key: undefined,
      depth: 0,
      context: rootContext,
    },
  ];
  const seen = new Set<object>();
  let nodeCount = 0;
  let byteCount = 0;
  let result: Schema.Json | undefined;

  const setRoot = (value: Schema.Json) => {
    result = value;
  };
  const charge = (bytes: number) => {
    if (byteCount > limits.maximumBytes - bytes) throw invalidDocument;
    byteCount += bytes;
  };
  // Count JSON-escaped UTF-8 without allocating an expanded copy of a hostile string.
  const addBytes = (value: string) => {
    if (value.length > limits.maximumStringBytes) throw invalidDocument;
    let bytes = 2;
    let rawBytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 0x80) {
        rawBytes += 1;
        bytes +=
          code < 0x20
            ? [8, 9, 10, 12, 13].includes(code)
              ? 2
              : 6
            : code === 34 || code === 92
              ? 2
              : 1;
      } else if (code < 0x800) {
        rawBytes += 2;
        bytes += 2;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        const next = value.charCodeAt(index + 1);
        if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          rawBytes += 4;
          bytes += 4;
          index += 1;
        } else {
          rawBytes += 3;
          bytes += 6;
        }
      } else {
        rawBytes += 3;
        bytes += 3;
      }
      if (bytes > limits.maximumBytes || rawBytes > limits.maximumStringBytes)
        throw invalidDocument;
    }
    charge(bytes);
  };

  while (stack.length > 0) {
    const slot = stack.pop()!;
    if (slot.depth > limits.maximumDepth || nodeCount + stack.length >= limits.maximumNodes)
      throw invalidDocument;
    nodeCount += 1;
    const source = slot.source;
    if (slot.context === "schema" && !isSchemaNode(source)) throw invalidDocument;
    if (slot.context === "schema-array" && !Array.isArray(source)) throw invalidDocument;
    if (slot.context === "schema-map" && !isPlainObject(source)) throw invalidDocument;

    if (Predicate.isString(source)) {
      if (slot.context !== "json") throw invalidDocument;
      addBytes(source);
      putSnapshotValue(slot, source, setRoot);
      continue;
    }
    if (Predicate.isBoolean(source)) {
      charge(source ? 4 : 5);
      putSnapshotValue(slot, source, setRoot);
      continue;
    }
    if (Predicate.isNumber(source)) {
      if (!Number.isFinite(source) || slot.context !== "json") throw invalidDocument;
      charge(JSON.stringify(source).length);
      putSnapshotValue(slot, source, setRoot);
      continue;
    }
    if (source === null) {
      if (slot.context !== "json") throw invalidDocument;
      charge(4);
      putSnapshotValue(slot, null, setRoot);
      continue;
    }
    if (!Predicate.isObjectOrArray(source)) throw invalidDocument;
    if (seen.has(source)) throw invalidDocument;
    seen.add(source);

    if (Array.isArray(source)) {
      const keys = Object.keys(source);
      if (
        source.length > limits.maximumNodes ||
        keys.length !== source.length ||
        Object.getOwnPropertyNames(source).length !== source.length + 1 ||
        Object.getOwnPropertySymbols(source).length > 0
      )
        throw invalidDocument;
      if (nodeCount + stack.length + source.length > limits.maximumNodes) throw invalidDocument;
      charge(2 + Math.max(0, source.length - 1));
      const target: MutableJsonArray = [];
      target.length = source.length;
      putSnapshotValue(slot, target, setRoot);
      const childContext = slot.context === "schema-array" ? "schema" : "json";
      for (let index = source.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
        if (descriptor === undefined || !("value" in descriptor)) throw invalidDocument;
        stack.push({
          source: descriptor.value,
          parent: target,
          key: index,
          depth: slot.depth + 1,
          context: childContext,
        });
      }
      continue;
    }

    if (!isPlainObject(source)) throw invalidDocument;
    const keys = Object.keys(source);
    if (
      keys.length > limits.maximumNodes ||
      slot.context === "schema-array" ||
      Object.getOwnPropertyNames(source).length !== keys.length ||
      Object.getOwnPropertySymbols(source).length > 0
    )
      throw invalidDocument;
    if (nodeCount + stack.length + keys.length > limits.maximumNodes) throw invalidDocument;
    charge(2 + Math.max(0, keys.length - 1) + keys.length);
    // SAFETY: The snapshot has already established a plain JSON object and the null prototype avoids __proto__ assignment.
    const target: MutableJsonObject = Object.create(null) as MutableJsonObject;
    putSnapshotValue(slot, target, setRoot);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      addBytes(key);
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor === undefined || !("value" in descriptor)) throw invalidDocument;
      // The SDK facade does not reliably apply this plain-object key; fail closed
      // rather than silently weakening the remote schema.
      if (slot.context === "schema-map" && key === "__proto__") throw invalidDocument;
      const context =
        slot.context === "schema"
          ? schemaChildContext(key, descriptor.value, limits.supportsTupleItems ?? false)
          : slot.context === "schema-map"
            ? "schema"
            : "json";
      stack.push({
        source: descriptor.value,
        parent: target,
        key,
        depth: slot.depth + 1,
        context,
      });
    }
  }

  if (result === undefined) throw invalidDocument;
  return result;
};

/** Strict structural ingress precedes recursive Effect Schema decoding. */
export const snapshotBoundedJson = <Input>(root: Input, maximumBytes: number): Schema.Json =>
  snapshotJson(
    root,
    {
      maximumBytes,
      maximumDepth: JSON_SCHEMA_VALIDATOR_LIMITS.maximumDocumentDepth,
      maximumNodes: JSON_SCHEMA_VALIDATOR_LIMITS.maximumDocumentNodes,
      maximumStringBytes: Math.min(maximumBytes, JSON_SCHEMA_VALIDATOR_LIMITS.maximumStringBytes),
    },
    "json",
  );

export const encodeSchemaValidationRequest = (
  schema: Schema.Json,
  data: Schema.Json,
): Uint8Array => {
  const safeSchema = snapshotJson(
    schema,
    {
      maximumBytes: JSON_SCHEMA_VALIDATOR_LIMITS.maximumSchemaBytes,
      maximumDepth: JSON_SCHEMA_VALIDATOR_LIMITS.maximumDocumentDepth,
      maximumNodes: JSON_SCHEMA_VALIDATOR_LIMITS.maximumDocumentNodes,
      maximumStringBytes: JSON_SCHEMA_VALIDATOR_LIMITS.maximumSchemaStringBytes,
      supportsTupleItems: schemaSupportsTupleItems(schema),
    },
    "schema",
  );
  const safeData = snapshotJson(
    data,
    {
      maximumBytes: JSON_SCHEMA_VALIDATOR_LIMITS.maximumDataBytes,
      maximumDepth: JSON_SCHEMA_VALIDATOR_LIMITS.maximumDocumentDepth,
      maximumNodes: JSON_SCHEMA_VALIDATOR_LIMITS.maximumDocumentNodes,
      maximumStringBytes: JSON_SCHEMA_VALIDATOR_LIMITS.maximumStringBytes,
    },
    "json",
  );
  const encoded = new TextEncoder().encode(JSON.stringify({ data: safeData, schema: safeSchema }));
  if (encoded.byteLength > JSON_SCHEMA_VALIDATOR_LIMITS.maximumRequestBytes) throw invalidDocument;
  return encoded;
};
