import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "../runtime-values.js";
import type { SandboxURL, SandboxValue } from "../values.js";

export type SourcePosition = {
  line: number;
  column: number;
};

export type SourceLocation = {
  start: SourcePosition;
  end: SourcePosition;
};

export interface AstPropertyRecord {
  [key: string]: AstPropertyValue;
}

/** Recursive data fields emitted by the pinned Acorn parser. */
export type AstPropertyValue =
  | undefined
  | null
  | string
  | number
  | bigint
  | boolean
  | RegExp
  | SourceLocation
  | AstPropertyRecord
  | AstNode
  | Array<AstPropertyValue>;

export type AstNode = {
  type: string;
  loc?: SourceLocation;
  [key: string]: AstPropertyValue;
};

export type ProgramNode = AstNode & {
  type: "Program";
  body: Array<AstNode>;
};

export type Binding = {
  mutable: boolean;
  value: InterpreterValue;
  initialized?: boolean;
};

export type StatementResult =
  | { kind: "none" }
  | { kind: "value"; value: InterpreterValue }
  | { kind: "return"; value: InterpreterValue }
  | { kind: "break" }
  | { kind: "continue" };

export type MemberReference = {
  target: InterpreterObject | InterpreterArray | SandboxURL;
  key: string | number;
};

export class CodeModeFunction {
  readonly parameters: ReadonlyArray<AstNode>;
  readonly body: AstNode;
  readonly capturedScopes: ReadonlyArray<Map<string, Binding>>;
  constructor(
    parameters: ReadonlyArray<AstNode>,
    body: AstNode,
    capturedScopes: ReadonlyArray<Map<string, Binding>>,
  ) {
    this.parameters = parameters;
    this.body = body;
    this.capturedScopes = capturedScopes;
  }
}

export class IntrinsicReference {
  readonly receiver: InterpreterValue;
  readonly name: string;
  constructor(receiver: InterpreterValue, name: string) {
    this.receiver = receiver;
    this.name = name;
  }
}

export class ComputedValue {
  readonly value: InterpreterValue;
  constructor(value: InterpreterValue) {
    this.value = value;
  }
}

export class PromiseNamespace {}

export type PromiseMethodName = "all" | "allSettled" | "race" | "resolve" | "reject";

export class PromiseMethodReference {
  readonly name: PromiseMethodName;
  constructor(name: PromiseMethodName) {
    this.name = name;
  }
}

export type GlobalNamespaceName =
  | "Object"
  | "Math"
  | "JSON"
  | "Array"
  | "console"
  | "Date"
  | "RegExp"
  | "Map"
  | "Set"
  | "URL"
  | "URLSearchParams";

export class GlobalNamespace {
  readonly name: GlobalNamespaceName;
  constructor(name: GlobalNamespaceName) {
    this.name = name;
  }
}

export class GlobalMethodReference {
  readonly namespace: GlobalNamespaceName | "Number" | "String";
  readonly name: string;
  constructor(namespace: GlobalNamespaceName | "Number" | "String", name: string) {
    this.namespace = namespace;
    this.name = name;
  }
}

export class CoercionFunction {
  readonly name: "Number" | "String" | "Boolean" | "parseInt" | "parseFloat";
  constructor(name: "Number" | "String" | "Boolean" | "parseInt" | "parseFloat") {
    this.name = name;
  }
}

export class UriFunction {
  readonly name: "encodeURI" | "encodeURIComponent" | "decodeURI" | "decodeURIComponent";
  constructor(name: "encodeURI" | "encodeURIComponent" | "decodeURI" | "decodeURIComponent") {
    this.name = name;
  }
}

export class ProgramThrow {
  readonly value: InterpreterValue;
  constructor(value: InterpreterValue) {
    this.value = value;
  }
}

