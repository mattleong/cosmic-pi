export { isJsonObject as isRecord } from "pi-cosmic-core";

export function isOneOf<const Values extends readonly unknown[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return values.includes(value);
}
