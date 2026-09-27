import { parse } from "acorn";
import * as Predicate from "effect/Predicate";
import {
  DiagnosticCategory,
  flattenDiagnosticMessageText,
  ModuleKind,
  ScriptTarget,
  transpileModule,
} from "typescript-compiler-api";
import type { Diagnostic } from "../codemode.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { createErrorValue, errorConstructors } from "../stdlib/value.js";
import { ToolError } from "../tool-error.js";
import { copyOut, ToolRuntimeError } from "../tool-runtime.js";
import {
  formatLocation,
  InterpreterRuntimeError,
  type InterpreterValue,
  type ProgramNode,
  ProgramThrow,
  sourceLocation,
} from "./model.js";
import { containsRuntimeReference } from "./references.js";

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

export const parseProgram = (code: string): ProgramNode => {
  const wrapped = `async function __codemode__() {\n${code}\n}`;
  const transpiled = transpileModule(wrapped, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ScriptTarget.ESNext,
      module: ModuleKind.ESNext,
    },
  });
  const diagnostic = transpiled.diagnostics?.find(
    (item) => item.category === DiagnosticCategory.Error,
  );

  if (diagnostic) {
    throw new InterpreterRuntimeError(
      `Failed to parse TypeScript: ${flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
      undefined,
      "ParseError",
      undefined,
      diagnostic.start === undefined ? undefined : programPosition(wrapped, diagnostic.start, code),
    );
  }

  const bodyStart = transpiled.outputText.indexOf("{") + 1;
  const bodyEnd = transpiled.outputText.lastIndexOf("}");
  const executableCode = transpiled.outputText.slice(bodyStart, bodyEnd);
  const parsed = parse(executableCode, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    locations: true,
  });

  if (parsed.type !== "Program" || !Array.isArray(parsed.body)) {
    throw new InterpreterRuntimeError("Failed to parse script as a Program node.");
  }

  // SAFETY: Acorn owns this Program AST and locations were requested for every emitted node.
  return parsed as typeof parsed & ProgramNode;
};

export const publicErrorMessage = (message: string): string =>
  message.replace(/\/(?:Users|home|private|tmp|var\/folders)\/[^\s"'`]+/g, "<redacted-path>");

export const normalizeError = <ErrorInput>(error: ErrorInput): Diagnostic => {
  if (error instanceof InterpreterRuntimeError) {
    const base = {
      kind: error.kind,
      message: `${error.message}${formatLocation(error.node)}`,
    };
    const location = error.node?.loc !== undefined ? sourceLocation(error.node) : error.location;
    const withLocation = location !== undefined ? { ...base, location } : base;
    return error.suggestions !== undefined
      ? { ...withLocation, suggestions: error.suggestions }
      : withLocation;
  }

  if (error instanceof ToolRuntimeError) {
    const base = { kind: error.kind, message: error.message };
    return error.suggestions.length > 0 ? { ...base, suggestions: error.suggestions } : base;
  }

  if (error instanceof ToolError) {
    return { kind: "ToolFailure", message: publicErrorMessage(error.message) };
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
  const name =
    thrown instanceof Error && errorConstructors.has(thrown.name) ? thrown.name : "Error";
  return createErrorValue(name, normalizeError(thrown).message);
};
