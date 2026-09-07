/** Pure, presentation-only projection of successful structured Code Mode output. */
import * as Schema from "effect/Schema";
import { CODE_MODE_INTEGER_BOUNDS } from "../config/schema.ts";
import { decodeOption, truncateDisplay } from "../tools/format.ts";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core";

/** Avoid materializing hostile persisted objects with an unreasonable number of UI sections. */
export const MAX_STRUCTURED_OUTPUT_FIELDS = 64;

const LOGS_SEPARATOR = "\n\nLogs:\n";
const MAX_OUTPUT_DISPLAY_LENGTH = CODE_MODE_INTEGER_BOUNDS.maxOutputBytes.maximum;
const MAX_OUTPUT_FIELD_LABEL_LENGTH = 160;

export interface CodeModeOutputField {
  readonly label: string;
  readonly body: string;
}

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

/**
 * Project a canonical small top-level JSON object containing only string fields, with at least
 * one multiline value, into labeled TUI sections.
 * The caller gates this with extension-owned `outputKind: "structured"` metadata, so a string
 * that merely contains valid JSON is never reformatted. Any ambiguity or bound overrun returns
 * undefined and leaves the complete sanitized model-visible text on the plain rendering path.
 */
export function projectStructuredCodeModeOutput(
  text: string,
): ReadonlyArray<CodeModeOutputField> | undefined {
  const split = splitStructuredOutput(text);
  if (split === undefined) return undefined;
  const record = decodeOption(Schema.Record(Schema.String, Schema.String), split.parsed);
  if (record === undefined) return undefined;
  const entries = Object.entries(record);
  if (
    entries.length === 0 ||
    entries.length > MAX_STRUCTURED_OUTPUT_FIELDS ||
    !entries.some(([, field]) => field.includes("\n"))
  )
    return undefined;
  // Extension-produced structured output is exactly one of these two serializations. Reject
  // noncanonical persisted/middleware text (including duplicate keys) rather than silently
  // changing or omitting its lexical content in the section view.
  const compact = JSON.stringify(record);
  if (split.json !== compact && split.json !== JSON.stringify(record, null, 2)) return undefined;

  const fields: CodeModeOutputField[] = [];
  const labels = new Set<string>();
  for (const [key, field] of entries) {
    const sanitized = sanitizeTerminalLine(key);
    const label =
      sanitized.length === 0 ? "field" : truncateDisplay(sanitized, MAX_OUTPUT_FIELD_LABEL_LENGTH);
    if (labels.has(label) || (split.logs !== undefined && label === "Logs")) return undefined;
    labels.add(label);
    fields.push({ label, body: stripTerminalControls(field) });
  }
  if (split.logs !== undefined)
    fields.push({ label: "Logs", body: codeModeOutputText(split.logs) });
  return fields;
}
