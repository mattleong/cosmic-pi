export const urlProperties = new Set([
  "href",
  "origin",
  "protocol",
  "username",
  "password",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
]);

export const urlWritableProperties = new Set([
  "href",
  "protocol",
  "username",
  "password",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
]);

export const urlMethods = new Set(["toString", "toJSON"]);
export const urlStatics = new Set(["canParse", "parse"]);
export const urlSearchParamsMethods = new Set([
  "append",
  "delete",
  "get",
  "getAll",
  "has",
  "set",
  "sort",
  "forEach",
  "keys",
  "values",
  "entries",
  "toString",
]);

export const uriArgument = (value: unknown, label: string): string =>
  coerceToString(boundedData(value, label));

export const invokeUriFunction = (
  ref: UriFunction,
  args: Array<unknown>,
  node: AstNode,
): string => {
  const value = uriArgument(args[0], `${ref.name} input`);
  // Confinement preflight: percent-encoding expands (up to 3x for ASCII, up to 9x for
  // non-ASCII code units), so the worst case is charged before the native encoder
  // materializes its output. Decoding never expands, so it needs no preflight.
  if (ref.name === "encodeURI" || ref.name === "encodeURIComponent") {
    assertBoundedStringLength(uriEncodedLengthUpperBound(value), ref.name, node);
  }
  try {
    switch (ref.name) {
      case "encodeURI":
        return encodeURI(value);
      case "encodeURIComponent":
        return encodeURIComponent(value);
      case "decodeURI":
        return decodeURI(value);
      case "decodeURIComponent":
        return decodeURIComponent(value);
    }
  } catch (error) {
    throw new InterpreterRuntimeError(
      `${ref.name} received malformed URI data: ${error instanceof Error ? error.message : String(error)}`,
      node,
    ).as("URIError");
  }
};

export const urlArgument = (value: unknown, label: string): string =>
  value instanceof SandboxURL ? value.url.href : uriArgument(value, label);

export const invokeURLStatic = (name: string, args: Array<unknown>, node: AstNode): unknown => {
  if (!urlStatics.has(name))
    throw new InterpreterRuntimeError(`URL.${name} is not available in CodeMode.`, node);
  if (args.length === 0)
    throw new InterpreterRuntimeError(`URL.${name} requires a URL argument.`, node).as("TypeError");
  const input = urlArgument(args[0], `URL.${name} input`);
  const base = args[1] === undefined ? undefined : urlArgument(args[1], `URL.${name} base`);
  // Confinement preflight: URL normalization percent-encodes, so the worst-case href length
  // is charged before the native constructor materializes it.
  assertBoundedStringLength(
    uriEncodedLengthUpperBound(input) + (base === undefined ? 0 : uriEncodedLengthUpperBound(base)),
    `URL.${name}`,
    node,
  );
  // Confinement preflight: the query segment's projected pair count is charged before the
  // native URL parses it (an over-cap query is refused with a diagnostic, for canParse too,
  // rather than reported as unparseable).
  assertBoundedUrlQueryPairs(input, `URL.${name}`, node);
  if (base !== undefined) assertBoundedUrlQueryPairs(base, `URL.${name}`, node);
  try {
    const url = new URL(input, base);
    return name === "canParse" ? true : new SandboxURL(url);
  } catch {
    return name === "canParse" ? false : null;
  }
};

export const invokeURLMethod = (value: SandboxURL, name: string, node: AstNode): string => {
  if (name === "toString" || name === "toJSON") return value.url.href;
  throw new InterpreterRuntimeError(`URL method '${name}' is not available in CodeMode.`, node);
};
import {
  assertBoundedStringLength,
  assertBoundedUrlQueryPairs,
  uriEncodedLengthUpperBound,
} from "../interpreter/confinement.js";
import { type AstNode, InterpreterRuntimeError, UriFunction } from "../interpreter/model.js";
import { SandboxURL } from "../values.js";
import { boundedData, coerceToString } from "./value.js";
