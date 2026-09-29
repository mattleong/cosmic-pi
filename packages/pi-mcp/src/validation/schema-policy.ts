import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { assertSchemaDocument } from "./schema-rules.mjs";

export const JSON_SCHEMA_VALIDATOR_LIMITS = Object.freeze({
  maximumSchemaBytes: 512 * 1024,
  maximumDataBytes: 8 * 1024 * 1024,
  maximumRequestBytes: 9 * 1024 * 1024,
  maximumDocumentDepth: 64,
  maximumDocumentNodes: 100_000,
  maximumSchemaStringBytes: 256 * 1024,
  maximumResponseBytes: 4 * 1024,
  timeoutMillis: 2_000,
  cleanupTimeoutMillis: 2_000,
});

const invalidDocument = Symbol("invalid-json-schema-document");

type MutableJsonObject = { [key: string]: Schema.Json };
type MutableJsonArray = Array<Schema.Json>;
type MutableJsonContainer = MutableJsonObject | MutableJsonArray;

export interface BoundedJsonLimits {
  readonly bytes: number;
  readonly depth: number;
  readonly nodes: number;
  /** Raw UTF-8 bound for one string or key. Defaults to `bytes`. */
  readonly stringBytes?: number;
}

/** Exact compact-JSON UTF-8 bytes and node count charged by one bounded walk. */
export interface BoundedJsonUsage {
  readonly bytes: number;
  readonly nodes: number;
}

interface WalkMode {
  /** Receives a null-prototype copy at index 0. Without it the walk only measures. */
  readonly holder?: MutableJsonArray;
  /** Accept repeated references. Depth and node limits still bound cycles. */
  readonly allowShared: boolean;
}

interface WalkSlot {
  readonly source: unknown;
  /** Absent while measuring. */
  readonly parent: MutableJsonContainer | undefined;
  readonly key: string | number;
  readonly depth: number;
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

/** Walk own data descriptors of plain JSON, charging exact compact-JSON bytes. */
const walkJson = <Input>(
  root: Input,
  limits: BoundedJsonLimits,
  mode: WalkMode,
): BoundedJsonUsage => {
  const stack: Array<WalkSlot> = [{ source: root, parent: mode.holder, key: 0, depth: 0 }];
  const stringBytes = limits.stringBytes ?? limits.bytes;
  const seen = new Set<object>();
  let nodeCount = 0;
  let byteCount = 0;

  const put = <Value extends Schema.Json>(slot: WalkSlot, value: Value): Value | undefined => {
    if (slot.parent === undefined) return undefined;
    if (Array.isArray(slot.parent)) {
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
    return value;
  };
  const charge = (bytes: number) => {
    if (byteCount > limits.bytes - bytes) throw invalidDocument;
    byteCount += bytes;
  };
  // Count JSON-escaped UTF-8 without allocating an expanded copy of a hostile string.
  const addBytes = (value: string) => {
    if (value.length > stringBytes) throw invalidDocument;
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
      if (bytes > limits.bytes || rawBytes > stringBytes) throw invalidDocument;
    }
    charge(bytes);
  };

  while (stack.length > 0) {
    const slot = stack.pop()!;
    if (slot.depth > limits.depth || nodeCount + stack.length >= limits.nodes)
      throw invalidDocument;
    nodeCount += 1;
    const source = slot.source;
    if (Predicate.isString(source)) {
      addBytes(source);
      put(slot, source);
      continue;
    }
    if (Predicate.isBoolean(source)) {
      charge(source ? 4 : 5);
      put(slot, source);
      continue;
    }
    if (Predicate.isNumber(source)) {
      if (!Number.isFinite(source)) throw invalidDocument;
      charge(JSON.stringify(source).length);
      put(slot, source);
      continue;
    }
    if (source === null) {
      charge(4);
      put(slot, null);
      continue;
    }
    if (!Predicate.isObjectOrArray(source)) throw invalidDocument;
    if (!mode.allowShared) {
      if (seen.has(source)) throw invalidDocument;
      seen.add(source);
    }

    if (Array.isArray(source)) {
      const keys = Object.keys(source);
      if (
        source.length > limits.nodes ||
        keys.length !== source.length ||
        Object.getOwnPropertyNames(source).length !== source.length + 1 ||
        Object.getOwnPropertySymbols(source).length > 0
      )
        throw invalidDocument;
      if (nodeCount + stack.length + source.length > limits.nodes) throw invalidDocument;
      charge(2 + Math.max(0, source.length - 1));
      const target = put<MutableJsonArray>(slot, []);
      for (let index = source.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
        if (descriptor === undefined || !("value" in descriptor)) throw invalidDocument;
        stack.push({ source: descriptor.value, parent: target, key: index, depth: slot.depth + 1 });
      }
      continue;
    }

    if (!isPlainObject(source)) throw invalidDocument;
    const keys = Object.keys(source);
    if (
      keys.length > limits.nodes ||
      Object.getOwnPropertyNames(source).length !== keys.length ||
      Object.getOwnPropertySymbols(source).length > 0
    )
      throw invalidDocument;
    if (nodeCount + stack.length + keys.length > limits.nodes) throw invalidDocument;
    charge(2 + Math.max(0, keys.length - 1) + keys.length);
    // SAFETY: The walk has already established a plain JSON object and the null prototype avoids __proto__ assignment.
    const target = put(slot, Object.create(null) as MutableJsonObject);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      addBytes(key);
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor === undefined || !("value" in descriptor)) throw invalidDocument;
      stack.push({ source: descriptor.value, parent: target, key, depth: slot.depth + 1 });
    }
  }
  return { bytes: byteCount, nodes: nodeCount };
};

