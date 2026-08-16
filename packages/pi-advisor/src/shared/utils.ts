export { isJsonObject as isRecord } from "pi-cosmic-core";

export function isOneOf<const Values extends readonly unknown[], ValueInput>(
  value: ValueInput,
  values: Values,
): value is ValueInput & Values[number] {
  return values.includes(value);
}
