// The one JSON Schema policy for the validator helper and its parent pre-check.
// It is plain ESM because the helper runs it under Node, which does not strip
// TypeScript types from packages installed under node_modules.
const maximumSchemaBytes = 512 * 1024;
const maximumDataBytes = 8 * 1024 * 1024;
const maximumSchemaStringBytes = 256 * 1024;
const maximumDepth = 64;
const maximumNodes = 100_000;

const normalizeDialect = (value) => value.replace(/^http:/, "https:").replace(/#$/, "");
const allowedDialects = new Set([
  "https://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2019-09/schema",
  "https://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-06/schema",
]);
const legacyTupleDialects = new Set([
  "https://json-schema.org/draft/2019-09/schema",
  "https://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-06/schema",
]);

const supportedVocabularies = new Set([
  ...[
    "core",
    "applicator",
    "unevaluated",
    "validation",
    "meta-data",
    "format-annotation",
    "content",
  ].map((name) => `https://json-schema.org/draft/2020-12/vocab/${name}`),
  ...["core", "applicator", "validation", "meta-data", "format", "content"].map(
    (name) => `https://json-schema.org/draft/2019-09/vocab/${name}`,
  ),
]);

const bundledSchemaIdentifiers = new Set([
  ...allowedDialects,
  "https://json-schema.org/schema",
  ...Array.from(supportedVocabularies, (uri) => uri.replace("/vocab/", "/meta/")),
]);
const isBundledIdentifier = (value) => {
  try {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "https:";
    url.hash = "";
    return bundledSchemaIdentifiers.has(url.href);
  } catch {
    // Relative identifiers cannot collide with a bundled absolute identifier.
    return false;
  }
};

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
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "contentEncoding",
  "contentMediaType",
  "$comment",
  "format",
  "pattern",
  "title",
  "description",
]);
const booleanKeywords = new Set([
  "uniqueItems",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$recursiveAnchor",
]);
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
export const isBoolean = (value) => value === true || value === false;
export const isPlainObject = (value) =>
  objectTag.call(value) === "[object Object]" && !Array.isArray(value);
const isSchemaNode = (value) => isBoolean(value) || isPlainObject(value);
const schemaSupportsTupleItems = (root) =>
  isPlainObject(root) &&
  isString(root.$schema) &&
  legacyTupleDialects.has(normalizeDialect(root.$schema));
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
  if (key === "contentSchema" && !isSchemaNode(value)) throw new Error();
  // OpenAPI nullable changes the meaning of type in Ajv; it is not a JSON
  // Schema annotation in this engine, so do not silently weaken constraints.
  if (key === "nullable") throw new Error();
  if (key === "$vocabulary") {
    if (!isPlainObject(value)) throw new Error();
    for (const [uri, required] of Object.entries(value)) {
      if (!isBoolean(required) || (required && !supportedVocabularies.has(uri))) throw new Error();
    }
  }
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

// JSON Pointers can promote any object, including literal annotation data, to
// a schema. Index possible local resources without reimplementing Ajv's URI
// resolver or using its private fields. This deliberately overapproximates
// resource scope: the same pointer/anchor in different $id resources is checked
// in all of them. Apart from the document-wide $async ban, unreferenced
// literals remain data. Ajv decides whether references actually resolve and
// never gets an external loader.
const referenceTargets = (root) => {
  const resources = [{ value: root, depth: 0 }];
  const anchors = new Map();
  const locations = new Map();
  const document = [...resources];
  const addAnchor = (name, entry) => {
    let key = name;
    try {
      key = decodeURIComponent(name);
    } catch {
      // Malformed identifiers in unreferenced literal data are still data.
    }
    const entries = anchors.get(key) ?? [];
    entries.push(entry);
    anchors.set(key, entries);
  };
  while (document.length > 0) {
    const entry = document.pop();
    const node = entry.value;
    if (!isPlainObject(node) && !Array.isArray(node)) continue;
    locations.set(node, entry);
    if (isPlainObject(node)) {
      if (isString(node.$id)) {
        if (node !== root) resources.push(entry);
        const fragment = node.$id.indexOf("#");
        if (fragment >= 0) addAnchor(node.$id.slice(fragment + 1), entry);
      }
      for (const key of ["$anchor", "$dynamicAnchor"]) {
        if (isString(node[key])) addAnchor(node[key], entry);
      }
    }
    const scope = isPlainObject(node) && isString(node.$id) ? entry : entry.scope;
    for (const value of Object.values(node)) {
      document.push({ value, depth: entry.depth + 1, scope });
    }
  }
  const withScopes = (entries) => {
    const result = new Set(entries);
    for (const entry of result) {
      // A reference into a resource also inherits its declared dialect and
      // vocabulary, even when the referenced descendant has neither keyword.
      if (entry.scope !== undefined) result.add(entry.scope);
    }
    return [...result];
  };
  const checked = new Set();
  let steps = 0;
  return (reference) => {
    const hash = reference.indexOf("#");
    const fragment = hash < 0 ? "" : reference.slice(hash + 1);
    if (checked.has(fragment)) return [];
    checked.add(fragment);
    if (fragment === "") return withScopes(resources);
    // URI normalization precedes pointer classification and splitting in the SDK.
    // Decode once, then unescape pointer tokens. In particular %2F separates
    // tokens, while %252F denotes the literal text %2F, not another separator.
    const decoded = decodeURIComponent(fragment);
    const targets = [...(anchors.get(decoded) ?? [])];
    // Some URI schemes retain escapes until pointer-token decoding. Check that
    // interpretation too, without choosing a resolver or guessing resource bases.
    const pointers = [decoded.startsWith("/") ? decoded.slice(1).split("/") : []];
    if (fragment !== decoded && fragment.startsWith("/"))
      pointers.push(
        fragment
          .slice(1)
          .split("/")
          .map((token) => decodeURIComponent(token)),
      );
    for (const parts of pointers) {
      if (parts.length === 0) continue;
      const tokens = parts.map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
      for (const resource of resources) {
        let value = resource.value;
        let scope = resource;
        for (const token of tokens) {
          if (++steps > maximumNodes) throw new Error();
          if (isPlainObject(value) && isString(value.$id)) scope = locations.get(value);
          if ((!isPlainObject(value) && !Array.isArray(value)) || !Object.hasOwn(value, token)) {
            value = undefined;
            break;
          }
          value = value[token];
        }
        if (value !== undefined) {
          if (!isSchemaNode(value)) throw new Error();
          targets.push(
            locations.get(value) ?? { value, depth: resource.depth + tokens.length, scope },
          );
        }
      }
    }
    return withScopes(targets);
  };
};

