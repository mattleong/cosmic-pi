/** Pure, presentation-only projection of successful structured Code Mode output. */
import { isObject } from "effect/Predicate";
import { CODE_MODE_INTEGER_BOUNDS } from "../config/schema.ts";
import { truncateDisplay } from "../tools/format.ts";
import { stripTerminalControls } from "pi-cosmic-core";

const LOGS_SEPARATOR = "\n\nLogs:\n";
const MAX_OUTPUT_DISPLAY_LENGTH = CODE_MODE_INTEGER_BOUNDS.maxOutputBytes.maximum;

/** Safe plain fallback used for text results, malformed/truncated JSON, and hostile details. */
export const codeModeOutputText = (text: string): string =>
  truncateDisplay(stripTerminalControls(text), MAX_OUTPUT_DISPLAY_LENGTH);

const splitStructuredOutput = (
  text: string,
): { readonly json: string; readonly parsed: unknown; readonly logs?: string } | undefined => {
  if (text.length > MAX_OUTPUT_DISPLAY_LENGTH) return undefined;
  try {
    return { json: text, parsed: JSON.parse(text) };
  } catch {
    const separator = text.indexOf(LOGS_SEPARATOR);
    if (separator < 0) return undefined;
    const json = text.slice(0, separator);
    try {
      return {
        json,
        parsed: JSON.parse(json),
        logs: text.slice(separator + LOGS_SEPARATOR.length),
      };
    } catch {
      return undefined;
    }
  }
};

const MAX_PRETTY_INPUT_BYTES = 64 * 1024;
const MAX_PRETTY_OUTPUT_BYTES = 128 * 1024;
const MAX_PRETTY_DEPTH = 20;
const MAX_PRETTY_NODES = 2000;

/**
 * Pretty-print canonical JSON only. The caller must gate successful, nontruncated structured
 * results so JSON-looking string returns remain plain text. No model-visible text is changed.
 */
export function formatStructuredCodeModeOutput(text: string): string | undefined {
  if (text.length > MAX_PRETTY_INPUT_BYTES) return undefined;
  const inputBytes = new TextEncoder().encode(text).length;
  if (inputBytes > MAX_PRETTY_INPUT_BYTES) return undefined;
  const split = splitStructuredOutput(text);
  if (split === undefined) return undefined;

  // Bound traversal and a conservative whitespace expansion before either serialization.
  // JSON.parse produces only data properties, so this walk cannot invoke user callbacks.
  const pending = [{ value: split.parsed, depth: 0 }];
  let nodes = 0;
  let expandedBytes = inputBytes;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_PRETTY_NODES || depth > MAX_PRETTY_DEPTH) return undefined;
    expandedBytes += 4 * depth + 8;
    if (expandedBytes > MAX_PRETTY_OUTPUT_BYTES) return undefined;
    if (Array.isArray(value) || isObject(value)) {
      const children = Object.values(value);
      if (nodes + pending.length + children.length > MAX_PRETTY_NODES) return undefined;
      for (const child of children) pending.push({ value: child, depth: depth + 1 });
    }
  }
  const compact = JSON.stringify(split.parsed);
  const pretty = JSON.stringify(split.parsed, null, 2);
  // Reject duplicate keys, lossy number spellings, reordered integer keys, and other
  // noncanonical input rather than hiding lexical information from the plain fallback.
  if (split.json !== compact && split.json !== pretty) return undefined;
  const output = split.logs === undefined ? pretty : `${pretty}${LOGS_SEPARATOR}${split.logs}`;
  if (new TextEncoder().encode(output).length > MAX_PRETTY_OUTPUT_BYTES) return undefined;
  return codeModeOutputText(output);
}
