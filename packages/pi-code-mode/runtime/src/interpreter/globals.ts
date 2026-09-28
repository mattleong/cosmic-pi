import { invokeBytesStatic } from "../stdlib/bytes.js";
import { invokeBase64 } from "../stdlib/encoding.js";
import { dateStatics, invokeDateStatic } from "../stdlib/date.js";
import { invokeMathMethod, mathMethods } from "../stdlib/math.js";
import { invokeNumberStatic } from "../stdlib/number.js";
import { objectStatics } from "../stdlib/object.js";
import { invokeStringStatic } from "../stdlib/string.js";
import { invokeURLStatic, urlStatics } from "../stdlib/url.js";
import {
  type AstNode,
  GlobalMethodReference,
  type InterpreterArray,
  InterpreterRuntimeError,
} from "./model.js";
import { jsonStatics } from "../stdlib/json.js";
import { consoleMethods } from "../stdlib/console.js";

const arrayStatics = new Set(["isArray", "of", "from"]);
const bytesStatics = new Set(["fromBase64", "fromHex"]);
const mapStatics = new Set(["groupBy"]);

/** Whether a global namespace answers to `key`; any other member reads as `undefined`. */
export const hasGlobalStatic = (namespace: string, key: string): boolean => {
  switch (namespace) {
    case "Object":
      return objectStatics.has(key);
    case "Math":
      return mathMethods.has(key);
    case "JSON":
      return jsonStatics.has(key);
    case "console":
      return consoleMethods.has(key);
    case "Array":
      return arrayStatics.has(key);
    case "Date":
      return dateStatics.has(key);
    case "URL":
      return urlStatics.has(key);
    case "Uint8Array":
      return bytesStatics.has(key);
    case "Map":
      return mapStatics.has(key);
    default:
      return false;
  }
};

// Array.from takes callbacks and is dispatched with the other callback-taking built-ins.
export const invokeArrayStatic = (name: string, args: InterpreterArray, node: AstNode) => {
  switch (name) {
    case "isArray":
      return Array.isArray(args[0]);
    case "of":
      return [...args];
    default:
      throw new InterpreterRuntimeError(`Array.${name} is not available in CodeMode.`, node);
  }
};

export const invokeGlobalMethod = (
  ref: GlobalMethodReference,
  args: InterpreterArray,
  node: AstNode,
) => {
  if (ref.namespace === "Uint8Array") return invokeBytesStatic(ref.name, args, node);
  if (ref.namespace === "Encoding" && (ref.name === "atob" || ref.name === "btoa"))
    return invokeBase64(ref.name, args, node);
  if (ref.namespace === "Math") return invokeMathMethod(ref.name, args, node);
  if (ref.namespace === "Array") return invokeArrayStatic(ref.name, args, node);
  if (ref.namespace === "Number") return invokeNumberStatic(ref.name, args, node);
  if (ref.namespace === "String") return invokeStringStatic(ref.name, args, node);
  if (ref.namespace === "URL") return invokeURLStatic(ref.name, args, node);
  if (ref.namespace === "Date") {
    if (!dateStatics.has(ref.name))
      throw new InterpreterRuntimeError(`Date.${ref.name} is not available in CodeMode.`, node);
    return invokeDateStatic(ref.name, args, node);
  }
  throw new InterpreterRuntimeError(
    `${ref.namespace}.${ref.name} is not available in CodeMode.`,
    node,
  );
};
