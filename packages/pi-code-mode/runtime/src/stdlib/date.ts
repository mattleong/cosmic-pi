export const dateMethods = new Set([
  "getTime",
  "valueOf",
  "toISOString",
  "toJSON",
  "toString",
  "getFullYear",
  "getMonth",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getSeconds",
  "getMilliseconds",
  "getUTCFullYear",
  "getUTCMonth",
  "getUTCDate",
  "getUTCDay",
  "getUTCHours",
  "getUTCMinutes",
  "getUTCSeconds",
  "getUTCMilliseconds",
  "getTimezoneOffset",
]);

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
  if (!Number.isFinite(value.time)) return invokeInvalidDateMethod(value, name, node);
  const hosted = hostDate(value.time);
  switch (name) {
    case "getTime":
    case "valueOf":
      return value.time;
    case "toISOString":
      return hosted.toISOString();
    case "toJSON":
      return hosted.toISOString();
    case "toString":
      return coerceToString(value);
    case "getFullYear":
      return hosted.getFullYear();
    case "getMonth":
      return hosted.getMonth();
    case "getDate":
      return hosted.getDate();
    case "getDay":
      return hosted.getDay();
    case "getHours":
      return hosted.getHours();
    case "getMinutes":
      return hosted.getMinutes();
    case "getSeconds":
      return hosted.getSeconds();
    case "getMilliseconds":
      return hosted.getMilliseconds();
    case "getUTCFullYear":
      return hosted.getUTCFullYear();
    case "getUTCMonth":
      return hosted.getUTCMonth();
    case "getUTCDate":
      return hosted.getUTCDate();
    case "getUTCDay":
      return hosted.getUTCDay();
    case "getUTCHours":
      return hosted.getUTCHours();
    case "getUTCMinutes":
      return hosted.getUTCMinutes();
    case "getUTCSeconds":
      return hosted.getUTCSeconds();
    case "getUTCMilliseconds":
      return hosted.getUTCMilliseconds();
    case "getTimezoneOffset":
      return hosted.getTimezoneOffset();
    default:
      throw new InterpreterRuntimeError(
        `Date method '${name}' is not available in CodeMode.`,
        node,
      );
  }
};

/** Invalid Date semantics: every component getter is NaN; ISO conversion refuses. */
const invokeInvalidDateMethod = (value: SandboxDate, name: string, node: AstNode) => {
  switch (name) {
    case "getTime":
    case "valueOf":
      return value.time;
    case "toISOString":
      throw new InterpreterRuntimeError("Invalid time value.", node);
    case "toJSON":
      return null;
    case "toString":
      return coerceToString(value);
    default:
      if (dateMethods.has(name)) return Number.NaN;
      throw new InterpreterRuntimeError(
        `Date method '${name}' is not available in CodeMode.`,
        node,
      );
  }
};
import {
  type AstNode,
  type InterpreterArray,
  InterpreterRuntimeError,
} from "../interpreter/model.js";
import { SandboxDate } from "../values.js";
import { epochNow, hostDate } from "./epoch.js";
import { coerceToNumber, coerceToString } from "./value.js";
