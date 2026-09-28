import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { consoleMethods, MAX_CONSOLE_DEPTH } from "../stdlib/console.js";
import { boundedData } from "../stdlib/value.js";
import { coerceToString } from "./conversions.js";
import {
  isSandboxValue,
  SandboxBytes,
  SandboxDate,
  SandboxMap,
  SandboxPromise,
  SandboxRegExp,
  SandboxSet,
  SandboxURL,
  SandboxURLSearchParams,
} from "../values.js";
import { appendBoundedLog, MAX_LOG_ENTRY_LENGTH } from "./confinement.js";
import {
  type AstNode,
  type InterpreterArray,
  type InterpreterObject,
  InterpreterRuntimeError,
  type InterpreterValue,
  ToolReference,
} from "./model.js";
import {
  containsOpaqueReference,
  containsRuntimeReference,
  isRuntimeReference,
} from "./references.js";
import { enumerableKeys } from "./statements.js";
import { type Activation } from "./activation.js";
import { exportData } from "../tool-runtime-data.js";
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
  act: Activation<R>,
  name: string,
  ref: ToolReference,
  node: AstNode,
) {
  if (name === "keys") {
    return boundedData(enumerableKeys(act, ref)!, "Object.keys result");
  }
  throw new InterpreterRuntimeError(
    `Object.${name}(...) cannot read tool references: they are not plain data. Use Object.keys(tools) for names, or tools.$codemode.search({ query }) for signatures.`,
    node,
    "InvalidDataValue",
  );
}
export function invokeConsole<R>(
  act: Activation<R>,
  name: string,
  args: InterpreterArray,
  node: AstNode,
): undefined {
  if (!consoleMethods.has(name))
    throw new InterpreterRuntimeError(`console.${name} is not available in CodeMode.`, node);
  // Confinement: entries are truncated and capped during the run, so console output can
  // never grow host memory unboundedly before the post-run output bound applies.
  appendBoundedLog(act.execution.logs, formatConsoleMessage(name, args));
  return undefined;
}
export function formatConsoleMessage(name: string, args: InterpreterArray): string {
  if (name === "dir") return args.length === 0 ? "undefined" : formatConsoleArgument(args[0]);
  if (name === "table") return formatConsoleTable(args[0], args[1]);
  const prefix =
    name === "warn"
      ? "[warn] "
      : name === "error"
        ? "[error] "
        : name === "debug"
          ? "[debug] "
          : "";
  return `${prefix}${args.map((arg) => formatConsoleArgument(arg)).join(" ")}`;
}
export function formatConsoleArgument<ValueInput>(value: ValueInput): string {
  if (value === undefined) return "undefined";
  // A top-level string prints bare; nested strings are JSON-quoted (see formatConsoleValue).
  if (Predicate.isString(value)) return value;
  return formatConsoleValue(value, new Set(), 0, consoleBudget());
}
export function consoleBudget() {
  return { remaining: MAX_LOG_ENTRY_LENGTH + 64 };
}
export function formatConsoleValue<ValueInput>(
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
  if (value instanceof SandboxBytes) {
    let text = spend(`Uint8Array(${value.length}) [`);
    for (let index = 0; index < value.length; index++) {
      if (budget.remaining < 8) {
        text += spend("...");
        break;
      }
      text += spend(`${index ? "," : ""}${value.storage()[index]}`);
    }
    return text + spend("]");
  }
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
      return `Map(${value.map.size}) ${formatConsoleValue(entries, seen, depth + 1, budget)}`;
    } finally {
      seen.delete(value);
    }
  }
  if (value instanceof SandboxSet) {
    seen.add(value);
    try {
      return `Set(${value.set.size}) ${formatConsoleValue(Array.from(value.set.values()), seen, depth + 1, budget)}`;
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
        parts.push(formatConsoleValue(item, seen, depth + 1, budget));
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
        `${spend(JSON.stringify(key))}:${formatConsoleValue(item, seen, depth + 1, budget)}`,
      );
      budget.remaining -= 1;
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}
export function formatConsoleTable(
  value: InterpreterValue,
  columnsArgument: InterpreterValue,
): string {
  if (value === undefined) return "undefined";
  // Sandbox values are legitimate table data (cells render their friendly forms); only
  // truly opaque references (functions, tools, promises) collapse to the marker.
  if (containsOpaqueReference(value)) return "[CodeMode reference]";
  const data = boundedData(value, "console.table argument");
  const columns = consoleTableColumns(columnsArgument);
  const rows = consoleTableRows(data, columns);
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
    const line = [row.index, ...keys.map((key) => formatConsoleTableCell(row.values[key]))].join(
      "\t",
    );
    rendered += line.length + 1;
    lines.push(line);
  }
  return lines.join("\n");
}
export function consoleTableColumns(value: InterpreterValue): ReadonlyArray<string> | undefined {
  if (value === undefined) return undefined;
  if (containsRuntimeReference(value)) return undefined;
  const columns = exportData(value, "console.table columns");
  return Array.isArray(columns) ? columns.map((column) => String(column)) : undefined;
}
export function consoleTableRows(
  data: InterpreterValue,
  columns: ReadonlyArray<string> | undefined,
): Array<{ readonly index: string; readonly values: InterpreterObject }> {
  if (Array.isArray(data)) {
    return data.map((item, index) => ({
      index: String(index),
      values: consoleTableValues(item, columns),
    }));
  }
  if (data !== null && hasObjectRuntimeType(data) && !isSandboxValue(data)) {
    return Object.entries(data).map(([index, item]) => ({
      index,
      values: consoleTableValues(item, columns),
    }));
  }
  return [{ index: "0", values: { Value: data } }];
}
export function consoleTableValues(
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
export function formatConsoleTableCell(value: InterpreterValue): string {
  if (value === undefined) return "";
  if (Predicate.isString(value)) return value;
  return formatConsoleValue(value, new Set(), 0, consoleBudget());
}
