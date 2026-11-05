import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { stripTerminalControls } from "pi-cosmic-core/security";

// A heading's tag: two or more blank columns, then `▸` and an optional label, ending the row.
const HEADING_TAG = /\s{2,}▸(?: (?<label>[^▸]+))?$/u;

/**
 * The tag that ends a drawn row: its label, `""` for a bare `▸`, or undefined when the row has
 * none. Rows that start with `▸` are stand-ins, not tags.
 */
export function expansionTag(row: string): string | undefined {
  const text = Str.trimEnd(stripTerminalControls(row));
  if (Str.startsWith("▸")(Str.trim(text))) return undefined;
  const match = HEADING_TAG.exec(text);
  return match ? Str.trim(match.groups?.["label"] ?? "") : undefined;
}

/**
 * Every place drawn rows offer expansion, as the label each names (`""` for a bare `▸`): a
 * heading's tag, or a `▸ label` row such as a clipped body's stand-in.
 */
export function expansionOffers(rows: readonly string[]): string[] {
  const lines: string[] = Arr.flatMap(rows, (row) => Str.split(row, "\n"));
  return Arr.flatMap(lines, (row): string[] => {
    const text = Str.trim(stripTerminalControls(row));
    if (Str.startsWith("▸ ")(text)) return [Str.trim(Str.slice(2)(text))];
    const tag = expansionTag(row);
    return tag === undefined ? [] : [tag];
  });
}