export class ErrorConstructorReference {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

export class ToolReference {
  readonly path: ReadonlyArray<string>;
  constructor(path: ReadonlyArray<string>) {
    this.path = path;
  }
}

export type InterpreterPrimitive = undefined | null | string | number | boolean | bigint | symbol;

export interface InterpreterObject {
  [key: string]: InterpreterValue;
}

export interface InterpreterArray extends Array<InterpreterValue> {
  index?: number;
  groups?: InterpreterObject;
}

export const makeInterpreterObject = (): InterpreterObject => {
  // SAFETY: A new null-prototype object is empty; only InterpreterValue writes populate it.
  return Object.create(null) as InterpreterObject;
};

/** Closed value domain owned by the confined JavaScript interpreter. */
export type InterpreterValue =
  | InterpreterPrimitive
  | InterpreterObject
  | InterpreterArray
  | CodeModeFunction
  | IntrinsicReference
  | ComputedValue
  | PromiseNamespace
  | PromiseMethodReference
  | GlobalNamespace
  | GlobalMethodReference
  | CoercionFunction
  | UriFunction
  | ProgramThrow
  | ErrorConstructorReference
  | ToolReference
  | SandboxValue
  | typeof OptionalShortCircuit;

export type DiagnosticKind =
  | "ParseError"
  | "UnsupportedSyntax"
  | "UnknownTool"
  | "InvalidToolInput"
  | "InvalidToolOutput"
  | "InvalidDataValue"
  | "ToolCallLimitExceeded"
  | "TimeoutExceeded"
  | "ToolFailure"
  | "ExecutionFailure";

export const OptionalShortCircuit: unique symbol = Symbol("codemode.optional-short-circuit");

export const supportedSyntaxMessage =
  "Supported orchestration syntax: tools.* calls (they return promises - resolve them with await), data literals, destructuring, optional chaining, template literals, conditionals, switch, loops (incl. for...of and for...in over object/array/tools keys), arrow functions, spread, try/catch, array methods (map/filter/find/findIndex/some/every/reduce/flatMap/forEach/sort/slice/concat/indexOf/lastIndexOf/at/flat/reverse/includes/join), string methods (incl. match/matchAll/replace/split with regular expressions), Date/RegExp/Map/Set/URL/URLSearchParams, URI encoding helpers, Object/Math/JSON helpers, captured console.log/warn/error/dir/table, and Promise.all/allSettled/race/resolve/reject over arrays mixing promises and plain values for parallel tool calls (promise chaining with .then/.catch is not supported - use await with try/catch).";

type InterpreterRuntimeErrorProps = {
  readonly message: string;
  readonly kind: DiagnosticKind;
  readonly node?: AstNode;
  readonly suggestions?: ReadonlyArray<string>;
};

type InterpreterRuntimeErrorInit = {
  message: string;
  kind: DiagnosticKind;
  node?: AstNode;
  suggestions?: ReadonlyArray<string>;
};

export class InterpreterRuntimeError extends Data.TaggedError(
  "InterpreterRuntimeError",
)<InterpreterRuntimeErrorProps> {
  errorName: string = "Error";

  constructor(
    message: string,
    node?: AstNode,
    kind: DiagnosticKind = "ExecutionFailure",
    suggestions?: ReadonlyArray<string>,
  ) {
    const props: InterpreterRuntimeErrorInit = {
      message,
      kind,
    };
    if (node !== undefined) props.node = node;
    if (suggestions !== undefined) props.suggestions = suggestions;
    super(props);
  }

  as(errorName: string): this {
    this.errorName = errorName;
    return this;
  }
}

export const unsupportedSyntax = (kind: string, node: AstNode): InterpreterRuntimeError =>
  new InterpreterRuntimeError(
    `Syntax '${kind}' is not supported in CodeMode. ${supportedSyntaxMessage}`,
    node,
    "UnsupportedSyntax",
    [supportedSyntaxMessage],
  );

export const isRecord = (value: AstPropertyValue): value is AstPropertyRecord =>
  hasObjectRuntimeType(value) && value !== null;

export const astProperty = (record: AstPropertyRecord, key: string): AstPropertyValue =>
  record[key];

export const asNode = (value: AstPropertyValue, context: string): AstNode => {
  if (!isRecord(value) || !Predicate.isString(astProperty(value, "type"))) {
    throw new InterpreterRuntimeError(`Invalid AST node while reading ${context}.`);
  }
  // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
  return value as AstNode;
};

export const getArray = (node: AstNode, key: string): Array<AstPropertyValue> => {
  const value = node[key];
  if (!Array.isArray(value))
    throw new InterpreterRuntimeError(`Expected '${key}' to be an array.`, node);
  return value;
};

export const getString = (node: AstNode, key: string): string => {
  const value = node[key];
  if (!Predicate.isString(value))
    throw new InterpreterRuntimeError(`Expected '${key}' to be a string.`, node);
  return value;
};

export const getBoolean = (node: AstNode, key: string): boolean => {
  const value = node[key];
  if (!Predicate.isBoolean(value))
    throw new InterpreterRuntimeError(`Expected '${key}' to be a boolean.`, node);
  return value;
};

export const getOptionalNode = (node: AstNode, key: string): AstNode | undefined => {
  const value = node[key];
  if (value === undefined || value === null) return undefined;
  return asNode(value, key);
};

export const getNode = (node: AstNode, key: string): AstNode => asNode(node[key], key);

export const sourceLocation = (node: AstNode): SourcePosition => ({
  line: Math.max(1, (node.loc?.start.line ?? 2) - 1),
  column: Math.max(1, (node.loc?.start.column ?? 4) - 3),
});

export const formatLocation = (node?: AstNode): string => {
  if (!node?.loc) return "";
  const location = sourceLocation(node);
  return ` (line ${location.line}, col ${location.column})`;
};
