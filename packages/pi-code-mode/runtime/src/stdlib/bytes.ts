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
import { SandboxBytes } from "../values.js";
import { coerceToNumber, coerceToString } from "./value.js";

export const byteMethods = new Set(["at", "slice", "subarray", "set", "toBase64", "toHex"]);
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const hex = "0123456789abcdef";
export function byteNumber(value: InterpreterValue): number {
  if (Predicate.isBigInt(value) || Predicate.isSymbol(value))
    throw new InterpreterRuntimeError("Byte values cannot be bigint or symbol.").as("TypeError");
  // Native Number(array) would join its contents before any string budget check.
  return Array.isArray(value) ? Number(coerceToString(value)) : coerceToNumber(value);
}
export function constructBytes(source: InterpreterValue, node: AstNode): SandboxBytes {
  if (source instanceof SandboxBytes) {
    assertBoundedCollectionSize(source.length, "Uint8Array copy", node);
    return new SandboxBytes(source.storage().slice());
  }
  if (Array.isArray(source)) {
    assertBoundedCollectionSize(source.length, "Uint8Array", node);
    return new SandboxBytes(Uint8Array.from(source, byteNumber));
  }
  if (source !== undefined && !Predicate.isNumber(source))
    throw new InterpreterRuntimeError(
      "Uint8Array expects a numeric length or an iterable.",
      node,
    ).as("TypeError");
  const length = source ?? 0;
  if (!Number.isInteger(length) || length < 0)
    throw new InterpreterRuntimeError("Uint8Array length must be a non-negative integer.", node).as(
      "RangeError",
    );
  assertBoundedCollectionSize(length, "Uint8Array", node);
  return new SandboxBytes(new Uint8Array(length));
}
function optionalNumber(value: InterpreterValue, node: AstNode): number | undefined {
  if (value === undefined || Predicate.isNumber(value)) return value;
  throw new InterpreterRuntimeError("Byte offsets must be numbers.", node).as("TypeError");
}
function noOptions(args: InterpreterArray, allowed: number, node: AstNode): void {
  if (args.length > allowed)
    throw new InterpreterRuntimeError(
      "Byte encoding options are not supported; use standard padded base64 or hex.",
      node,
    ).as("TypeError");
}
export function bytesToBase64(bytes: Uint8Array, node?: AstNode): string {
  assertBoundedCollectionSize(bytes.length, "Base64 source", node);
  assertBoundedStringLength(4 * Math.ceil(bytes.length / 3), "Base64 result", node);
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    result +=
      alphabet[a >> 2]! +
      alphabet[((a & 3) << 4) | (b >> 4)]! +
      (i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)]! : "=") +
      (i + 2 < bytes.length ? alphabet[c & 63]! : "=");
  }
  return result;
}
export function bytesFromBase64(text: string, node?: AstNode): SandboxBytes {
  assertBoundedStringLength(text.length, "Base64 input", node);
  // Strict standard alphabet, mandatory padding, canonical trailing bits. No whitespace or URL alphabet.
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const length = (text.length / 4) * 3 - padding;
  assertBoundedCollectionSize(Math.max(0, Math.ceil(length)), "Base64 result", node);
  const invalid = (): never => {
    throw new InterpreterRuntimeError(
      "Invalid base64: use canonical standard padded base64 without whitespace.",
      node,
    ).as("SyntaxError");
  };
  if (text.length % 4 !== 0) invalid();
  for (let i = 0; i < text.length - padding; i++) if (alphabet.indexOf(text[i]!) < 0) invalid();
  if (
    padding &&
    (text.length < 4 ||
      (alphabet.indexOf(text[text.length - padding - 1]!) & (padding === 2 ? 15 : 3)) !== 0)
  )
    invalid();
  const output = new Uint8Array(length);
  let index = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = alphabet.indexOf(text[i]!);
    const b = alphabet.indexOf(text[i + 1]!);
    const c = alphabet.indexOf(text[i + 2]!);
    const d = alphabet.indexOf(text[i + 3]!);
    output[index++] = (a << 2) | (b >> 4);
    if (index < length) output[index++] = (b << 4) | (c >> 2);
    if (index < length) output[index++] = (c << 6) | d;
  }
  return new SandboxBytes(output);
}
export function invokeBytesStatic(
  name: string,
  args: InterpreterArray,
  node: AstNode,
): InterpreterValue {
  noOptions(args, 1, node);
  const text = args[0];
  if (!Predicate.isString(text))
    throw new InterpreterRuntimeError(`Uint8Array.${name} expects a string.`, node).as("TypeError");
  assertBoundedStringLength(text.length, "Byte encoding input", node);
  if (name === "fromBase64") return bytesFromBase64(text, node);
  if (name !== "fromHex")
    throw new InterpreterRuntimeError(`Uint8Array.${name} is not available.`, node);
  assertBoundedCollectionSize(Math.ceil(text.length / 2), "Hex result", node);
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text))
    throw new InterpreterRuntimeError(
      "Invalid hex: use an even number of hexadecimal digits without whitespace.",
      node,
    ).as("SyntaxError");
  const result = new Uint8Array(text.length / 2);
  for (let i = 0; i < result.length; i++) result[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return new SandboxBytes(result);
}
export function invokeBytesMethod(
  ref: IntrinsicReference,
  args: InterpreterArray,
  node: AstNode,
): InterpreterValue {
  const target = ref.receiver;
  if (!(target instanceof SandboxBytes))
    throw new InterpreterRuntimeError("Invalid byte receiver.", node);
  const bytes = target.storage();
  assertBoundedCollectionSize(bytes.length, "Byte operation", node);
  switch (ref.name) {
    case "at":
      return bytes.at(optionalNumber(args[0], node) ?? 0);
    case "slice":
      return new SandboxBytes(
        bytes.slice(optionalNumber(args[0], node), optionalNumber(args[1], node)),
      );
    case "subarray":
      return new SandboxBytes(
        bytes.subarray(optionalNumber(args[0], node), optionalNumber(args[1], node)),
      );
    case "set": {
      const source = args[0];
      if (!(source instanceof SandboxBytes) && !Array.isArray(source))
        throw new InterpreterRuntimeError("Uint8Array.set expects a Uint8Array or array.", node).as(
          "TypeError",
        );
      const offset = optionalNumber(args[1], node) ?? 0;
      if (!Number.isInteger(offset) || offset < 0 || source.length + offset > bytes.length)
        throw new InterpreterRuntimeError(
          "Uint8Array.set source does not fit at that offset.",
          node,
        ).as("RangeError");
      // Convert before mutation; native set preserves overlapping view semantics.
      const input =
        source instanceof SandboxBytes ? source.storage() : constructBytes(source, node).storage();
      bytes.set(input, offset);
      return undefined;
    }
    case "toBase64":
      noOptions(args, 0, node);
      return bytesToBase64(bytes, node);
    case "toHex": {
      noOptions(args, 0, node);
      assertBoundedStringLength(bytes.length * 2, "Hex result", node);
      let text = "";
      for (const byte of bytes) text += hex[byte >> 4]! + hex[byte & 15]!;
      return text;
    }
    default:
      throw new InterpreterRuntimeError(`Uint8Array.${ref.name} is not available.`, node);
  }
}
