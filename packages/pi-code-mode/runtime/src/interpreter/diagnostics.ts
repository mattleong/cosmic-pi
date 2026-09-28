import { parse } from "acorn";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  DiagnosticCategory,
  flattenDiagnosticMessageText,
  ModuleKind,
  ScriptTarget,
  transpileModule,
} from "typescript-compiler-api";
import type { Diagnostic } from "../codemode.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { errorConstructors } from "../stdlib/value.js";
import { ToolError } from "../tool-error.js";
import {
  formatLocation,
  InterpreterRuntimeError,
  type InterpreterValue,
  type ProgramNode,
  ProgramThrow,
  sourceLocation,
  type AstNode,
  getString,
  getNode,
  getBoolean,
  type SourcePosition,
} from "./model.js";
import { containsRuntimeReference } from "./references.js";
import { createErrorValue } from "../values.js";
import { makePositionMapper, remapLocations } from "./source-map.js";
import { copyOut } from "../tool-runtime-data.js";
import { ToolRuntimeError } from "../tool-runtime-error.js";

/**
 * A wrapper offset as a program position. The wrapper adds one header line, so its line index is
 * the program's line number; positions in the wrapper's own lines clamp to the program.
 */
const programPosition = (wrapped: string, offset: number, code: string) => {
  const before = wrapped.slice(0, offset).split("\n");
  const lines = Math.max(1, code.split("\n").length);
  const line = before.length - 1;
  return line < 1
    ? { line: 1, column: 1 }
    : line > lines
      ? { line: lines, column: 1 }
      : { line, column: before.at(-1)!.length + 1 };
};

/**
 * Parses a program. It is wrapped in an async function and transpiled so TypeScript syntax is
 * erased, then the function body is parsed by Acorn. The transpiler reprints the code, so every
 * node location is mapped back through the transpiler's source map to the model's own lines
 * and columns.
 */
export const parseProgram = (code: string): ProgramNode => {
  const wrapped = `async function __codemode__() {\n${code}\n}`;
  const transpiled = transpileModule(wrapped, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ScriptTarget.ESNext,
      module: ModuleKind.ESNext,
      sourceMap: true,
    },
  });
  const diagnostic = transpiled.diagnostics?.find(
    (item) => item.category === DiagnosticCategory.Error,
  );

  if (diagnostic) {
    const reason = flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    throw new InterpreterRuntimeError(
      `Failed to parse TypeScript: ${reason}`,
      undefined,
      "ParseError",
      undefined,
      diagnostic.start === undefined ? undefined : programPosition(wrapped, diagnostic.start, code),
    ).withFacts({ reason });
  }

  const output = transpiled.outputText;
  const bodyStart = output.indexOf("{") + 1;
  const bodyEnd = output.lastIndexOf("}");
  const lineStart = output.lastIndexOf("\n", bodyStart - 1) + 1;
  const toProgram = makePositionMapper(
    transpiled.sourceMapText ?? "{}",
    output.slice(0, bodyStart).split("\n").length - 1,
    bodyStart - lineStart,
    code.split("\n"),
  );
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(output.slice(bodyStart, bodyEnd), {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      locations: true,
    });
  } catch (error) {
    throw syntaxFailure(error, toProgram);
  }

  if (parsed.type !== "Program" || !Array.isArray(parsed.body)) {
    throw new InterpreterRuntimeError("Failed to parse script as a Program node.");
  }

  // SAFETY: Acorn owns this Program AST and locations were requested for every emitted node.
  const program = parsed as typeof parsed & ProgramNode;
  remapLocations(program, toProgram);
  return program;
};

const AcornPosition = Schema.Struct({ line: Schema.Number, column: Schema.Number });
const acornPosition = Schema.decodeUnknownOption(AcornPosition);

/** An Acorn syntax error, reported at the program position it maps to. */
const syntaxFailure = <ErrorInput>(
  error: ErrorInput,
  toProgram: (position: SourcePosition) => SourcePosition,
): InterpreterRuntimeError => {
  if (!(error instanceof SyntaxError)) return new InterpreterRuntimeError(String(error));
  const reason = error.message.replace(/\s*\(\d+:\d+\)$/u, "");
  const position = Option.getOrUndefined(
    acornPosition(Object.getOwnPropertyDescriptor(error, "loc")?.value),
  );
  const location = position === undefined ? undefined : toProgram(position);
  return new InterpreterRuntimeError(
    `Failed to parse JavaScript: ${reason}`,
    undefined,
    "ParseError",
    undefined,
    location === undefined ? undefined : { line: location.line, column: location.column + 1 },
  ).withFacts({ reason });
};

/**
 * Redacts filesystem paths from messages of unknown host errors, the one place a host-internal
 * path could surface. Tool refusals and guest data are shown as written: a ToolError message is
 * safe by contract, and guest values came from tools the program already called.
 */