// The parent bounds ingress before dispatch. The helper independently checks
// its input and refuses unsupported engine extensions. Unknown keywords are
// annotations; no keyword implementations are installed.
const assertSafeSchema = (root, references) => {
  if (isBoolean(root)) return;
  if (!isPlainObject(root)) throw new Error();
  const supportsTupleItems = schemaSupportsTupleItems(root);
  const dialect = normalizeDialect(root.$schema ?? "https://json-schema.org/draft/2020-12/schema");
  // getValidator reuses an existing validator for a root $id. Do not let a
  // bundled metaschema identifier bypass compilation of the supplied schema.
  if (isString(root.$id) && isBundledIdentifier(root.$id)) throw new Error();
  const targets = references ? referenceTargets(root) : () => [];
  const stack = [{ value: root, depth: 0 }];
  const seen = new Set();
  let nodes = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    const node = entry.value;
    if (entry.depth > maximumDepth) throw new Error();
    if (isBoolean(node)) continue;
    if (!isPlainObject(node)) throw new Error();
    if (seen.has(node)) continue;
    seen.add(node);
    nodes += 1;
    if (nodes > maximumNodes) throw new Error();

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (
        (key === "prefixItems" && supportsTupleItems) ||
        (key === "additionalItems" && !supportsTupleItems)
      )
        continue;
      assertKeywordValue(key, value);
      const childDepth = entry.depth + 1;
      if (key === "$ref" || key === "$dynamicRef" || key === "$recursiveRef") {
        stack.push(...targets(value));
      } else if (key === "$schema") {
        if (
          !isString(value) ||
          !allowedDialects.has(normalizeDialect(value)) ||
          normalizeDialect(value) !== dialect
        )
          throw new Error();
      } else if (key === "dependencies") {
        if (!isPlainObject(value)) throw new Error();
        for (const [name, dependency] of Object.entries(value)) {
          if (name === "__proto__") throw new Error();
          if (!isStringArray(dependency)) requireSchemaNode(stack, dependency, childDepth);
        }
      } else if (schemaChildKeywords.has(key)) {
        requireSchemaNode(stack, value, childDepth);
      } else if (schemaArrayKeywords.has(key)) {
        requireSchemaArray(stack, value, childDepth);
      } else if (schemaMapKeywords.has(key)) {
        requireSchemaMap(stack, value, childDepth);
      } else if (key === "items" || key === "additionalItems") {
        if (Array.isArray(value)) {
          if (key !== "items" || !supportsTupleItems) throw new Error();
          requireSchemaArray(stack, value, childDepth);
        } else {
          requireSchemaNode(stack, value, childDepth);
        }
      }
    }
  }
};

const assertBoundedDocument = (root, maximumBytes, maximumStringBytes, schemaDocument = false) => {
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
        // A JSON Pointer can promote annotation objects to schemas. Reject the
        // async extension throughout the schema, not just known applicators.
        if (schemaDocument && key === "$async") throw new Error();
        if (Buffer.byteLength(key, "utf8") > maximumStringBytes) throw new Error();
        stack.push({ value: value[key], depth: depth + 1 });
      }
    }
  }
};

/**
 * Throws unless the schema is bounded and inside the supported policy. Without
 * references only applicator positions are walked, in linear time; reference
 * targets and their encodings are left to the helper and its deadline.
 */
export const assertSchemaDocument = (schema, { references = true } = {}) => {
  assertBoundedDocument(schema, maximumSchemaBytes, maximumSchemaStringBytes, true);
  assertSafeSchema(schema, references);
};

/** Throws unless the data document is within its bounds. */
export const assertDataDocument = (data) =>
  assertBoundedDocument(data, maximumDataBytes, maximumDataBytes);
