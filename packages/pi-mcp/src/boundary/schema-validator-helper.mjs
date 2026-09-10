import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

// This file is a fixed one-shot boundary. It accepts exactly { schema, data },
// never reads an executable/path/module field, and emits only { valid }.
const maximumInputBytes = 9 * 1024 * 1024;
const maximumSchemaBytes = 512 * 1024;
const maximumDataBytes = 8 * 1024 * 1024;
const maximumSchemaStringBytes = 256 * 1024;
const maximumDepth = 64;
const maximumNodes = 100_000;

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

// Unsupported content, dynamic, and deprecated dependency vocabularies are
// rejected instead of being silently ignored by the SDK's default provider.
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
  "format",
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

const objectTag = Object.prototype.toString;
const isString = (value) => objectTag.call(value) === "[object String]";
const isBoolean = (value) => value === true || value === false;
const isPlainObject = (value) =>
  objectTag.call(value) === "[object Object]" && !Array.isArray(value);
const isLocalReference = (value) => isString(value) && value.startsWith("#");
const isSchemaNode = (value) => isBoolean(value) || isPlainObject(value);
const schemaSupportsTupleItems = (root) =>
  isPlainObject(root) && legacyTupleDialects.has(root.$schema);
const isStringArray = (value) => Array.isArray(value) && value.every((entry) => isString(entry));
const isStringMapOfArrays = (value) =>
  isPlainObject(value) && Object.values(value).every((entry) => isStringArray(entry));
const assertKeywordValue = (key, value) => {
  if (stringKeywords.has(key) && !isString(value)) throw new Error();
  if (booleanKeywords.has(key) && !isBoolean(value)) throw new Error();
  if (numberKeywords.has(key) && !Number.isFinite(value)) throw new Error();
  if (
    integerKeywords.has(key) &&
    (!Number.isFinite(value) || !Number.isInteger(value) || value < 0)
  ) {
    throw new Error();
  }
  if (jsonArrayKeywords.has(key) && !Array.isArray(value)) throw new Error();
  if (key === "multipleOf" && Number.isFinite(value) && value <= 0) throw new Error();
  if (key === "type") {
    const valid = isString(value)
      ? allowedTypes.has(value)
      : Array.isArray(value) &&
        value.length > 0 &&
        value.every((entry) => isString(entry) && allowedTypes.has(entry));
    if (!valid) throw new Error();
  }
  if (key === "required" && !isStringArray(value)) throw new Error();
  if (key === "dependentRequired" && !isStringMapOfArrays(value)) throw new Error();
};

const requireSchemaNode = (stack, value, depth) => {
  if (!isSchemaNode(value)) throw new Error();
  stack.push({ value, depth });
};
const requireSchemaArray = (stack, value, depth) => {
  if (!Array.isArray(value)) throw new Error();
  for (const child of value) requireSchemaNode(stack, child, depth);
};
const requireSchemaMap = (stack, value, depth) => {
  if (!isPlainObject(value)) throw new Error();
  for (const [key, child] of Object.entries(value)) {
    // The SDK facade does not reliably apply this plain-object key; fail closed
    // rather than silently weakening the remote schema.
    if (key === "__proto__") throw new Error();
    requireSchemaNode(stack, child, depth);
  }
};

// The parent repeats this check before dispatch. Keeping it here means a
// malformed direct invocation still cannot make the SDK resolve a remote ref
// or install a custom keyword/format.
const assertSafeSchema = (root) => {
  if (isBoolean(root)) return;
  if (!isPlainObject(root)) throw new Error();
  const supportsTupleItems = schemaSupportsTupleItems(root);
  const stack = [{ value: root, depth: 0 }];
  const seen = new Set();
  let nodes = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    const node = entry.value;
    if (entry.depth > maximumDepth) throw new Error();
    if (isBoolean(node)) continue;
    if (!isPlainObject(node) || seen.has(node)) throw new Error();
    seen.add(node);
    nodes += 1;
    if (nodes > maximumNodes) throw new Error();

    for (const key of Object.keys(node)) {
      if (!allowedKeywords.has(key)) throw new Error();
      const value = node[key];
      assertKeywordValue(key, value);
      const childDepth = entry.depth + 1;
      if (key === "$ref" || key === "$id") {
        if (!isLocalReference(value)) throw new Error();
      } else if (key === "$schema") {
        if (!isString(value) || !allowedDialects.has(value)) throw new Error();
      } else if (key === "format") {
        if (!isString(value) || !allowedFormats.has(value)) throw new Error();
      } else if (schemaChildKeywords.has(key)) {
        requireSchemaNode(stack, value, childDepth);
      } else if (schemaArrayKeywords.has(key)) {
        if (key === "prefixItems" && supportsTupleItems) throw new Error();
        requireSchemaArray(stack, value, childDepth);
      } else if (schemaMapKeywords.has(key)) {
        requireSchemaMap(stack, value, childDepth);
      } else if (key === "items" || key === "additionalItems") {
        if (Array.isArray(value)) {
          if (key !== "items" || !supportsTupleItems) throw new Error();
          requireSchemaArray(stack, value, childDepth);
        } else {
          if (key === "additionalItems" && !supportsTupleItems) throw new Error();
          requireSchemaNode(stack, value, childDepth);
        }
      }
    }
  }
};

const assertBoundedDocument = (root, maximumBytes, maximumStringBytes) => {
  if (Buffer.byteLength(JSON.stringify(root), "utf8") > maximumBytes) throw new Error();
  const stack = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    nodes += 1;
    if (nodes + stack.length > maximumNodes || depth > maximumDepth) throw new Error();
    if (isString(value)) {
      if (Buffer.byteLength(value, "utf8") > maximumStringBytes) throw new Error();
    } else if (Array.isArray(value) || isPlainObject(value)) {
      const keys = Object.keys(value);
      if (nodes + stack.length + keys.length > maximumNodes) throw new Error();
      for (const key of keys) {
        if (Buffer.byteLength(key, "utf8") > maximumStringBytes) throw new Error();
        stack.push({ value: value[key], depth: depth + 1 });
      }
    }
  }
};

const readInput = async () => {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > maximumInputBytes) throw new Error();
    chunks.push(chunk);
  }
  if (size === 0) throw new Error();
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
};

try {
  const input = await readInput();
  if (!isPlainObject(input)) throw new Error();
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes("schema") || !keys.includes("data")) throw new Error();
  assertBoundedDocument(input.schema, maximumSchemaBytes, maximumSchemaStringBytes);
  assertBoundedDocument(input.data, maximumDataBytes, maximumDataBytes);
  assertSafeSchema(input.schema);

  // Use only the SDK's public provider facade. Its defaults retain data and
  // reject known formats; this boundary never enables coercion, defaults,
  // removeAdditional, custom keywords, custom formats, or remote loaders.
  const valid = isBoolean(input.schema)
    ? input.schema
    : new AjvJsonSchemaValidator().getValidator(input.schema)(input.data).valid === true;
  process.stdout.write(JSON.stringify({ valid }));
} catch {
  // Never print parser, compiler, regex, or native diagnostics to stderr.
  process.exitCode = 1;
}
