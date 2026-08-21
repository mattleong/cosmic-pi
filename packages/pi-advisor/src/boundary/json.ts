// JSON syntax primitives for deterministic prompt formatting are confined here.
// Unknown external payloads are decoded with Effect Schema in their domain modules.
export function stringifyJson<ValueInput>(value: ValueInput): string {
  return JSON.stringify(value);
}
