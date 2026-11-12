import * as Str from "effect/String";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripTerminalControls } from "pi-cosmic-core/security";

/** The widest value a heading may carry as a fact, in terminal columns. */
export const HEADING_VALUE_COLUMNS = 24;

/**
 * The value itself when it is short enough to be a heading fact, such as a lone answer (`red`):
 * one line without control characters or the `·` that separates facts, at most {@link HEADING_VALUE_COLUMNS} columns
 * once trimmed. Anything longer, or on several lines, stays behind expansion, so a producer moves
 * a value into its heading only when this returns it.
 */
export function headingValue(text: string): string | undefined {
  const value = Str.trim(stripTerminalControls(text));
  if (!Str.isNonEmpty(value) || /[\p{Cc}\u2028\u2029·]/u.test(value)) return undefined;
  return visibleWidth(value) <= HEADING_VALUE_COLUMNS ? value : undefined;
}
