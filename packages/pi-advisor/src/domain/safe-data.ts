import { hasObjectRuntimeType, isBooleanValue, isNumberValue, isStringValue } from "pi-cosmic-core";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
/**
 * Snapshot unknown JavaScript values without invoking getters. Proxy traps are
 * treated as invalid input. The result is bounded plain data suitable for Schema.
 */
export const SAFE_DATA_MAX_DEPTH = 16;
export const SAFE_DATA_MAX_ENTRIES = 256;

const snapshotDataUnchecked = <ValueInput>(
  value: ValueInput,
  depth = 0,
): Schema.MutableJson | undefined => {
  if (value === null) return null;
  if (isStringValue(value)) return value;
  if (isNumberValue(value)) return Number.isFinite(value) ? value : undefined;
  if (isBooleanValue(value)) return value;
  if (!hasObjectRuntimeType(value) || depth >= SAFE_DATA_MAX_DEPTH) return undefined;

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return undefined;
  }

  if (Array.isArray(value)) {
    const output: Schema.MutableJson[] = [];
    const lengthDescriptor = descriptors.length;
    const length =
      lengthDescriptor && "value" in lengthDescriptor && isNumberValue(lengthDescriptor.value)
        ? Math.min(lengthDescriptor.value, SAFE_DATA_MAX_ENTRIES)
        : 0;
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor) {
        output.push(null);
        continue;
      }
      if (!("value" in descriptor)) return undefined;
      output.push(snapshotDataUnchecked(descriptor.value, depth + 1) ?? null);
    }
    return output;
  }

  const output: Schema.MutableJsonObject = Object.create(null);
  let count = 0;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (count >= SAFE_DATA_MAX_ENTRIES) break;
    if (!("value" in descriptor)) continue;
    const item = snapshotDataUnchecked(descriptor.value, depth + 1);
    if (item === undefined) continue;
    Object.defineProperty(output, key, {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    count += 1;
  }
  return output;
};

export function snapshotData<ValueInput>(value: ValueInput): Schema.MutableJson | undefined {
  const snapshot = snapshotDataUnchecked(value);
  const decoded = Schema.decodeUnknownOption(Schema.MutableJson)(snapshot);
  return Option.isSome(decoded) ? decoded.value : undefined;
}

export function snapshotDataRecord<ValueInput>(
  value: ValueInput,
): Schema.MutableJsonObject | undefined {
  const snapshot = snapshotDataUnchecked(value);
  const decoded = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.MutableJson))(
    snapshot,
  );
  return Option.isSome(decoded) ? decoded.value : undefined;
}
