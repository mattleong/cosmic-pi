import { parse } from "acorn";
import { stripTerminalControls } from "pi-cosmic-core";
import { CODE_MODE_INTEGER_BOUNDS } from "../config/schema.ts";
import { truncateDisplay } from "../tools/format.ts";

const MAX_PARSE_BYTES = 32 * 1024;
const displaySource = (source: string): string =>
  truncateDisplay(stripTerminalControls(source), CODE_MODE_INTEGER_BOUNDS.maxSourceBytes.maximum);

/** Separate parsed top-level statements without rewriting tokens or executing the program. */
export function formatCodeModeProgram(source: string): string {
  if (source.length > MAX_PARSE_BYTES || new TextEncoder().encode(source).length > MAX_PARSE_BYTES)
    return displaySource(source);
  try {
    const program = parse(source, {
      ecmaVersion: "latest",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
    const parts: string[] = [];
    let cursor = 0;
    for (let index = 1; index < program.body.length; index += 1) {
      const previous = program.body[index - 1]!;
      const next = program.body[index]!;
      // An existing line break already separates these statements. Insert only at a parsed
      // statement boundary, never inside a comment, literal, or ASI-sensitive expression.
      const gap = source.slice(previous.end, next.start);
      if (/[\n\r\u2028\u2029]/u.test(gap)) continue;
      parts.push(source.slice(cursor, next.start), "\n");
      cursor = next.start;
    }
    parts.push(source.slice(cursor));
    return displaySource(parts.join(""));
  } catch {
    return displaySource(source);
  }
}
