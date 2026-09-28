import {
  type AstNode,
  type InterpreterArray,
  InterpreterRuntimeError,
  type InterpreterValue,
} from "../interpreter/model.js";
import { MethodTable } from "./method-table.js";
import { SandboxDate } from "../values.js";
import { epochNow, hostDate } from "./epoch.js";
import { coerceToNumber, coerceToString } from "../interpreter/conversions.js";

type DateMethod = (value: SandboxDate, node: AstNode) => InterpreterValue;

/** A component getter: invalid dates answer NaN, as in JS. */
const component =
  (read: (date: Date) => number): DateMethod =>
  (value) =>
    Number.isFinite(value.time) ? read(hostDate(value.time)) : Number.NaN;

const time: DateMethod = (value) => value.time;

export const dateMethods = new MethodTable<DateMethod>({
  getTime: time,
  valueOf: time,
  toISOString: (value, node) => {
    if (!Number.isFinite(value.time))
      throw new InterpreterRuntimeError("Invalid time value.", node);
    return hostDate(value.time).toISOString();
  },
  toJSON: (value) => (Number.isFinite(value.time) ? hostDate(value.time).toISOString() : null),
  // `toString` is typed explicitly: object literals type that key from Object.prototype.
  toString: (value: SandboxDate) => coerceToString(value),
  getFullYear: component((date) => date.getFullYear()),
  getMonth: component((date) => date.getMonth()),
  getDate: component((date) => date.getDate()),
  getDay: component((date) => date.getDay()),
  getHours: component((date) => date.getHours()),
  getMinutes: component((date) => date.getMinutes()),
  getSeconds: component((date) => date.getSeconds()),
  getMilliseconds: component((date) => date.getMilliseconds()),
  getUTCFullYear: component((date) => date.getUTCFullYear()),
  getUTCMonth: component((date) => date.getUTCMonth()),
  getUTCDate: component((date) => date.getUTCDate()),
  getUTCDay: component((date) => date.getUTCDay()),
  getUTCHours: component((date) => date.getUTCHours()),
  getUTCMinutes: component((date) => date.getUTCMinutes()),
  getUTCSeconds: component((date) => date.getUTCSeconds()),
  getUTCMilliseconds: component((date) => date.getUTCMilliseconds()),
  getTimezoneOffset: component((date) => date.getTimezoneOffset()),
});

export const dateStatics = new Set(["now", "parse", "UTC"]);

export const invokeDateStatic = (name: string, args: InterpreterArray, node: AstNode): number => {
  switch (name) {
    case "now":
      return epochNow();
    case "parse":
      return Date.parse(coerceToString(args[0]));
    case "UTC":
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return Date.UTC(...(args.map((arg) => coerceToNumber(arg)) as Parameters<typeof Date.UTC>));
    default:
      throw new InterpreterRuntimeError(`Date.${name} is not available in CodeMode.`, node);
  }
};

export const invokeDateMethod = (value: SandboxDate, name: string, node: AstNode) => {
  const method = dateMethods.get(name);
  if (method === undefined)
    throw new InterpreterRuntimeError(`Date method '${name}' is not available in CodeMode.`, node);
  return method(value, node);
};
