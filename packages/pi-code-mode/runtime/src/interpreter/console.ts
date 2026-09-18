import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { consoleMethods, MAX_CONSOLE_DEPTH } from "../stdlib/console.js";
import { boundedData, coerceToString } from "../stdlib/value.js";
import { copyIn, copyOut, ToolReference } from "../tool-runtime.js";
import {
  isSandboxValue,
  SandboxDate,
  SandboxMap,
  SandboxPromise,
  SandboxRegExp,
  SandboxSet,
  SandboxURL,
  SandboxURLSearchParams,
} from "../values.js";
import { appendBoundedLog, MAX_LOG_ENTRY_LENGTH } from "./confinement.js";
import { publicErrorMessage } from "./diagnostics.js";
import {
  type AstNode,
  type InterpreterArray,
  type InterpreterObject,
  InterpreterRuntimeError,
  type InterpreterValue,
} from "./model.js";
import {
  containsOpaqueReference,
  containsRuntimeReference,
  isRuntimeReference,
} from "./references.js";
export interface ConsoleHost<_R> {
  enumerableKeys<ValueInput>(value: ValueInput): Array<string> | undefined;
  logs: Array<string>;
  formatConsoleMessage(name: string, args: InterpreterArray): string;
  formatConsoleArgument<ValueInput>(value: ValueInput): string;
  formatConsoleTable(value: InterpreterValue, columnsArgument: InterpreterValue): string;
  formatConsoleValue<ValueInput>(
    value: ValueInput,
    seen: Set<object>,
    depth: number,
    budget: { remaining: number },
  ): string;
  consoleBudget(): { remaining: number };
  consoleTableColumns(value: InterpreterValue): ReadonlyArray<string> | undefined;
  consoleTableRows(
    data: InterpreterValue,
    columns: ReadonlyArray<string> | undefined,
  ): Array<{ readonly index: string; readonly values: InterpreterObject }>;
  formatConsoleTableCell(value: InterpreterValue): string;
  consoleTableValues(
    value: InterpreterValue,
    columns: ReadonlyArray<string> | undefined,
  ): { [k: string]: InterpreterValue };
}
export function invokeObjectMethodOnTools<R>(
  this: ConsoleHost<R>,
  name: string,
  ref: ToolReference,
  node: AstNode,
) {
  if (name === "keys") {
    return boundedData(this.enumerableKeys(ref)!, "Object.keys result");
  }
  throw new InterpreterRuntimeError(
    `Object.${name}(...) cannot read tool references: they are not plain data. Use Object.keys(tools) for names, or tools.$codemode.search({ query }) for signatures.`,
    node,
    "InvalidDataValue",
  );
}
export function invokeConsole<R>(
  this: ConsoleHost<R>,
  name: string,
  args: InterpreterArray,
  node: AstNode,
): undefined {
  if (!consoleMethods.has(name))
    throw new InterpreterRuntimeError(`console.${name} is not available in CodeMode.`, node);
  // Confinement: entries are truncated and capped during the run, so console output can
  // never grow host memory unboundedly before the post-run output bound applies.
  appendBoundedLog(this.logs, publicErrorMessage(this.formatConsoleMessage(name, args)));
  return undefined;
}
export function formatConsoleMessage<R>(
  this: ConsoleHost<R>,
  name: string,
  args: InterpreterArray,
): string {
  if (name === "dir") return args.length === 0 ? "undefined" : this.formatConsoleArgument(args[0]);
  if (name === "table") return this.formatConsoleTable(args[0], args[1]);
  const prefix =
    name === "warn"
      ? "[warn] "
      : name === "error"
        ? "[error] "
        : name === "debug"
          ? "[debug] "
          : "";
  return `${prefix}${args.map((arg) => this.formatConsoleArgument(arg)).join(" ")}`;
}
export function formatConsoleArgument<R, ValueInput>(
  this: ConsoleHost<R>,
  value: ValueInput,
): string {
  if (value === undefined) return "undefined";
  // A top-level string prints bare; nested strings are JSON-quoted (see formatConsoleValue).
  if (Predicate.isString(value)) return value;
  return this.formatConsoleValue(value, new Set(), 0, this.consoleBudget());
}
export function consoleBudget<R>(this: ConsoleHost<R>) {
  return { remaining: MAX_LOG_ENTRY_LENGTH + 64 };
}
export function formatConsoleValue<R, ValueInput>(
  this: ConsoleHost<R>,
  value: ValueInput,
  seen: Set<object>,
  depth: number,
  budget: { remaining: number },
): string {
  if (budget.remaining <= 0) return "...";
  const spend = (text: string): string => {
    budget.remaining -= text.length;
    return text;
  };
  // Nested undefined renders as null, matching what JSON boundary output would show.
  if (value === null || value === undefined) return spend("null");
  if (Predicate.isString(value)) return spend(JSON.stringify(value));
  // String(value) keeps NaN/Infinity/-Infinity readable; finite numbers match their JSON form.
  if (Predicate.isNumber(value) || Predicate.isBoolean(value)) return spend(String(value));
  if (!hasObjectRuntimeType(value)) return spend(String(value));
  if (value instanceof SandboxPromise) return spend("[Promise (await it to get its value)]");
  if (value instanceof SandboxDate) return spend(coerceToString(value));
  if (value instanceof SandboxRegExp) return spend(coerceToString(value));
  if (value instanceof SandboxURL) return spend(coerceToString(value));
  if (value instanceof SandboxURLSearchParams) return spend(coerceToString(value));
  if (depth > MAX_CONSOLE_DEPTH) return spend("...");
  if (seen.has(value)) return spend("[Circular]");
  if (value instanceof SandboxMap) {
    seen.add(value);
    try {
      const entries = Array.from(
        value.map.entries(),
        ([key, item]): InterpreterArray => [key, item],
      );
      return `Map(${value.map.size}) ${this.formatConsoleValue(entries, seen, depth + 1, budget)}`;
    } finally {
      seen.delete(value);
    }
  }
  if (value instanceof SandboxSet) {
    seen.add(value);
    try {
      return `Set(${value.set.size}) ${this.formatConsoleValue(Array.from(value.set.values()), seen, depth + 1, budget)}`;
    } finally {
      seen.delete(value);
    }
  }
  if (isRuntimeReference(value)) return spend("[CodeMode reference]");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const parts: Array<string> = [];
      for (const item of value) {
        if (budget.remaining <= 0) {
          parts.push("...");
          break;
        }
        parts.push(this.formatConsoleValue(item, seen, depth + 1, budget));
        budget.remaining -= 1;
      }
      return `[${parts.join(",")}]`;
    }
    const parts: Array<string> = [];
    for (const [key, item] of Object.entries(value)) {
      if (budget.remaining <= 0) {
        parts.push("...");
        break;
      }
      parts.push(
        `${spend(JSON.stringify(key))}:${this.formatConsoleValue(item, seen, depth + 1, budget)}`,
      );
      budget.remaining -= 1;
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}
export function formatConsoleTable<R>(
  this: ConsoleHost<R>,
  value: InterpreterValue,
  columnsArgument: InterpreterValue,
): string {
  if (value === undefined) return "undefined";
  // Sandbox values are legitimate table data (cells render their friendly forms); only
  // truly opaque references (functions, tools, promises) collapse to the marker.
  if (containsOpaqueReference(value)) return "[CodeMode reference]";
  const data = boundedData(value, "console.table argument");
  const columns = this.consoleTableColumns(columnsArgument);
  const rows = this.consoleTableRows(data, columns);
  const keys = columns ?? Array.from(new Set(rows.flatMap((row) => Object.keys(row.values))));
  // Confinement: stop rendering once the entry budget is spent; appendBoundedLog
  // truncates the final entry either way.
  const lines: Array<string> = [["(index)", ...keys].join("\t")];
  let rendered = lines[0]!.length;
  for (const row of rows) {
    if (rendered > MAX_LOG_ENTRY_LENGTH) {
      lines.push(`[table truncated: showing ${lines.length - 1} of ${rows.length} rows]`);
      break;
    }
    const line = [
      row.index,
      ...keys.map((key) => this.formatConsoleTableCell(row.values[key])),
    ].join("\t");
    rendered += line.length + 1;
    lines.push(line);
  }
  return lines.join("\n");
}
export function consoleTableColumns<R>(
  this: ConsoleHost<R>,
  value: InterpreterValue,
): ReadonlyArray<string> | undefined {
  if (value === undefined) return undefined;
  if (containsRuntimeReference(value)) return undefined;
  const columns = copyOut(copyIn(value, "console.table columns"), true);
  return Array.isArray(columns) ? columns.map((column) => String(column)) : undefined;
}
export function consoleTableRows<R>(
  this: ConsoleHost<R>,
  data: InterpreterValue,
  columns: ReadonlyArray<string> | undefined,
): Array<{ readonly index: string; readonly values: InterpreterObject }> {
  if (Array.isArray(data)) {
    return data.map((item, index) => ({
      index: String(index),
      values: this.consoleTableValues(item, columns),
    }));
  }
  if (data !== null && hasObjectRuntimeType(data) && !isSandboxValue(data)) {
    return Object.entries(data).map(([index, item]) => ({
      index,
      values: this.consoleTableValues(item, columns),
    }));
  }
  return [{ index: "0", values: { Value: data } }];
}
export function consoleTableValues<R>(
  this: ConsoleHost<R>,
  value: InterpreterValue,
  columns: ReadonlyArray<string> | undefined,
) {
  if (
    value !== null &&
    hasObjectRuntimeType(value) &&
    !Array.isArray(value) &&
    !isSandboxValue(value)
  ) {
    // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
    const source = value as InterpreterObject;
    if (columns !== undefined)
      return Object.fromEntries(columns.map((column) => [column, source[column]]));
    return Object.fromEntries(Object.entries(source));
  }
  return { Value: value };
}
export function formatConsoleTableCell<R>(this: ConsoleHost<R>, value: InterpreterValue): string {
  if (value === undefined) return "";
  if (Predicate.isString(value)) return value;
  return this.formatConsoleValue(value, new Set(), 0, this.consoleBudget());
}
