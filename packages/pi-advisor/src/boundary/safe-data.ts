/**
 * Snapshot unknown JavaScript values without invoking getters. Proxy traps are
 * treated as invalid input. The result is bounded plain data suitable for Schema.
 */
export const SAFE_DATA_MAX_DEPTH = 16;
export const SAFE_DATA_MAX_ENTRIES = 256;

export function snapshotData(value: unknown, depth = 0): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value !== "object" || depth >= SAFE_DATA_MAX_DEPTH) return undefined;

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return undefined;
  }

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    const lengthDescriptor = descriptors.length;
    const length =
      lengthDescriptor && "value" in lengthDescriptor && typeof lengthDescriptor.value === "number"
        ? Math.min(lengthDescriptor.value, SAFE_DATA_MAX_ENTRIES)
        : 0;
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor) {
        output.push(undefined);
        continue;
      }
      if (!("value" in descriptor)) return undefined;
      output.push(snapshotData(descriptor.value, depth + 1));
    }
    return output;
  }

  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let count = 0;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (count >= SAFE_DATA_MAX_ENTRIES) break;
    if (!("value" in descriptor)) continue;
    Object.defineProperty(output, key, {
      value: snapshotData(descriptor.value, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    count += 1;
  }
  return output;
}

export function snapshotDataRecord(value: unknown): Record<string, unknown> | undefined {
  const snapshot = snapshotData(value);
  return snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>)
    : undefined;
}
