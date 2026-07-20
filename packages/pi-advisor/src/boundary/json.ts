// JSON syntax primitives for deterministic prompt formatting are confined here.
// Unknown external payloads are decoded with Effect Schema in their domain modules.
export function parseJson(value: string): unknown {
  return JSON.parse(value);
}
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}