const { maximumDocumentDepth: depth, maximumDocumentNodes: nodes } = JSON_SCHEMA_VALIDATOR_LIMITS;

const snapshot = <Input>(
  root: Input,
  limits: BoundedJsonLimits,
  allowShared: boolean,
): Schema.Json => {
  const holder: MutableJsonArray = [];
  walkJson(root, limits, { holder, allowShared });
  const [value] = holder;
  if (value === undefined) throw invalidDocument;
  return value;
};

/** Validator documents and gateway ingress reject any repeated object, not only cycles. */
const strictSnapshot = <Input>(root: Input, bytes: number, stringBytes = bytes) =>
  snapshot(root, { bytes, depth, nodes, stringBytes }, false);

/**
 * Bounded structural ingress precedes recursive Effect Schema decoding. A byte count applies the
 * validator's document depth and node limits strictly; a limits object accepts shared references.
 */
export const snapshotBoundedJson = <Input>(
  root: Input,
  limits: BoundedJsonLimits | number,
): Schema.Json =>
  Predicate.isNumber(limits) ? strictSnapshot(root, limits) : snapshot(root, limits, true);

/** Admission without a copy. Shared references are charged at every occurrence, as JSON prints them. */
export const measureBoundedJson = <Input>(
  root: Input,
  limits: BoundedJsonLimits,
): BoundedJsonUsage => walkJson(root, limits, { allowShared: true });

/**
 * Whether local validation can use this remote schema at all, by the same bounds and
 * rules as the validator's own pre-check. Reference targets are checked by the helper.
 */
export const isSupportedJsonSchema = (schema: Schema.Json): boolean => {
  try {
    assertSchemaDocument(
      strictSnapshot(
        schema,
        JSON_SCHEMA_VALIDATOR_LIMITS.maximumSchemaBytes,
        JSON_SCHEMA_VALIDATOR_LIMITS.maximumSchemaStringBytes,
      ),
      { references: false },
    );
    return true;
  } catch {
    return false;
  }
};

export const encodeSchemaValidationRequest = (
  schema: Schema.Json,
  data: Schema.Json,
): Uint8Array => {
  const safeSchema = strictSnapshot(
    schema,
    JSON_SCHEMA_VALIDATOR_LIMITS.maximumSchemaBytes,
    JSON_SCHEMA_VALIDATOR_LIMITS.maximumSchemaStringBytes,
  );
  // Reject unsupported schemas before process admission. Reference expansion can
  // cost superlinear CPU, so reference targets stay with the helper's deadline.
  assertSchemaDocument(safeSchema, { references: false });
  const safeData = strictSnapshot(data, JSON_SCHEMA_VALIDATOR_LIMITS.maximumDataBytes);
  const encoded = new TextEncoder().encode(JSON.stringify({ data: safeData, schema: safeSchema }));
  if (encoded.byteLength > JSON_SCHEMA_VALIDATOR_LIMITS.maximumRequestBytes) throw invalidDocument;
  return encoded;
};
