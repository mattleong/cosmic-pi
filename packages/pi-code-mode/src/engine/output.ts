/** Bounds a program's model-facing output to `maxOutputBytes` without failing the program. */
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import type { CodeModeCompletedCall, CodeModeResult } from "./diagnostic.ts";

const encoder = new TextEncoder();

export const utf8ByteLength = (value: string): number => encoder.encode(value).byteLength;

/** Cuts before a partial UTF-8 sequence without discarding genuine replacement characters. */
export const utf8Truncate = (value: string, maxBytes: number): string => {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = Math.max(0, Math.floor(maxBytes));
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder("utf-8").decode(bytes.subarray(0, end));
};

/** The model-facing marker for a value cut to `maxBytes` of its `bytes`. */
export const truncatedValue = (rendered: string, bytes: number, maxBytes: number): string => {
  const marker = ` [result truncated: ${bytes} bytes exceeds the ${maxBytes}-byte output limit; return a smaller value]`;
  const markerBytes = utf8ByteLength(marker);
  return markerBytes >= maxBytes
    ? utf8Truncate(rendered, maxBytes)
    : `${utf8Truncate(rendered, maxBytes - markerBytes)}${marker}`;
};

/** The heading line for one completed call in a failed program's output. */
export const completedCallHeading = (call: CodeModeCompletedCall) => `--- ${call.tool}`;

const keepLines = (
  lines: ReadonlyArray<string>,
  budget: number,
  marker: (kept: number) => string,
) => {
  const kept: Array<string> = [];
  let used = 0;
  for (const line of lines) {
    const lineBytes = utf8ByteLength(line) + 1;
    if (used + lineBytes > budget) break;
    used += lineBytes;
    kept.push(line);
  }
  if (kept.length === lines.length) return { kept, used, cut: false };
  // The marker is budgeted like any other line: drop kept lines until it fits.
  for (;;) {
    const text = marker(kept.length);
    const markerBytes = utf8ByteLength(text) + 1;
    if (used + markerBytes <= budget) {
      kept.push(text);
      break;
    }
    const dropped = kept.pop();
    if (dropped === undefined) break;
    used -= utf8ByteLength(dropped) + 1;
  }
  return { kept, used, cut: true };
};

/**
 * Bounds the value or diagnostic, then logs, then completed-call output, in that priority, so
 * every kept part plus its markers fits `maxOutputBytes`. Oversized values become truncated
 * text with a marker; logs and completed calls keep a prefix and say how much was dropped.
 */
export const boundOutput = (result: CodeModeResult, maxOutputBytes: number): CodeModeResult => {
  let truncated = result.truncated === true;
  let used = 0;
  let value: Schema.Json = null;
  let error = result.ok ? undefined : result.error;
  if (result.ok) {
    const rendered = Predicate.isString(result.value)
      ? result.value
      : (JSON.stringify(result.value) ?? "null");
    const bytes = utf8ByteLength(rendered);
    if (bytes > maxOutputBytes) {
      truncated = true;
      value = truncatedValue(rendered, bytes, maxOutputBytes);
      used = utf8ByteLength(value);
    } else {
      value = result.value;
      used = bytes;
    }
  } else if (error !== undefined) {
    if (utf8ByteLength(error.message) > maxOutputBytes) {
      truncated = true;
      error = { ...error, message: utf8Truncate(error.message, maxOutputBytes) };
    }
    used = utf8ByteLength(error.message);
    if (error.suggestions !== undefined) {
      const suggestions: Array<string> = [];
      for (const suggestion of error.suggestions) {
        const bytes = utf8ByteLength(suggestion) + 1;
        if (used + bytes > maxOutputBytes) break;
        used += bytes;
        suggestions.push(suggestion);
      }
      if (suggestions.length < error.suggestions.length) {
        truncated = true;
        const { suggestions: _dropped, ...rest } = error;
        error = suggestions.length > 0 ? { ...rest, suggestions } : rest;
      }
    }
  }

  const logs = result.logs ?? [];
  const boundedLogs = keepLines(
    logs,
    Math.max(0, maxOutputBytes - used),
    (kept) => `[logs truncated: showing ${kept} of ${logs.length} lines]`,
  );
  used += boundedLogs.used;
  truncated ||= boundedLogs.cut;
  const logsPart = boundedLogs.kept.length > 0 ? { logs: boundedLogs.kept } : {};

  if (result.ok) {
    return truncated ? { ok: true, value, ...logsPart, truncated: true } : result;
  }

  const completed = result.completed ?? [];
  const keptCalls: Array<CodeModeCompletedCall> = [];
  let budget = Math.max(0, maxOutputBytes - used);
  for (const call of completed) {
    const heading = utf8ByteLength(completedCallHeading(call)) + 2;
    const body = utf8ByteLength(call.text) + 1;
    if (heading + body <= budget) {
      keptCalls.push(call);
      budget -= heading + body;
      continue;
    }
    truncated = true;
    // A cut call keeps its heading and a prefix of its output when anything useful fits.
    if (heading + 64 <= budget) {
      keptCalls.push({ tool: call.tool, text: utf8Truncate(call.text, budget - heading - 1) });
    }
    break;
  }
  return {
    ok: false,
    error: error!,
    ...logsPart,
    ...(keptCalls.length > 0 && { completed: keptCalls }),
    ...(truncated && { truncated: true }),
  };
};
