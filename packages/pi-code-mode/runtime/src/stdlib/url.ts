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

export const readUrlProperty = (value: SandboxURL, name: string): string | undefined => {
  switch (name) {
    case "href":
      return value.url.href;
    case "origin":
      return value.url.origin;
    case "protocol":
      return value.url.protocol;
    case "username":
      return value.url.username;
    case "password":
      return value.url.password;
    case "host":
      return value.url.host;
    case "hostname":
      return value.url.hostname;
    case "port":
      return value.url.port;
    case "pathname":
      return value.url.pathname;
    case "search":
      return value.url.search;
    case "hash":
      return value.url.hash;
    default:
      return undefined;
  }
};

export const writeUrlProperty = (value: SandboxURL, name: string, next: string): boolean => {
  switch (name) {
    case "href":
      value.url.href = next;
      return true;
    case "protocol":
      value.url.protocol = next;
      return true;
    case "username":
      value.url.username = next;
      return true;
    case "password":
      value.url.password = next;
      return true;
    case "host":
      value.url.host = next;
      return true;
    case "hostname":
      value.url.hostname = next;
      return true;
    case "port":
      value.url.port = next;
      return true;
    case "pathname":
      value.url.pathname = next;
      return true;
    case "search":
      value.url.search = next;
      return true;
    case "hash":
      value.url.hash = next;
      return true;
    default:
      return false;
  }
};

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

export const uriArgument = (value: InterpreterValue, label: string): string =>
  coerceToString(boundedData(value, label));

export const invokeUriFunction = (
  ref: UriFunction,
  args: InterpreterArray,
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

export const urlArgument = (value: InterpreterValue, label: string): string =>
  value instanceof SandboxURL ? value.url.href : uriArgument(value, label);

export const invokeURLStatic = (name: string, args: InterpreterArray, node: AstNode) => {
  if (!urlStatics.has(name))
    throw new InterpreterRuntimeError(`URL.${name} is not available in CodeMode.`, node);
  if (args.length === 0)
    throw new InterpreterRuntimeError(`URL.${name} requires a URL argument.`, node).as("TypeError");
  const input = urlArgument(args[0], `URL.${name} input`);
  const base = args[1] === undefined ? undefined : urlArgument(args[1], `URL.${name} base`);
  // Confinement failures remain diagnostics for canParse rather than becoming false.
  assertBoundedUrlConstructionInputs(input, base, `URL.${name}`, node);
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
  assertBoundedUrlConstructionInputs,
  uriEncodedLengthUpperBound,
} from "../interpreter/confinement.js";
import {
  type AstNode,
  type InterpreterArray,
  InterpreterRuntimeError,
  type InterpreterValue,
  UriFunction,
} from "../interpreter/model.js";
import { SandboxURL } from "../values.js";
import { boundedData, coerceToString } from "./value.js";
