import * as Predicate from "effect/Predicate";
import {
  assertBoundedCollectionSize,
  assertBoundedStringLength,
} from "../interpreter/confinement.js";
import {
  type AstNode,
  type InterpreterArray,
  type InterpreterValue,
  InterpreterRuntimeError,
  type IntrinsicReference,
} from "../interpreter/model.js";
import { SandboxBytes, SandboxTextDecoder, SandboxTextEncoder } from "../values.js";
import { bytesFromBase64, bytesToBase64 } from "./bytes.js";
import { coerceToString } from "./value.js";

const utf8Labels = new Set([
  "utf-8",
  "utf8",
  "unicode-1-1-utf-8",
  "unicode11utf8",
  "unicode20utf8",
  "x-unicode20utf8",
]);
export function constructTextDecoder(args: InterpreterArray, node: AstNode): SandboxTextDecoder {
  const label = args[0] === undefined ? "utf-8" : coerceToString(args[0]).trim().toLowerCase();
  if (!utf8Labels.has(label))
    throw new InterpreterRuntimeError("TextDecoder supports only UTF-8.", node).as("RangeError");
  const options = args[1];
  let fatal = false;
  let ignoreBOM = false;
  if (options !== undefined) {
    if (
      options === null ||
      !Predicate.isObject(options) ||
      Array.isArray(options) ||
      Object.getPrototypeOf(options) !== null
    )
      throw new InterpreterRuntimeError(
        "TextDecoder options must be a plain data object.",
        node,
      ).as("TypeError");
    for (const key of Object.keys(options)) {
      if (key !== "fatal" && key !== "ignoreBOM")
        throw new InterpreterRuntimeError(`Unsupported TextDecoder option '${key}'.`, node).as(
          "TypeError",
        );
      const value = Object.getOwnPropertyDescriptor(options, key)?.value;
      if (!Predicate.isBoolean(value))
        throw new InterpreterRuntimeError("TextDecoder flags must be booleans.", node).as(
          "TypeError",
        );
      if (key === "fatal") fatal = value;
      else ignoreBOM = value;
    }
  }
  if (args.length > 2)
    throw new InterpreterRuntimeError("TextDecoder accepts only a UTF-8 label and flags.", node).as(
      "TypeError",
    );
  return new SandboxTextDecoder(fatal, ignoreBOM);
}
/** Count exact UTF-8 output before the native encoder allocates, including replacement of lone surrogates. */
export function utf8Length(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) length++;
    else if (code < 0x800) length += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      length += 4;
      i++;
    } else length += 3;
  }
  return length;
}
export function invokeEncodingMethod(
  ref: IntrinsicReference,
  args: InterpreterArray,
  node: AstNode,
): InterpreterValue {
  if (args.length > 1)
    throw new InterpreterRuntimeError("Encoding options and streaming are not supported.", node).as(
      "TypeError",
    );
  if (ref.receiver instanceof SandboxTextEncoder && ref.name === "encode") {
    const text = args[0] === undefined ? "" : coerceToString(args[0]);
    assertBoundedStringLength(text.length, "UTF-8 input", node);
    assertBoundedCollectionSize(utf8Length(text), "UTF-8 result", node);
    return new SandboxBytes(new TextEncoder().encode(text));
  }
  if (ref.receiver instanceof SandboxTextDecoder && ref.name === "decode") {
    const source = args[0];
    if (source === undefined) return "";
    if (!(source instanceof SandboxBytes))
      throw new InterpreterRuntimeError("TextDecoder.decode expects a Uint8Array.", node).as(
        "TypeError",
      );
    assertBoundedCollectionSize(source.length, "UTF-8 input", node);
    assertBoundedStringLength(source.length, "UTF-8 decoded result", node);
    try {
      return new TextDecoder("utf-8", {
        fatal: ref.receiver.fatal,
        ignoreBOM: ref.receiver.ignoreBOM,
      }).decode(source.storage());
    } catch {
      throw new InterpreterRuntimeError("TextDecoder input is not valid UTF-8.", node).as(
        "TypeError",
      );
    }
  }
  throw new InterpreterRuntimeError("Encoding method is not available.", node);
}
export function invokeBase64(name: "atob" | "btoa", args: InterpreterArray, node: AstNode): string {
  if (args.length !== 1 || !Predicate.isString(args[0]))
    throw new InterpreterRuntimeError(`${name} expects one string.`, node).as("TypeError");
  const text = args[0];
  assertBoundedStringLength(text.length, `${name} input`, node);
  if (name === "btoa") {
    assertBoundedCollectionSize(text.length, "btoa bytes", node);
    assertBoundedStringLength(4 * Math.ceil(text.length / 3), "btoa result", node);
    for (let i = 0; i < text.length; i++)
      if (text.charCodeAt(i) > 255)
        throw new InterpreterRuntimeError(
          "btoa expects a Latin-1 binary string; use TextEncoder for Unicode.",
          node,
        ).as("TypeError");
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytesToBase64(bytes, node);
  }
  // The same strict canonical subset as Uint8Array.fromBase64.
  const bytes = bytesFromBase64(text, node).storage();
  assertBoundedStringLength(bytes.length, "atob result", node);
  let result = "";
  for (const byte of bytes) result += String.fromCharCode(byte);
  return result;
}
