import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type { ExpandedLine } from "pi-code-previews";
import { STDERR_LABEL } from "../tools/log-page.ts";

/**
 * One line of combined task output for display. The model reads stderr lines with their
 * `[stderr] ` label; the user sees them in the error tone instead, as the suite shows stderr.
 */
export const taskOutputLine = (line: string): ExpandedLine =>
  Fn.pipe(line, Str.startsWith(STDERR_LABEL))
    ? { text: Fn.pipe(line, Str.slice(STDERR_LABEL.length)), tone: "error" }
    : line;

/** {@link taskOutputLine}, styled for rows drawn as text. */
export const styledTaskOutputLine = (line: string, theme: Pick<Theme, "fg">): string => {
  const output = taskOutputLine(line);
  return Predicate.isString(output)
    ? theme.fg("toolOutput", output)
    : theme.fg(output.tone, output.text);
};
