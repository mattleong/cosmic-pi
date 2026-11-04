import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import { escapeControlChars } from "../shared/terminal-text";

const SCRIPT_ERROR = "Script error:\n";
const TEXT_MARKER = /^==> text (\d+)\/(\d+) <==$/u;
const CONSOLE_OPEN = "<console_output>";
const CONSOLE_CLOSE = "</console_output>";
// Larger values stay as written: restructuring them would cost more than it helps.
const STRUCTURED_LIMIT = 64 * 1024;
const MAX_DEPTH = 12;

const decodeJson = decodeUnknownOrUndefined(Schema.fromJsonString(Schema.Json));

export interface ScriptOutputParts {
  readonly output: string;
  readonly scriptError?: string;
}

/** Guest output and Pi's `Script error:` trailer, which Pi appends after all script output. */
export function splitScriptError(text: string): ScriptOutputParts {
  const lineStart = Fn.pipe(text, Str.lastIndexOf(`\n${SCRIPT_ERROR}`));
  if (Option.isSome(lineStart))
    return {
      output: Fn.pipe(text, Str.slice(0, lineStart.value)),
      scriptError: Fn.pipe(text, Str.slice(lineStart.value + 1 + SCRIPT_ERROR.length)),
    };
  if (Fn.pipe(text, Str.startsWith(SCRIPT_ERROR)))
    return { output: "", scriptError: Fn.pipe(text, Str.slice(SCRIPT_ERROR.length)) };
  return { output: text };
}

const ERROR_PREFIX = /^[A-Za-z]*Error: /u;

/**
 * The script error without its first line when that line only restates a failed call's error,
 * which the call already shows. Stack frames and Pi's call summary remain.
 */
export function withoutRestatedError(scriptError: string, callErrors: readonly string[]): string {
  const [first, ...rest] = Str.split(scriptError, "\n");
  const restated = Str.trim(Fn.pipe(first, Str.replace(ERROR_PREFIX, "")));
  return Arr.some(callErrors, (error) => Str.trim(Str.split(error, "\n")[0] ?? "") === restated)
    ? Arr.join(rest, "\n")
    : scriptError;
}

// Pi's closing summary of the calls made, which a complete Calls section already lists.
const CALL_SUMMARY =
  /^(?:Tool calls made before the failure \(they are not undone\): .*|No tool calls were made\.?)$/u;

export function withoutCallSummary(scriptError: string): string {
  return Arr.join(
    Arr.filter(Str.split(scriptError, "\n"), (line) => !CALL_SUMMARY.test(Str.trim(line))),
    "\n",
  );
}

type Json = Schema.Json;

const isJsonArray = (value: Json): value is Schema.JsonArray => Arr.isArray(value);
const isJsonObject = (value: Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Arr.isArray(value);

const SCALAR_LOOKING = /^(?:true|false|null|-?\d[\d.eE+-]*)$/u;

/** One-line text for a scalar or empty container; multiline strings and containers get blocks. */
function scalarText(value: Json): string | undefined {
  if (Predicate.isString(value)) {
    if (Fn.pipe(value, Str.includes("\n"))) return undefined;
    const ambiguous = value === "" || value !== Str.trim(value) || SCALAR_LOOKING.test(value);
    return ambiguous ? JSON.stringify(value) : escapeControlChars(value);
  }
  if (value === null || Predicate.isNumber(value) || Predicate.isBoolean(value))
    return String(value);
  if (isJsonArray(value) && value.length === 0) return "[]";
  if (isJsonObject(value) && Rec.isEmptyRecord(value)) return "{}";
  return undefined;
}

const multilineString = (value: Json): readonly string[] | undefined =>
  Predicate.isString(value) && Fn.pipe(value, Str.includes("\n"))
    ? Arr.map(Str.split(Fn.pipe(value, Str.replace(/\r?\n$/u, "")), "\n"), escapeControlChars)
    : undefined;

const indent = (lines: readonly string[]): string[] => Arr.map(lines, (line) => `  ${line}`);

/** Readable YAML-like lines for a JSON value; every key and value stays visible. */
function jsonLines(value: Json, theme: Theme, depth: number): string[] {
  const scalar = scalarText(value);
  if (scalar !== undefined) return [theme.fg("toolOutput", scalar)];
  const text = multilineString(value);
  if (text) return Arr.map(text, (line) => theme.fg("toolOutput", line));
  if (depth >= MAX_DEPTH)
    return [theme.fg("toolOutput", escapeControlChars(JSON.stringify(value)))];
  if (isJsonArray(value))
    return Arr.flatMap(value, (item) => {
      const [first = "", ...rest] = jsonLines(item, theme, depth + 1);
      return [`${theme.fg("muted", "- ")}${first}`, ...indent(rest)];
    });
  if (!isJsonObject(value)) return [];
  return Arr.flatMap(Rec.toEntries(value), ([key, item]) => {
    const label = theme.fg("muted", `${escapeControlChars(key)}:`);
    const inline = scalarText(item);
    if (inline !== undefined) return [`${label} ${theme.fg("toolOutput", inline)}`];
    return [label, ...indent(jsonLines(item, theme, depth + 1))];
  });
}

function structured(body: string): Json | undefined {
  const text = Str.trim(body);
  if (text.length > STRUCTURED_LIMIT || !/^[[{]/u.test(text)) return undefined;
  const value = decodeJson(text);
  return value !== undefined && (isJsonArray(value) || isJsonObject(value)) ? value : undefined;
}

function blockLines(lines: readonly string[], theme: Theme): string[] {
  const value = structured(Arr.join(lines, "\n"));
  if (value !== undefined) return jsonLines(value, theme, 0);
  return Arr.map(lines, (line) => theme.fg("toolOutput", escapeControlChars(line)));
}

/**
 * Script output with Pi's `==> text N/M <==` and console markers as muted labels, and each text
 * item that is a JSON object or array laid out readably instead of as one escaped line.
 */
export function renderScriptOutput(text: string, theme: Theme): string {
  const rows: string[] = [];
  let block: string[] = [];
  const flush = () => {
    if (block.length) rows.push(...blockLines(block, theme));
    block = [];
  };
  for (const line of Str.split(text, "\n")) {
    const marker = TEXT_MARKER.exec(line);
    if (marker || line === CONSOLE_OPEN || line === CONSOLE_CLOSE) {
      flush();
      if (line !== CONSOLE_CLOSE)
        rows.push(
          theme.fg("muted", marker ? `text ${marker[1] ?? ""}/${marker[2] ?? ""}` : "console"),
        );
      continue;
    }
    block.push(line);
  }
  flush();
  return Arr.join(rows, "\n");
}
