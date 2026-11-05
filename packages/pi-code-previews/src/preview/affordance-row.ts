import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { stripTerminalControls } from "pi-cosmic-core/security";
import { toolExpandHint } from "pi-cosmic-ui/tool";

/** Whether a drawn row is an expansion affordance, `▸ label · C-o Expand`, even when clipped. */
export function isAffordanceRow(row: string): boolean {
  const text = Str.trim(stripTerminalControls(row));
  if (!Str.startsWith("▸ ")(text)) return false;
  return Str.includes(toolExpandHint())(text) || Str.endsWith("…")(text);
}

/** Whether drawn rows already offer expansion, so the shell doesn't add a second affordance. */
export const showsAffordance = (rows: readonly string[]): boolean =>
  Arr.some(rows, isAffordanceRow);
