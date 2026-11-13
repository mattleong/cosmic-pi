import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Fn from "effect/Function";
import { stripTerminalControls } from "pi-cosmic-core/security";

const ESC = "\u001b";
const STYLING = `${ESC}\\[[0-9;:]*m`;
// Leading blank columns and styling, then a `▸` styled apart from its label, as
// `renderExpansionAffordance` draws it. Output text can't match: Pi escapes its control characters.
const STYLED_AFFORDANCE = new RegExp(`^(?:\\s|${STYLING})*${STYLING}▸${STYLING}`, "u");

/**
 * Whether a drawn row is an expansion affordance, such as `▸ 7 more lines`, even when clipped: its
 * text starts with `▸ ` and its `▸` is styled apart from the label. Rows drawn without any styling
 * can't show that, so there the text alone decides.
 */
export function isAffordanceRow(row: string): boolean {
  const text = Str.trim(stripTerminalControls(row));
  if (
    !Fn.pipe(text, Str.startsWith("▸ ")) ||
    !Fn.pipe(text, Str.slice(2), Str.trim, Str.isNonEmpty)
  )
    return false;
  return !Fn.pipe(row, Str.includes(ESC)) || STYLED_AFFORDANCE.test(row);
}

/** Whether drawn rows already offer expansion, so the shell doesn't add a second affordance. */
export const showsAffordance = (rows: readonly string[]): boolean =>
  Arr.some(rows, isAffordanceRow);