export const publicErrorMessage = (message: string): string =>
  message.replace(/\/(?:Users|home|private|tmp|var\/folders)\/[^\s"'`]+/g, "<redacted-path>");

// Tool failures are values raised inside the tool runtime; the interpreter records where the
// program made the call so the diagnostic can point there.
const errorSites = new WeakMap<object, AstNode>();

export const attachErrorSite = <ErrorInput>(error: ErrorInput, node: AstNode): void => {
  if ((error instanceof ToolRuntimeError || error instanceof ToolError) && !errorSites.has(error))
    errorSites.set(error, node);
};

const siteOf = (error: ToolRuntimeError | ToolError) => {
  const site = errorSites.get(error);
  return site?.loc === undefined
    ? { suffix: "", location: {} }
    : { suffix: formatLocation(site), location: { location: sourceLocation(site) } };
};

export const normalizeError = <ErrorInput>(error: ErrorInput): Diagnostic => {
  if (error instanceof InterpreterRuntimeError) {
    const location = error.node?.loc !== undefined ? sourceLocation(error.node) : error.location;
    const base = {
      kind: error.kind,
      message: `${error.message}${location === undefined ? "" : ` (line ${location.line}, col ${location.column})`}`,
    };
    const withLocation = location !== undefined ? { ...base, location } : base;
    return {
      ...withLocation,
      ...(error.suggestions !== undefined && { suggestions: error.suggestions }),
      ...(error.facts !== undefined && { facts: error.facts }),
    };
  }

  if (error instanceof ToolRuntimeError) {
    const site = siteOf(error);
    return {
      kind: error.kind,
      message: `${error.message}${site.suffix}`,
      ...site.location,
      ...(error.suggestions.length > 0 && { suggestions: error.suggestions }),
      ...(error.facts !== undefined && { facts: error.facts }),
    };
  }

  if (error instanceof ToolError) {
    const site = siteOf(error);
    return {
      kind: "ToolFailure",
      message: `${error.message}${site.suffix}`,
      ...site.location,
      ...(error.tool !== undefined && { facts: { tool: error.tool } }),
    };
  }

  if (error instanceof ProgramThrow) {
    const value = error.value;
    let message: string;
    try {
      if (containsRuntimeReference(value)) {
        // A thrown tool/function reference must not leak its internal structure.
        message = "a non-data value";
      } else if (Predicate.isString(value)) {
        message = value;
      } else if (value !== null && hasObjectRuntimeType(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, "message");
        message =
          descriptor && "value" in descriptor && Predicate.isString(descriptor.value)
            ? descriptor.value
            : (JSON.stringify(copyOut(value)) ?? "a non-data value");
      } else {
        message = JSON.stringify(copyOut(value)) ?? String(value);
      }
    } catch {
      // Normalization runs inside the Effect failure handler. Projection refusal must
      // remain a failed Result, without retrying coercion or inspecting rejected data.
      message = "a value that could not be safely projected";
    }
    return { kind: "ExecutionFailure", message: `Uncaught: ${message}` };
  }

  if (error instanceof RangeError && /call stack|recursion/i.test(error.message)) {
    return {
      kind: "ExecutionFailure",
      message: "Execution exceeded the maximum nesting depth.",
    };
  }

  if (error instanceof Error) {
    return {
      kind: error.name === "SyntaxError" ? "ParseError" : "ExecutionFailure",
      message: publicErrorMessage(error.message),
    };
  }

  // A non-Error thrown by a host tool (raw string / number / Symbol) still routes through
  // path redaction so filesystem paths can never leak through the catch-all branch.
  return {
    kind: "ExecutionFailure",
    message: publicErrorMessage(String(error)),
  };
};

// Shared by catch bindings, Promise.allSettled rejection reasons, and Promise.race losers.
export const caughtErrorValue = <Thrown>(thrown: Thrown): InterpreterValue => {
  if (thrown instanceof ProgramThrow) return thrown.value;
  if (thrown instanceof InterpreterRuntimeError)
    return createErrorValue(thrown.errorName, thrown.message);
  // The program sees the refusal itself; the call-site location is for the final diagnostic.
  if (thrown instanceof ToolRuntimeError || thrown instanceof ToolError)
    return createErrorValue("Error", thrown.message);
  const name =
    thrown instanceof Error && errorConstructors.has(thrown.name) ? thrown.name : "Error";
  return createErrorValue(name, normalizeError(thrown).message);
};

/** Source-like text for a callee expression, for "x.y is not a function" diagnostics. */
export const calleeText = (node: AstNode, depth = 0): string => {
  if (depth > 4) return "…";
  switch (node.type) {
    case "Identifier":
      return getString(node, "name");
    case "ThisExpression":
      return "this";
    case "MemberExpression": {
      const object = calleeText(getNode(node, "object"), depth + 1);
      const property = getNode(node, "property");
      if (!getBoolean(node, "computed") && property.type === "Identifier")
        return `${object}${node.optional === true ? "?." : "."}${getString(property, "name")}`;
      return property.type === "Literal" && Predicate.isString(property.value)
        ? `${object}[${JSON.stringify(property.value)}]`
        : `${object}[…]`;
    }
    case "CallExpression":
      return `${calleeText(getNode(node, "callee"), depth + 1)}(…)`;
    default:
      return "The called value";
  }
};
